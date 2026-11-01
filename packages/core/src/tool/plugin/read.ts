import { createHash } from "crypto"
export * as ReadTool from "./read.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { basename, dirname, join } from "path"
import { ToolFailure } from "@opencode/ai/effect"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { Location } from "../../location.js"
import { FileAccess } from "../../file-access.js"
import { SessionInstructions } from "../../session/instructions.js"
import { AbsolutePath } from "../../schema.js"
import { ReadToolFileSystem } from "../read-filesystem.js"
import { Environment } from "../../environment/index.js"
import { Tool } from "../../tool.js"

export const name = "read"
const FILENAME = "AGENTS.md"

const BatchItemStruct = Schema.Struct({
  filePath: Schema.optional(Schema.String).annotate({ description: "File or directory to read" }),
  path: Schema.optional(Schema.String).annotate({ description: "File or directory to read (alias for filePath)" }),
  offset: ReadToolFileSystem.PageInput.fields.offset.annotate({
    description: "The line or directory entry to start reading from (1-based)",
  }),
  limit: ReadToolFileSystem.PageInput.fields.limit.annotate({
    description: "The maximum number of lines or directory entries to read",
  }),
  force: Schema.optional(Schema.Boolean).annotate({
    description: "Bypass duplicate-slice session deduplication cache (default: false)",
  }),
})

const BatchItem = Schema.Union([
  Schema.String.annotate({ description: "Path to file or range, e.g. 'src/index.ts' or 'src/index.ts:1-50'" }),
  BatchItemStruct,
])

export const Input = Schema.Struct({
  path: Schema.optional(Schema.String).annotate({ description: "File or directory to read" }),
  filePath: Schema.optional(Schema.String).annotate({ description: "File or directory to read (alias for path)" }),
  offset: ReadToolFileSystem.PageInput.fields.offset.annotate({
    description: "The line or directory entry to start reading from (1-based)",
  }),
  limit: ReadToolFileSystem.PageInput.fields.limit.annotate({
    description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
  }),
  lineNumbers: Schema.optional(Schema.Boolean).annotate({
    description: "Prefix each line with its 1-based line number (default: false)",
  }),
  compact: Schema.optional(Schema.Boolean).annotate({
    description:
      "Apply lossless compaction by stripping blank lines, css whitespace/comments, and long svg paths (default: false)",
  }),
  force: Schema.optional(Schema.Boolean).annotate({
    description: "Bypass duplicate-slice session deduplication cache (default: false)",
  }),
  batch: Schema.optional(Schema.Array(BatchItem)).annotate({
    description: "Batch of files or directories to read concurrently",
  }),
})

const SingleOutput = Schema.Union([
  ReadToolFileSystem.FileContent,
  ReadToolFileSystem.TextPage,
  ReadToolFileSystem.ListPage,
])
const BatchItemOutput = Schema.Struct({
  path: Schema.String,
  output: SingleOutput,
})
export const Output = Schema.Union([SingleOutput, Schema.Array(BatchItemOutput)])

class SessionReadDedupCache {
  private sessions = new Map<string, Map<string, string>>()

  get(sessionID: string, key: string): string | undefined {
    const sessionMap = this.sessions.get(sessionID)
    if (!sessionMap) return undefined
    const val = sessionMap.get(key)
    if (val !== undefined) {
      sessionMap.delete(key)
      sessionMap.set(key, val)
    }
    return val
  }

  set(sessionID: string, key: string, hash: string): void {
    let sessionMap = this.sessions.get(sessionID)
    if (!sessionMap) {
      if (this.sessions.size >= 64) {
        const oldestSession = this.sessions.keys().next().value
        if (oldestSession) this.sessions.delete(oldestSession)
      }
      sessionMap = new Map<string, string>()
      this.sessions.set(sessionID, sessionMap)
    } else {
      this.sessions.delete(sessionID)
      this.sessions.set(sessionID, sessionMap)
    }
    if (sessionMap.size >= 256) {
      const oldestKey = sessionMap.keys().next().value
      if (oldestKey) sessionMap.delete(oldestKey)
    }
    sessionMap.set(key, hash)
  }

  clear(): void {
    this.sessions.clear()
  }
}

export const sessionReadDedupCache = new SessionReadDedupCache()

export const Plugin = {
  id: "opencode.tool.read",
  effect: Effect.fn("ReadTool.Plugin")(function* (ctx: Context) {
    const reader = yield* ReadToolFileSystem.Service
    const access = yield* FileAccess.Service
    const sessionInstructions = yield* SessionInstructions.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description:
            "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Use batch to read multiple files or ranges concurrently. Line numbers are omitted by default; set lineNumbers: true to include them. Set compact: true for lossless compaction of whitespace, comments, and long SVG paths.",
          input: Input,
          output: Output,
          execute: (input, context) => {
            return Effect.gen(function* () {
              const executeSingle = (targetPath: string, offset?: number, limit?: number) =>
                Effect.gen(function* () {
                  const read = (target: FileAccess.Target) =>
                    reader.read(target.absolute, target.resource, {
                      offset,
                      limit,
                    })

                  const requested = yield* access.authorizeRead(targetPath, context)
                  const result = yield* read(requested).pipe(
                    Effect.map((content) => ({ content, target: requested, path: targetPath })),
                    Effect.catchIf(
                      (error) => error instanceof Environment.NotFound,
                      () =>
                        Effect.gen(function* () {
                          const alternate = yield* alternatePath(requested.absolute).pipe(
                            Effect.orElseSucceed(() => undefined),
                          )
                          if (!alternate) return yield* missing(targetPath, requested.absolute)
                          const target = yield* access.authorizeRead(alternate, context, { siblingOf: requested })
                          const content = yield* read(target).pipe(
                            Effect.catchIf(
                              (error) => error instanceof Environment.NotFound,
                              () => missing(targetPath, requested.absolute),
                            ),
                          )
                          if (content.type === "list-page") return yield* missing(targetPath, requested.absolute)
                          return {
                            content,
                            target,
                            path: join(dirname(targetPath), basename(alternate)),
                          }
                        }),
                    ),
                  )

                  // After a successful read, discover nearby AGENTS.md walking up to the Location
                  // root exclusive and inject them as durable synthetic instructions. For a
                  // directory listing the walk starts at the directory itself (so its own AGENTS.md
                  // is discovered); for a file it starts at the file's dirname. External reads are
                  // skipped, and discovery failures never fail the read.
                  yield* Effect.gen(function* () {
                    if (result.target.externalDirectory !== undefined) return
                    const resolved = yield* fs.resolve(result.target.absolute)
                    const root = yield* fs.resolve(location.directory)
                    // The Location and its ancestors are already supplied by initial instructions,
                    // even when an upward walk from elsewhere in the project cannot reach root.
                    const discovered = yield* fs.up({
                      targets: [FILENAME],
                      start: result.content.type === "list-page" ? resolved : dirname(resolved),
                      stop: root,
                      type: "file",
                    })
                    const candidates = (yield* Effect.forEach(discovered, fs.resolve)).filter(
                      (file) => !FSUtil.contains(dirname(file), root) && file !== resolved,
                    )
                    if (candidates.length === 0) return
                    yield* sessionInstructions.load({ sessionID: context.sessionID, paths: candidates })
                  }).pipe(
                    Effect.catch(() => Effect.void),
                    Effect.catchDefect(() => Effect.void),
                  )
                  return { output: result.content, path: result.path, offset, target: result.target }
                })

              const parseBatchItem = (item: typeof BatchItem.Type) => {
                if (typeof item === "string") {
                  const match = /^(.+):(\d+)-(\d+)$/.exec(item)
                  if (match) {
                    const offset = parseInt(match[2], 10)
                    const end = parseInt(match[3], 10)
                    return {
                      path: match[1],
                      offset,
                      limit: end >= offset ? end - offset + 1 : undefined,
                    }
                  }
                  return { path: item, offset: undefined, limit: undefined }
                }
                const itemPath = item.filePath ?? item.path
                if (!itemPath) throw new Error("batch item missing filePath or path")
                return { path: itemPath, offset: item.offset, limit: item.limit, force: item.force }
              }

              if (input.batch && input.batch.length > 0) {
                const items = input.batch.map(parseBatchItem)
                const results = yield* Effect.forEach(
                  items,
                  (item) => executeSingle(item.path, item.offset, item.limit),
                  { concurrency: 8 },
                )
                const outputs = results.map((r) => ({ path: r.path, output: r.output }))
                const anyTruncated = results.some((r) => r.output.type !== "file" && r.output.truncated)
                const contents: Tool.Content[] = []
                for (const r of results) {
                  const itemObj = items.find((it) => it.path === r.path)
                  const mc = toModelContent(r.path, r.offset, r.output, {
                    lineNumbers: input.lineNumbers,
                    compact: input.compact,
                    sessionID: context.sessionID,
                    force: itemObj?.force ?? input.force,
                    resolvedPath: (r as any).target?.absolute,
                    limit: itemObj?.limit,
                  })
                  if (typeof mc === "string") {
                    contents.push({ type: "text", text: mc })
                  } else {
                    contents.push(...mc)
                  }
                }
                return {
                  output: outputs,
                  content: contents,
                  metadata: { truncated: anyTruncated },
                }
              }

              const targetPath = input.filePath ?? input.path
              if (!targetPath) {
                return yield* new ToolFailure({ message: "Either path or batch must be provided" })
              }

              const result = yield* executeSingle(targetPath, input.offset, input.limit)
              return {
                output: result.output,
                content: toModelContent(result.path, input.offset, result.output, {
                  lineNumbers: input.lineNumbers,
                  compact: input.compact,
                  sessionID: context.sessionID,
                  force: input.force,
                  resolvedPath: result.target?.absolute,
                  limit: input.limit,
                }),
                metadata: { truncated: result.output.type === "file" ? false : result.output.truncated },
              }
            }).pipe(
              Effect.mapError((error) => {
                if (error instanceof ToolFailure) return error
                const targetPath = input.filePath ?? input.path ?? "file"
                const message =
                  error instanceof ReadToolFileSystem.BinaryFileError ||
                  error instanceof ReadToolFileSystem.MediaIngestLimitError ||
                  error instanceof ReadToolFileSystem.OffsetOutOfRangeError ||
                  error instanceof ReadToolFileSystem.PathKindError
                    ? error.message
                    : `Unable to read ${targetPath}`
                return new ToolFailure({ message, error })
              }),
            )
          },
        }),
      )
      .pipe(Effect.orDie)

    const alternatePath = Effect.fn("ReadTool.alternatePath")(function* (absolute: string) {
      const canonical = (name: string) =>
        name
          .normalize("NFC")
          .replace(/[\u00a0\u202f]/g, " ")
          .replace(/[\u2018\u2019]/g, "'")
      const base = canonical(basename(absolute))
      const matches = (yield* reader.list(AbsolutePath.make(dirname(absolute)))).filter(
        (entry) => entry.type === "file" && canonical(entry.name) === base,
      )
      if (matches.length !== 1) return
      return join(dirname(absolute), matches[0].name)
    })

    const missing = Effect.fn("ReadTool.missing")(function* (input: string, absolute: string) {
      const base = basename(input).toLowerCase()
      const suggestions = yield* fs.readDirectory(dirname(absolute)).pipe(
        Effect.map((entries) =>
          entries
            .filter((entry) => {
              const candidate = entry.toLowerCase()
              return candidate.includes(base) || base.includes(candidate)
            })
            .map((entry) => join(dirname(input), entry))
            .slice(0, 3),
        ),
        Effect.orElseSucceed(() => [] as string[]),
      )
      const message =
        suggestions.length === 0
          ? `File not found: ${input}`
          : `File not found: ${input}\n\nDid you mean one of these?\n${suggestions.join("\n")}`
      return yield* new ToolFailure({ message })
    })
  }),
}

export interface ToModelContentOptions {
  readonly lineNumbers?: boolean
  readonly compact?: boolean
  readonly sessionID?: string
  readonly force?: boolean
  readonly resolvedPath?: string
  readonly limit?: number
}

export const toModelContent = (
  path: string,
  offset: number | undefined,
  output: typeof SingleOutput.Type,
  options?: ToModelContentOptions,
): string | readonly Tool.Content[] => {
  if (output.type === "file" && output.encoding === "base64")
    return [
      { type: "text", text: output.mime === "application/pdf" ? "PDF read successfully" : "Image read successfully" },
      {
        type: "file",
        uri: `data:${output.mime};base64,${output.content}`,
        mime: output.mime,
        name: path,
      },
    ] as const

  const lineNumbers = options?.lineNumbers ?? false
  const compact = options?.compact ?? false

  if (output.type === "list-page") {
    const start = offset || 1
    const content = [
      output.entries.length === 0
        ? `Read directory ${path}, 0 entries`
        : `Read directory ${path}, entries ${start}-${start + output.entries.length - 1}`,
    ]
    output.entries.forEach((entry) => {
      const line = compact ? entry.path.replace(/[ \t]+$/, "") : entry.path
      if (!compact || line.trim().length > 0) {
        content.push(line)
      }
    })
    if (output.truncated && output.next !== undefined)
      content.push(`[Output truncated. Continue reading with offset: ${output.next}]`)
    return content.join("\n")
  }

  const start = output.type === "text-page" ? output.offset : 1
  let text = output.type === "file" ? output.content.replace(/\n$/, "") : output.content

  if (compact) {
    if (path.endsWith(".css")) {
      // Strip /* ... */ block comments
      text = text.replace(/\/\*[\s\S]*?\*\//g, "")
      // Collapse multi-line { prop: val; } blocks cleanly without altering selectors, props, or values
      text = text.replace(/\{([^{}]+)\}/g, (_, inner) => {
        const decls = inner
          .split(";")
          .map((d: string) => d.trim())
          .filter((d: string) => d.length > 0)
          .join("; ")
        return decls.length > 0 ? `{ ${decls}; }` : "{ }"
      })
    }
    if (/\.(tsx|jsx|svg)$/i.test(path)) {
      // Collapse >60-character SVG path Bezier d attributes
      text = text.replace(/\bd=(["'])([^"']{61,})\1/g, (_, _q, dVal) => `d="[path:${dVal.length}c]"`)
      text = text.replace(/\bd=\{([`"'])([^`"']{61,})\1\}/g, (_, _q, dVal) => `d="[path:${dVal.length}c]"`)
    }
    // Strip blank/whitespace-only lines and trim trailing horizontal whitespace
    const lines = text
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/, ""))
      .filter((line) => line.trim().length > 0)
    const content = [
      lines.length === 0
        ? `Read file ${path}, 0 lines`
        : `Read file ${path}, lines ${start}-${start + lines.length - 1}`,
    ]
    lines.forEach((line, index) => {
      content.push(lineNumbers ? `${start + index}: ${line}` : line)
    })
    if (output.type === "text-page" && output.truncated && output.next !== undefined)
      content.push(`[Output truncated. Continue reading with offset: ${output.next}]`)
    return content.join("\n")
  }

  const rawLines = output.content === "" ? [] : text.split("\n")
  const lineCount = rawLines.length

  // Rule B (Unchanged Duplicate-Slice SHA-256 Dedup within Active Session)
  const sessionID = options?.sessionID
  const force = options?.force ?? false
  const dedupEnabled = process.env.AQUANOX_READ_DEDUP !== "0"
  if (
    dedupEnabled &&
    sessionID &&
    sessionID.length > 0 &&
    !force &&
    text.length > 4096 &&
    lineCount > 80
  ) {
    const filePathKey = options?.resolvedPath ?? path
    const cacheKey = `${filePathKey}:${offset ?? 0}:${options?.limit ?? -1}`
    const contentHash = createHash("sha256").update(text).digest("hex")
    const previousHash = sessionReadDedupCache.get(sessionID, cacheKey)
    if (previousHash === contentHash) {
      return [
        `Read file ${path}, lines ${start}-${start + lineCount - 1}`,
        `[Unchanged since earlier read in this session (sha256:${contentHash.slice(0, 12)}, ${lineCount} lines). Use the verbatim lines already in context above, or pass explicit offset & limit for a specific range.]`,
      ].join("\n")
    }
    sessionReadDedupCache.set(sessionID, cacheKey, contentHash)
  }

  // Rule C (Unbounded Large-File >350-Line Preview + Exported/Top-Level Symbol Directory)
  const isUnbounded = options?.limit === undefined && (offset === undefined || offset === 1)
  const isCodeFile = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|c|cpp|h|hpp|java|cs|rb|php|swift|kt|scala)$/i.test(path)
  if (isUnbounded && isCodeFile && lineCount > 350) {
    const headLines = rawLines.slice(0, 200)
    const content = [
      `Read file ${path}, lines 1-200 of ${lineCount}`,
    ]
    headLines.forEach((line, index) => {
      content.push(lineNumbers ? `${1 + index}: ${line}` : line)
    })
    content.push(
      `\n[Showing lines 1-200 of ${lineCount} lines. To read subsequent sections, pass offset: 201.]\n`,
      `Symbol Directory (lines 201-${lineCount}):`,
    )
    const symbolRegex =
      /^(\s*(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)|def|class|fn|pub\s+fn|struct|pub\s+struct)\s+[a-zA-Z0-9_$]+)/
    const symbolsFound: string[] = []
    for (let i = 200; i < rawLines.length; i++) {
      const line = rawLines[i]!
      const match = line.match(symbolRegex)
      if (match) {
        symbolsFound.push(`  L${i + 1}: ${match[1].trim()}`)
      }
    }
    if (symbolsFound.length > 0) {
      content.push(...symbolsFound)
    } else {
      content.push(`  [No top-level exported symbols detected in lines 201-${lineCount}]`)
    }
    content.push(`[Use offset and limit to view specific line ranges.]`)
    return content.join("\n")
  }

  const lines = rawLines
  const content = [
    lines.length === 0 ? `Read file ${path}, 0 lines` : `Read file ${path}, lines ${start}-${start + lines.length - 1}`,
  ]
  lines.forEach((line, index) => {
    content.push(lineNumbers ? `${start + index}: ${line}` : line)
  })
  if (output.type === "text-page" && output.truncated && output.next !== undefined)
    content.push(`[Output truncated. Continue reading with offset: ${output.next}]`)
  return content.join("\n")
}
