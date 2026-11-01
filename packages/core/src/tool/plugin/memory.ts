export * as MemoryTool from "./memory.js"

import crypto from "node:crypto"
import fsp from "node:fs/promises"
import path from "node:path"
import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Global } from "@opencode/util/global"
import { Effect, Schema } from "effect"
import { Permission } from "../../permission.js"
import { PositiveInt, optional } from "../../schema.js"

export const name = "memory"

export const Scope = Schema.Literals(["workspace", "global"])
export type Scope = typeof Scope.Type

export const Action = Schema.Literals(["search", "list", "read", "upsert", "delete"])
export type Action = typeof Action.Type

export const MemoryEntry = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  content: Schema.String,
  tags: Schema.Array(Schema.String),
  scope: Scope,
  directory: Schema.String.pipe(optional),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type MemoryEntry = typeof MemoryEntry.Type

export const MemorySummary = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  tags: Schema.Array(Schema.String),
  scope: Scope,
  updatedAt: Schema.Number,
  createdAt: Schema.Number,
  score: Schema.Number.pipe(optional),
})
export type MemorySummary = typeof MemorySummary.Type

export const Input = Schema.Struct({
  action: Action.annotate({
    description:
      "Operation to perform: 'upsert' creates or updates an institutional memory entry; 'search' ranks entries by relevance; 'list' shows stored keys and metadata; 'read' retrieves entry details; 'delete' removes an entry.",
  }).pipe(optional),
  key: Schema.String.annotate({
    description:
      "Unique key/slug for the memory entry (e.g. 'deploy-pipeline' or 'api-auth-spec'). Derived from title if omitted on upsert.",
  }).pipe(optional),
  title: Schema.String.annotate({
    description: "Concise human-readable title summarizing the memory entry.",
  }).pipe(optional),
  content: Schema.String.annotate({
    description: "Full body markdown content of the memory (max 16KB). Required for 'upsert'.",
  }).pipe(optional),
  tags: Schema.Array(Schema.String).annotate({
    description: "Categorical tags for filtering (e.g. ['database', 'migration', 'auth']).",
  }).pipe(optional),
  scope: Schema.Literals(["workspace", "global", "all"]).annotate({
    description:
      "Target storage scope: 'workspace' (tied to current directory/repo, default) or 'global' (cross-workspace). On search/list, 'all' searches across both.",
  }).pipe(optional),
  query: Schema.String.annotate({
    description: "Search query string when action is 'search'.",
  }).pipe(optional),
  tag: Schema.String.annotate({
    description: "Filter search/list results to entries containing this tag.",
  }).pipe(optional),
  limit: PositiveInt.annotate({
    description: "Maximum number of search or list results to return (defaults to 10).",
  }).pipe(optional),
})

export const Output = Schema.Struct({
  action: Action,
  entry: MemoryEntry.pipe(optional),
  entries: Schema.Array(MemorySummary).pipe(optional),
  key: Schema.String.pipe(optional),
  scope: Schema.String.pipe(optional),
})
export type Output = typeof Output.Type

export const description =
  "Persistent cross-conversation institutional memory. Store architectural decisions, project conventions, setup facts, or debugging insights using 'upsert'; search memories with BM25 term ranking using 'search'; browse entries with 'list'; read full details with 'read'; or clean up obsolete entries with 'delete'."

const MAX_STORE_ENTRIES = 500
const MAX_CONTENT_BYTES = 16 * 1024 // 16KB

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)

const tokenize = (text: string): string[] => {
  const matches = text.toLowerCase().match(/[a-z0-9_-]+/g)
  return matches ? matches.filter((w) => w.length > 1) : []
}

interface StoreData {
  entries: Record<string, MemoryEntry>
}

const loadStore = async (filePath: string): Promise<StoreData> => {
  try {
    const raw = await fsp.readFile(filePath, "utf-8")
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.entries === "object") return parsed as StoreData
    return { entries: {} }
  } catch {
    return { entries: {} }
  }
}

const saveStoreAtomic = async (filePath: string, data: StoreData): Promise<void> => {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${crypto.randomUUID()}.tmp`
  await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8")
  await fsp.rename(tmpPath, filePath)
}

const computeBM25Score = (queryTokens: string[], entry: MemoryEntry, corpus: MemoryEntry[]): number => {
  if (queryTokens.length === 0) return 0

  const keyTokens = tokenize(entry.key)
  const titleTokens = tokenize(entry.title)
  const tagTokens = entry.tags.flatMap(tokenize)
  const contentTokens = tokenize(entry.content)

  const docLength =
    keyTokens.length * 3 + titleTokens.length * 3 + tagTokens.length * 2 + contentTokens.length
  const avgDocLength = 50 // baseline average document length
  const k1 = 1.2
  const b = 0.75

  let score = 0
  const totalDocs = corpus.length

  for (const q of queryTokens) {
    // Term frequency in this entry with field weighting
    const tf =
      keyTokens.filter((t) => t === q).length * 3 +
      titleTokens.filter((t) => t === q).length * 3 +
      tagTokens.filter((t) => t === q).length * 2 +
      contentTokens.filter((t) => t === q).length

    if (tf === 0) continue

    // Document frequency
    const df = corpus.filter(
      (doc) =>
        doc.key.toLowerCase().includes(q) ||
        doc.title.toLowerCase().includes(q) ||
        doc.tags.some((t) => t.toLowerCase().includes(q)) ||
        doc.content.toLowerCase().includes(q),
    ).length

    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5))
    const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / avgDocLength)))
    score += idf * tfNorm
  }

  return score
}

export const Plugin = {
  id: "opencode.tool.memory",
  effect: Effect.fn("MemoryTool.Plugin")(function* (ctx: Context) {
    const global = yield* Global.Service
    const permissions = yield* Permission.Service

    const memoryDir = path.join(global.data, "memory")
    const workspaceHash = crypto
      .createHash("sha256")
      .update(String(ctx.location.directory))
      .digest("hex")
      .slice(0, 16)
    const workspaceFile = path.join(memoryDir, `workspace_${workspaceHash}.json`)
    const globalFile = path.join(memoryDir, "global.json")

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const action: Action = input.action ?? (input.query ? "search" : input.key ? "read" : "list")

              yield* permissions
                .assert({
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: {
                    type: "tool",
                    messageID: context.messageID,
                    id: context.id,
                  },
                  action: name,
                  resources: [input.key ?? action],
                })
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Permission denied for ${name}`, error }),
                  ),
                )

              const targetScope: "workspace" | "global" = input.scope === "global" ? "global" : "workspace"

              if (action === "upsert") {
                const title = input.title?.trim()
                const rawKey = input.key?.trim() || (title ? slugify(title) : undefined)
                if (!rawKey || rawKey.length === 0) {
                  return yield* new ToolFailure({
                    message: "Action 'upsert' requires either a 'key' or a 'title' to derive a key.",
                  })
                }
                const content = input.content
                if (content === undefined || content.trim().length === 0) {
                  return yield* new ToolFailure({
                    message: "Action 'upsert' requires a non-empty 'content' string.",
                  })
                }
                if (Buffer.byteLength(content, "utf-8") > MAX_CONTENT_BYTES) {
                  return yield* new ToolFailure({
                    message: `Memory entry content exceeds maximum size of 16KB (${Buffer.byteLength(content, "utf-8")} bytes).`,
                  })
                }

                const storeFile = targetScope === "global" ? globalFile : workspaceFile
                const store = yield* Effect.promise(() => loadStore(storeFile))

                const existing = store.entries[rawKey]
                if (!existing && Object.keys(store.entries).length >= MAX_STORE_ENTRIES) {
                  return yield* new ToolFailure({
                    message: `Memory store limit reached (${MAX_STORE_ENTRIES} entries) for scope '${targetScope}'. Delete obsolete entries before adding new ones.`,
                  })
                }

                const now = Date.now()
                const entry: MemoryEntry = {
                  key: rawKey,
                  title: title || existing?.title || rawKey,
                  content: content.trim(),
                  tags: Array.isArray(input.tags)
                    ? input.tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0)
                    : existing?.tags ?? [],
                  scope: targetScope,
                  ...(targetScope === "workspace" ? { directory: String(ctx.location.directory) } : {}),
                  createdAt: existing?.createdAt ?? now,
                  updatedAt: now,
                }

                store.entries[rawKey] = entry
                yield* Effect.promise(() => saveStoreAtomic(storeFile, store))

                const message = existing
                  ? `Updated memory entry "${rawKey}" [${targetScope}].`
                  : `Created memory entry "${rawKey}" [${targetScope}].`

                return {
                  content: `${message}\nTitle: ${entry.title}\nTags: [${entry.tags.join(", ")}]`,
                  output: {
                    action: "upsert" as const,
                    entry,
                    key: rawKey,
                    scope: targetScope,
                  },
                  metadata: { key: rawKey, scope: targetScope },
                }
              }

              if (action === "read") {
                const rawKey = input.key?.trim()
                if (!rawKey || rawKey.length === 0) {
                  return yield* new ToolFailure({ message: "Action 'read' requires 'key'." })
                }

                let found: MemoryEntry | undefined
                if (input.scope === "global") {
                  const globalStore = yield* Effect.promise(() => loadStore(globalFile))
                  found = globalStore.entries[rawKey]
                } else if (input.scope === "workspace") {
                  const wsStore = yield* Effect.promise(() => loadStore(workspaceFile))
                  found = wsStore.entries[rawKey]
                } else {
                  // Check workspace first, then global
                  const wsStore = yield* Effect.promise(() => loadStore(workspaceFile))
                  found = wsStore.entries[rawKey]
                  if (!found) {
                    const globalStore = yield* Effect.promise(() => loadStore(globalFile))
                    found = globalStore.entries[rawKey]
                  }
                }

                if (!found) {
                  return yield* new ToolFailure({
                    message: `Memory entry "${rawKey}" not found. Call memory with action="list" or action="search" to locate available memories.`,
                  })
                }

                const lines = [
                  `# Memory: ${found.title} (${found.key})`,
                  `Scope: ${found.scope} | Updated: ${new Date(found.updatedAt).toISOString()}`,
                  `Tags: [${found.tags.join(", ")}]`,
                  "",
                  found.content,
                ]

                return {
                  content: lines.join("\n"),
                  output: {
                    action: "read" as const,
                    entry: found,
                    key: rawKey,
                    scope: found.scope,
                  },
                  metadata: { key: rawKey, scope: found.scope },
                }
              }

              if (action === "delete") {
                const rawKey = input.key?.trim()
                if (!rawKey || rawKey.length === 0) {
                  return yield* new ToolFailure({ message: "Action 'delete' requires 'key'." })
                }

                let deletedScope: Scope | undefined

                if (input.scope === "global" || !input.scope) {
                  const globalStore = yield* Effect.promise(() => loadStore(globalFile))
                  if (globalStore.entries[rawKey]) {
                    delete globalStore.entries[rawKey]
                    yield* Effect.promise(() => saveStoreAtomic(globalFile, globalStore))
                    deletedScope = "global"
                  }
                }

                if (!deletedScope && (input.scope === "workspace" || !input.scope)) {
                  const wsStore = yield* Effect.promise(() => loadStore(workspaceFile))
                  if (wsStore.entries[rawKey]) {
                    delete wsStore.entries[rawKey]
                    yield* Effect.promise(() => saveStoreAtomic(workspaceFile, wsStore))
                    deletedScope = "workspace"
                  }
                }

                if (!deletedScope) {
                  return yield* new ToolFailure({
                    message: `Memory entry "${rawKey}" not found to delete.`,
                  })
                }

                return {
                  content: `Deleted memory entry "${rawKey}" [${deletedScope}].`,
                  output: {
                    action: "delete" as const,
                    key: rawKey,
                    scope: deletedScope,
                  },
                  metadata: { key: rawKey, scope: deletedScope },
                }
              }

              if (action === "list") {
                const searchScope = input.scope ?? "workspace"
                const entries: MemoryEntry[] = []

                if (searchScope === "workspace" || searchScope === "all") {
                  const wsStore = yield* Effect.promise(() => loadStore(workspaceFile))
                  entries.push(...Object.values(wsStore.entries))
                }
                if (searchScope === "global" || searchScope === "all") {
                  const globalStore = yield* Effect.promise(() => loadStore(globalFile))
                  entries.push(...Object.values(globalStore.entries))
                }

                let filtered = entries
                if (input.tag) {
                  const targetTag = input.tag.trim().toLowerCase()
                  filtered = filtered.filter((e) => e.tags.includes(targetTag))
                }

                filtered.sort((a, b) => b.updatedAt - a.updatedAt)
                const limit = input.limit ?? 25
                const sliced = filtered.slice(0, limit)

                const summaries: MemorySummary[] = sliced.map((e) => ({
                  key: e.key,
                  title: e.title,
                  tags: e.tags,
                  scope: e.scope,
                  updatedAt: e.updatedAt,
                  createdAt: e.createdAt,
                }))

                const lines = [
                  `Stored Memories (${summaries.length}/${filtered.length}):`,
                  ...(summaries.length === 0
                    ? ["- (no memories stored yet)"]
                    : summaries.map(
                        (s) =>
                          `- [${s.scope}] ${s.key}: "${s.title}" (tags: [${s.tags.join(", ")}], updated: ${new Date(s.updatedAt).toISOString().slice(0, 10)})`,
                      )),
                ]

                return {
                  content: lines.join("\n"),
                  output: {
                    action: "list" as const,
                    entries: summaries,
                  },
                  metadata: { count: summaries.length, total: filtered.length },
                }
              }

              if (action === "search") {
                const rawQuery = input.query?.trim()
                if (!rawQuery || rawQuery.length === 0) {
                  return yield* new ToolFailure({ message: "Action 'search' requires 'query'." })
                }

                const searchScope = input.scope ?? "all"
                const corpus: MemoryEntry[] = []

                if (searchScope === "workspace" || searchScope === "all") {
                  const wsStore = yield* Effect.promise(() => loadStore(workspaceFile))
                  corpus.push(...Object.values(wsStore.entries))
                }
                if (searchScope === "global" || searchScope === "all") {
                  const globalStore = yield* Effect.promise(() => loadStore(globalFile))
                  corpus.push(...Object.values(globalStore.entries))
                }

                let candidates = corpus
                if (input.tag) {
                  const targetTag = input.tag.trim().toLowerCase()
                  candidates = candidates.filter((e) => e.tags.includes(targetTag))
                }

                const queryTokens = tokenize(rawQuery)
                const scored: Array<MemorySummary & { score: number; contentSnippet: string }> = []

                for (const entry of candidates) {
                  const score = computeBM25Score(queryTokens, entry, corpus)
                  if (score > 0 || queryTokens.length === 0) {
                    const snippet =
                      entry.content.length > 180 ? `${entry.content.slice(0, 177)}...` : entry.content
                    scored.push({
                      key: entry.key,
                      title: entry.title,
                      tags: entry.tags,
                      scope: entry.scope,
                      updatedAt: entry.updatedAt,
                      createdAt: entry.createdAt,
                      score: Math.round(score * 100) / 100,
                      contentSnippet: snippet,
                    })
                  }
                }

                scored.sort((a, b) => b.score - a.score)
                const limit = input.limit ?? 10
                const results = scored.slice(0, limit)

                const lines = [
                  `Search Results for "${rawQuery}" (${results.length} matches):`,
                  ...(results.length === 0
                    ? ["- (no matching memories found)"]
                    : results.map(
                        (r) =>
                          `- [${r.scope}] ${r.key} (score: ${r.score}): "${r.title}"\n  Tags: [${r.tags.join(", ")}]\n  Preview: ${r.contentSnippet}`,
                      )),
                ]

                return {
                  content: lines.join("\n"),
                  output: {
                    action: "search" as const,
                    entries: results.map((r) => ({
                      key: r.key,
                      title: r.title,
                      tags: r.tags,
                      scope: r.scope,
                      updatedAt: r.updatedAt,
                      createdAt: r.createdAt,
                      score: r.score,
                    })),
                  },
                  metadata: { count: results.length },
                }
              }

              return yield* new ToolFailure({ message: `Unsupported action: ${action}` })
            }),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
