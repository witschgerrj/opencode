import { execSync } from "node:child_process"
import * as fs from "node:fs"
export * as SessionEpochPrefix from "./epoch-prefix.js"

import { ToolDefinition, type ToolDefinitionInput } from "@opencode/ai/effect"
import { structuredPatch } from "diff"
import { and, asc, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database.js"

type DatabaseService = Database.Interface["db"]
import { Instructions } from "../instructions/index.js"
import { Tool } from "../tool.js"
import { InstructionState } from "./instruction-state.js"
import type { SessionMessage } from "./message.js"
import type { SessionSchema } from "./schema.js"
import { type FrozenHookedToolsMap, SessionEpochPrefixTable, SessionTurnReminderTable } from "./sql.js"

export const MAX_INSTRUCTION_DELTA_CHARS = 12_288
const MAX_L1_CACHE_ENTRIES = 256

interface EpochPrefixState {
  readonly frozenInitial: string
  lastAppliedInitial: string
  readonly frozenFirstReminder: string
  readonly initialIsoDate: string
  lastAppliedIsoDate: string
  readonly frozenTools: ReadonlyArray<ToolDefinitionInput>
  frozenHookedTools: FrozenHookedToolsMap
  lastAnnouncedNewTools: ReadonlyArray<string>
}

const epochPrefixCache = new Map<string, EpochPrefixState>()
const turnReminderCache = new Map<string, Map<SessionMessage.ID, string>>()

export function resetEpochCache(): void {
  epochPrefixCache.clear()
  turnReminderCache.clear()
}

function setBounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.set(key, value)
  if (map.size > MAX_L1_CACHE_ENTRIES) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
}

function formatDateIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function parseIsoFromDateValue(val: unknown): string {
  if (typeof val === "string") {
    const trimmed = val.trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
    const isoPrefix = /^(\d{4}-\d{2}-\d{2})T/.exec(trimmed)
    if (isoPrefix?.[1]) return isoPrefix[1]
    const d = new Date(trimmed)
    if (!isNaN(d.getTime())) return formatDateIso(d)
  }
  return formatDateIso(new Date())
}

function sortDeterministicJsonKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(sortDeterministicJsonKeys)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortDeterministicJsonKeys((obj as Record<string, unknown>)[key])
  }
  return sorted
}

export function getWorkspaceSummary(cwd: string = process.cwd()): string {
  if (process.env.NODE_ENV === "test" || process.env.BUN_TEST || process.env.VITEST) {
    return ""
  }
  try {
    const gitStatus = execSync("git status -sb", {
      cwd,
      timeout: 500,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()

    const entries = fs.readdirSync(cwd, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".git"))
      .slice(0, 40)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .join(", ")

    let summary = `<workspace_summary>\nGit status: ${gitStatus}\nWorkspace files: ${entries}\n</workspace_summary>`
    if (summary.length > 1200) {
      summary = summary.slice(0, 1196) + "\n..."
    }
    return summary
  } catch {
    return ""
  }
}

export function serializeToolDefinition(t: ToolDefinition): ToolDefinitionInput {
  return {
    description: t.description,
    name: t.name,
    inputSchema: sortDeterministicJsonKeys(structuredClone(t.inputSchema)) as any,
    ...(t.outputSchema === undefined ? {} : { outputSchema: structuredClone(t.outputSchema) }),
    ...(t.cache === undefined ? {} : { cache: structuredClone(t.cache) }),
    ...(t.metadata === undefined ? {} : { metadata: structuredClone(t.metadata) }),
    ...(t.native === undefined ? {} : { native: structuredClone(t.native) }),
  }
}

export function hydrateToolDefinition(input: ToolDefinitionInput): ToolDefinition {
  return ToolDefinition.make({
    description: input.description,
    name: input.name,
    inputSchema: structuredClone(input.inputSchema),
    ...(input.outputSchema === undefined ? {} : { outputSchema: structuredClone(input.outputSchema) }),
    ...(input.cache === undefined ? {} : { cache: structuredClone(input.cache) }),
    ...(input.metadata === undefined ? {} : { metadata: structuredClone(input.metadata) }),
    ...(input.native === undefined ? {} : { native: structuredClone(input.native) }),
  })
}

/**
 * Computes a deterministic, compact unified diff between `previousInitial` and `currentInitial`
 * suitable for an append-only tail `<system-reminder>` without mutating `<｜System｜>`.
 */
export function computeInstructionDelta(previousInitial: string, currentInitial: string): string {
  const prevNorm = previousInitial.replaceAll("\r\n", "\n").trim()
  const currNorm = currentInitial.replaceAll("\r\n", "\n").trim()
  if (prevNorm === currNorm) return ""

  const patch = structuredPatch("instructions", "instructions", prevNorm, currNorm, "", "", { context: 1 })
  const lines: string[] = []
  let hasMeaningfulChange = false

  for (const hunk of patch.hunks) {
    const hunkHasNonBlankChange = hunk.lines.some((line) => {
      if (!line.startsWith("+") && !line.startsWith("-")) return false
      return line.slice(1).trim().length > 0
    })
    if (!hunkHasNonBlankChange) continue
    hasMeaningfulChange = true
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    for (const line of hunk.lines) {
      if (line === "\\ No newline at end of file") continue
      const prefix = line[0]
      const body = line.slice(1)
      if (prefix === "+" || prefix === "-" || prefix === " ") {
        lines.push(`${prefix} ${body}`)
      }
    }
  }

  if (!hasMeaningfulChange || lines.length === 0) return ""

  const header = "[Workspace instructions updated since session start]\n"
  const suffix = "\n... [instruction delta truncated; run /compact to refresh full baseline]"
  const full = `${header}${lines.join("\n")}`
  if (full.length <= MAX_INSTRUCTION_DELTA_CHARS) return full
  const budget = Math.max(0, MAX_INSTRUCTION_DELTA_CHARS - suffix.length)
  return `${full.slice(0, budget)}${suffix}`
}

function wrapEpochTools(
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  epochKey: string,
  epoch: EpochPrefixState,
  liveTools: Tool.Snapshot,
): Tool.Snapshot {
  const frozenDefinitions = epoch.frozenTools.map(hydrateToolDefinition)
  const frozenToolNames = new Set(epoch.frozenTools.map((t) => t.name))
  const liveToolNames = new Set(liveTools.definitions.map((t) => t.name))

  return {
    ...(liveTools.codeModeCatalog === undefined ? {} : { codeModeCatalog: liveTools.codeModeCatalog }),
    definitions: frozenDefinitions,
    pinHookedDefinitions: Effect.fnUntraced(function* (
      scopeKey: string,
      computed: ReadonlyMap<string, ToolDefinition>,
    ) {
      const existing = epoch.frozenHookedTools[scopeKey]
      if (existing) {
        return new Map(existing.map(([advName, def]) => [advName, hydrateToolDefinition(def)] as const))
      }
      const serialized = Array.from(computed, ([advName, def]) => [advName, serializeToolDefinition(def)] as const)
      const nextMap: FrozenHookedToolsMap = {
        ...epoch.frozenHookedTools,
        [scopeKey]: serialized,
      }
      epoch.frozenHookedTools = nextMap
      if (epochKey !== "epoch0") {
        yield* db
          .update(SessionEpochPrefixTable)
          .set({
            frozen_hooked_tools_json: nextMap,
            time_updated: Date.now(),
          })
          .where(
            and(eq(SessionEpochPrefixTable.session_id, sessionID), eq(SessionEpochPrefixTable.epoch_key, epochKey)),
          )
          .run()
          .pipe(Effect.orDie)
      }
      return new Map(serialized.map(([advName, def]) => [advName, hydrateToolDefinition(def)] as const))
    }),
    execute: (input) => {
      const requested = input.definitions?.get(input.call.name)
      const resolvedName = requested?.name ?? input.call.name
      if (frozenToolNames.has(resolvedName) && !liveToolNames.has(resolvedName)) {
        return Effect.fail(
          new Tool.Error({
            message: `Permission denied: tool "${resolvedName}" is no longer permitted in this session.`,
          }),
        )
      }
      if (!frozenToolNames.has(resolvedName) && liveToolNames.has(resolvedName)) {
        return Effect.fail(
          new Tool.Error({
            message: `Tool "${resolvedName}" is not active in the current session epoch; run /compact to enable new tools.`,
          }),
        )
      }
      return liveTools.execute(input)
    },
  }
}

export const resolveEpochContext = Effect.fn("SessionEpochPrefix.resolveEpochContext")(function* (input: {
  readonly db: DatabaseService
  readonly sessionID: SessionSchema.ID
  readonly session?: SessionSchema.Info
  readonly instructions: Instructions.List
  readonly volatileInstructions?: Instructions.List
  readonly tools: Tool.Snapshot
  readonly history: {
    readonly initial: string
    readonly entries: ReadonlyArray<{ readonly seq: number; readonly message: SessionMessage.Info }>
  }
}) {
  const { db, sessionID, instructions, volatileInstructions, tools, history } = input

  // Anchor the epoch to a completed compaction entry at index 0 when present, otherwise the first user/synthetic entry.
  const firstEntry = history.entries[0]
  const compactionEntry =
    firstEntry?.message.type === "compaction" && firstEntry.message.status === "completed" ? firstEntry : undefined

  const firstUserIndex = history.entries.findIndex((e) => e.message.type === "user" || e.message.type === "synthetic")
  const firstUserEntry = firstUserIndex >= 0 ? history.entries[firstUserIndex] : undefined
  const anchorId = compactionEntry?.message.id ?? firstUserEntry?.message.id ?? "epoch0"
  const epochStart = anchorId === "epoch0" ? 0 : yield* InstructionState.epochStartSeq(db, sessionID)
  const epochKey = anchorId === "epoch0" ? "epoch0" : `${epochStart}:${anchorId}`
  const cacheKey = `${sessionID}:${epochKey}`

  let currentObservedDate: unknown = undefined
  const volatileValues: Record<string, Schema.Json> = {}
  if (volatileInstructions && volatileInstructions.length > 0) {
    const observed = yield* Instructions.read(volatileInstructions)
    for (const entry of observed) {
      if (entry.value !== Instructions.unavailable && entry.value !== Instructions.removed) {
        volatileValues[entry.key] = entry.value
        if (entry.key === "core/date") currentObservedDate = entry.value
      }
    }
  }
  const liveIsoDate = currentObservedDate !== undefined ? parseIsoFromDateValue(currentObservedDate) : ""

  let epoch = epochPrefixCache.get(cacheKey)
  if (!epoch && epochKey !== "epoch0") {
    const stored = yield* db
      .select()
      .from(SessionEpochPrefixTable)
      .where(and(eq(SessionEpochPrefixTable.session_id, sessionID), eq(SessionEpochPrefixTable.epoch_key, epochKey)))
      .get()
      .pipe(Effect.orDie)
    if (stored) {
      epoch = {
        frozenInitial: stored.frozen_initial,
        lastAppliedInitial: stored.last_applied_initial,
        frozenFirstReminder: stored.frozen_first_reminder,
        initialIsoDate: stored.initial_iso_date,
        lastAppliedIsoDate: stored.last_applied_iso_date,
        frozenTools: stored.frozen_tools_json.map((t) => structuredClone(t)),
        frozenHookedTools: structuredClone(stored.frozen_hooked_tools_json),
        lastAnnouncedNewTools: [...stored.last_announced_new_tools],
      }
      setBounded(epochPrefixCache, cacheKey, epoch)
    }
  }

  let createdEpochInThisCall = false
  if (!epoch) {
    createdEpochInThisCall = true
    const { baselineRendered } = yield* InstructionState.renderEpochBaseline(
      db,
      sessionID,
      instructions,
      history.initial,
    )
    const frozenInitial = history.initial
    const isRootSession = !input.session || !input.session.parentID
    const isTurn1 = compactionEntry === undefined
    const workspaceSummary = isRootSession && isTurn1 ? getWorkspaceSummary() : ""
    const renderedVolatile =
      volatileInstructions && volatileInstructions.length > 0
        ? Instructions.renderInitial(volatileInstructions, volatileValues)
        : ""
    const reminderParts = [workspaceSummary, renderedVolatile].filter((p) => p.length > 0)
    const frozenFirstReminder = reminderParts.join("\n\n")
    const initialIsoDate =
      volatileInstructions && volatileInstructions.length > 0 && currentObservedDate !== undefined
        ? parseIsoFromDateValue(currentObservedDate)
        : ""
    const frozenTools = tools.definitions.map(serializeToolDefinition)

    epoch = {
      frozenInitial,
      lastAppliedInitial: baselineRendered,
      frozenFirstReminder,
      initialIsoDate,
      lastAppliedIsoDate: initialIsoDate,
      frozenTools,
      frozenHookedTools: {},
      lastAnnouncedNewTools: [],
    }

    if (epochKey !== "epoch0") {
      yield* db
        .insert(SessionEpochPrefixTable)
        .values({
          session_id: sessionID,
          epoch_key: epochKey,
          frozen_initial: epoch.frozenInitial,
          last_applied_initial: epoch.lastAppliedInitial,
          frozen_first_reminder: epoch.frozenFirstReminder,
          initial_iso_date: epoch.initialIsoDate,
          last_applied_iso_date: epoch.lastAppliedIsoDate,
          frozen_tools_json: epoch.frozenTools,
          frozen_hooked_tools_json: epoch.frozenHookedTools,
          last_announced_new_tools: epoch.lastAnnouncedNewTools,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    }
    setBounded(epochPrefixCache, cacheKey, epoch)
  }

  let turnReminders = turnReminderCache.get(cacheKey)
  if (!turnReminders) {
    turnReminders = new Map()
    if (epochKey !== "epoch0") {
      const rows = yield* db
        .select()
        .from(SessionTurnReminderTable)
        .where(
          and(eq(SessionTurnReminderTable.session_id, sessionID), eq(SessionTurnReminderTable.epoch_key, epochKey)),
        )
        .orderBy(asc(SessionTurnReminderTable.time_created))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        turnReminders.set(row.message_id, row.reminder_text)
      }
    }
    setBounded(turnReminderCache, cacheKey, turnReminders)
  }

  if (firstUserEntry && !turnReminders.has(firstUserEntry.message.id)) {
    turnReminders.set(firstUserEntry.message.id, "")
    if (epochKey !== "epoch0") {
      yield* db
        .insert(SessionTurnReminderTable)
        .values({
          session_id: sessionID,
          epoch_key: epochKey,
          message_id: firstUserEntry.message.id,
          reminder_text: "",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    }
  }

  // Identify the tail user/synthetic message (for Step-1-pinned append-only tail deltas on new turns)
  let lastUserIndex = -1
  for (let i = history.entries.length - 1; i >= 0; i--) {
    const t = history.entries[i]?.message.type
    if (t === "user" || t === "synthetic") {
      lastUserIndex = i
      break
    }
  }

  if (lastUserIndex > firstUserIndex && firstUserIndex >= 0) {
    const lastUserMsg = history.entries[lastUserIndex]!.message
    if (createdEpochInThisCall && !turnReminders.has(lastUserMsg.id)) {
      turnReminders.set(lastUserMsg.id, "")
      if (epochKey !== "epoch0") {
        yield* db
          .insert(SessionTurnReminderTable)
          .values({
            session_id: sessionID,
            epoch_key: epochKey,
            message_id: lastUserMsg.id,
            reminder_text: "",
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
      }
    } else if (!turnReminders.has(lastUserMsg.id)) {
      const systemReminderParts: string[] = []
      let dateRolloverPart = ""
      let epochDirty = false

      const { currentRendered, liveRendered } = yield* InstructionState.renderLiveAndCurrent(
        db,
        sessionID,
        instructions,
        history.initial,
      )

      if (liveRendered !== epoch.lastAppliedInitial) {
        const alreadyProjectedByInstructionState =
          liveRendered === currentRendered && history.initial === epoch.frozenInitial
        if (!alreadyProjectedByInstructionState) {
          const delta = computeInstructionDelta(epoch.lastAppliedInitial, liveRendered)
          if (delta.length > 0) systemReminderParts.push(delta)
        }
        epoch.lastAppliedInitial = liveRendered
        epochDirty = true
      }

      const frozenNames = new Set(epoch.frozenTools.map((t) => t.name))
      const announced = new Set(epoch.lastAnnouncedNewTools)
      const unannouncedNewTools = tools.definitions
        .map((t) => t.name)
        .filter((name) => !frozenNames.has(name) && !announced.has(name))
        .sort()
      if (unannouncedNewTools.length > 0) {
        systemReminderParts.push(`[New tools available after /compact: ${unannouncedNewTools.join(", ")}]`)
        epoch.lastAnnouncedNewTools = [...epoch.lastAnnouncedNewTools, ...unannouncedNewTools]
        epochDirty = true
      }

      if (epoch.lastAppliedIsoDate.length > 0 && liveIsoDate.length > 0 && liveIsoDate !== epoch.lastAppliedIsoDate) {
        const existingText = lastUserMsg.type === "user" || lastUserMsg.type === "synthetic" ? lastUserMsg.text : ""
        if (!existingText?.includes("[Date rollover:")) {
          dateRolloverPart = `[Date rollover: ${liveIsoDate}]`
        }
        epoch.lastAppliedIsoDate = liveIsoDate
        epochDirty = true
      }

      const pinnedReminderText =
        systemReminderParts.length > 0
          ? `<system-reminder>\n${[...(dateRolloverPart ? [dateRolloverPart] : []), ...systemReminderParts].join("\n\n")}\n</system-reminder>`
          : dateRolloverPart

      if (epochDirty && epochKey !== "epoch0") {
        yield* db
          .update(SessionEpochPrefixTable)
          .set({
            last_applied_initial: epoch.lastAppliedInitial,
            last_applied_iso_date: epoch.lastAppliedIsoDate,
            last_announced_new_tools: epoch.lastAnnouncedNewTools,
            time_updated: Date.now(),
          })
          .where(
            and(eq(SessionEpochPrefixTable.session_id, sessionID), eq(SessionEpochPrefixTable.epoch_key, epochKey)),
          )
          .run()
          .pipe(Effect.orDie)
      }

      turnReminders.set(lastUserMsg.id, pinnedReminderText)
      if (epochKey !== "epoch0") {
        yield* db
          .insert(SessionTurnReminderTable)
          .values({
            session_id: sessionID,
            epoch_key: epochKey,
            message_id: lastUserMsg.id,
            reminder_text: pinnedReminderText,
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
      }
    }
  }

  let injectedFirst = false
  const messages = history.entries.map((entry, index) => {
    const msg = entry.message
    if (!injectedFirst && (msg.type === "user" || msg.type === "synthetic")) {
      injectedFirst = true
      if (epoch.frozenFirstReminder.length > 0) {
        const reminderBlock = `<system-reminder>\n${epoch.frozenFirstReminder}\n</system-reminder>`
        return {
          ...msg,
          text: msg.text ? `${reminderBlock}\n\n${msg.text}` : reminderBlock,
        }
      }
      return msg
    }

    if (index > firstUserIndex && (msg.type === "user" || msg.type === "synthetic")) {
      const pinned = turnReminders.get(msg.id)
      if (pinned && pinned.length > 0) {
        return {
          ...msg,
          text: msg.text ? `${pinned}\n\n${msg.text}` : pinned,
        }
      }
    }

    return msg
  })

  return {
    initial: epoch.frozenInitial,
    messages,
    tools: wrapEpochTools(db, sessionID, epochKey, epoch, tools),
  }
})
