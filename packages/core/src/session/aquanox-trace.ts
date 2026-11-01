export * as AquanoxTrace from "./aquanox-trace.js"

import { randomBytes } from "node:crypto"
import { Effect } from "effect"
import type { SessionSchema } from "./schema.js"
import type { SessionStore } from "./store.js"

export interface TraceSessionNode {
  readonly sessionId: string
  readonly conversationId: string
  readonly rootSessionId: string | null
  readonly parentSessionId: string | null
  readonly parentSpanId: string | null
  readonly agentName: string | null
  readonly isSubagent: boolean
  readonly title: string | null
}

export interface TraceSpanIngestInput {
  readonly spanId: string
  readonly conversationId: string
  readonly parentSpanId?: string | null
  readonly rootSessionId?: string | null
  readonly sessionId?: string | null
  readonly parentSessionId?: string | null
  readonly layer: "harness" | "opencode" | "llama.cpp"
  readonly kind: string
  readonly name: string
  readonly status?: "running" | "ok" | "error" | "cancelled"
  readonly startUs: number
  readonly endUs?: number | null
  readonly durationMs?: number | null
  readonly model?: string | null
  readonly thinkingMode?: string | null
  readonly agentName?: string | null
  readonly isSubagent?: boolean
  readonly subagentSessionId?: string | null
  readonly contextWindowUsed?: number | null
  readonly contextWindowLimit?: number | null
  readonly promptTokens?: number | null
  readonly cachedTokens?: number | null
  readonly promptEvalTokens?: number | null
  readonly completionTokens?: number | null
  readonly reasoningTokens?: number | null
  readonly contentTokens?: number | null
  readonly ttftMs?: number | null
  readonly queueWaitMs?: number | null
  readonly prefillMs?: number | null
  readonly decodeMs?: number | null
  readonly tokensPerSec?: number | null
  readonly slotId?: number | null
  readonly attributes?: Record<string, string | number | boolean | null>
}

export interface TraceIngestPayload {
  readonly sessionBinding?: TraceSessionNode
  readonly span?: TraceSpanIngestInput
  readonly spans?: ReadonlyArray<TraceSpanIngestInput>
}

export interface SessionCorrelation {
  readonly conversationId: string
  readonly rootSessionId: string
  readonly sessionId: string
  readonly parentSessionId: string | null
  readonly parentTurnSpanId: string | null
  readonly thinkingMode: string | null
  readonly isSubagent: boolean
}

export interface RequestTraceContext {
  readonly conversationId: string
  readonly rootSessionId: string
  readonly parentSpanId?: string | null
  readonly thinkingMode?: string | null
}

interface StoredCorrelation {
  conversationId?: string
  rootSessionId?: string
  parentSessionId?: string
  turnSpanId?: string
  parentSpanId?: string
  thinkingMode?: string
}

const correlationCache = new Map<string, StoredCorrelation>()
const activeTurnSpans = new Map<string, string>()
const activeStepSpans = new Map<string, string>()
const activeCompactSpans = new Map<string, string>()

export const resolveLogdUrl = (): string | null => {
  const raw = process.env.AQUANOX_LOGD_URL?.trim()
  if (raw !== undefined && raw.length > 0) {
    const lower = raw.toLowerCase()
    if (lower === "off" || lower === "0" || lower === "disabled" || lower === "false") return null
    return raw.replace(/\/+$/, "")
  }
  if (process.env.AQUANOX_ISOLATED_VALIDATION === "1" || process.env.NODE_ENV === "test") return null
  return "http://127.0.0.1:4318"
}

export const isEnabled = (): boolean => resolveLogdUrl() !== null

export const hasExplicitCorrelation = (sessionId: string, metadata?: Record<string, unknown>): boolean => {
  if (correlationCache.has(sessionId)) return true
  if (!metadata) return false
  return Object.keys(extractAquanoxMetadata(metadata)).length > 0
}

let lastTimestampUs = 0
let anchorWallMs = Date.now()
let anchorPerfMs = performance.now()

export const nowUs = (): number => {
  const perfMs = performance.now()
  const wallMs = Date.now()
  const elapsedPerfMs = perfMs - anchorPerfMs
  if (elapsedPerfMs > 5000 || Math.abs(anchorWallMs + elapsedPerfMs - wallMs) > 2) {
    anchorWallMs = wallMs
    anchorPerfMs = perfMs
  }
  const candidate = Math.round((anchorWallMs + (perfMs - anchorPerfMs)) * 1000)
  lastTimestampUs = candidate > lastTimestampUs ? candidate : lastTimestampUs + 1
  return lastTimestampUs
}

export const durationMs = (startUs: number, endUs: number): number =>
  Math.max(0, Number(((endUs - startUs) / 1000).toFixed(3)))

export const newSpanId = (prefix: string): string => `${prefix}_${randomBytes(8).toString("hex")}`

export const postTraceIngestPromise = async (payload: TraceIngestPayload): Promise<void> => {
  const baseUrl = resolveLogdUrl()
  if (!baseUrl) return
  try {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(35),
    })
    await response.body?.cancel().catch(() => undefined)
  } catch {
    // Fail-open silently when genai-logd is unreachable or times out.
  }
}

export const postTraceIngest = (payload: TraceIngestPayload): Effect.Effect<void> =>
  Effect.uninterruptible(Effect.promise(() => postTraceIngestPromise(payload)))

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined

const AQUANOX_META_KEYS = [
  "aquanoxConversationId",
  "aquanoxTurnSpanId",
  "aquanoxParentSpanId",
  "aquanoxRootSessionId",
  "aquanoxThinkingMode",
] as const

export const extractAquanoxMetadata = (metadata: Record<string, unknown> | undefined): Record<string, string> => {
  if (!metadata) return {}
  const out: Record<string, string> = {}
  for (const key of AQUANOX_META_KEYS) {
    const val = nonEmptyString(metadata[key])
    if (val !== undefined) out[key] = val
  }
  return out
}

export const mergeHeaderMetadata = <T extends Record<string, unknown> = Record<string, string>>(
  headers: Record<string, string | undefined>,
  metadata: T | undefined,
): T | undefined => {
  const extracted: Record<string, string> = {}
  const conv = nonEmptyString(headers["x-aquanox-conversation-id"])
  const turn = nonEmptyString(headers["x-aquanox-turn-span-id"])
  const parent = nonEmptyString(headers["x-aquanox-parent-span-id"])
  const root = nonEmptyString(headers["x-aquanox-root-session-id"])
  const thinking = nonEmptyString(headers["x-aquanox-thinking-mode"])
  if (conv !== undefined) extracted.aquanoxConversationId = conv
  if (turn !== undefined) extracted.aquanoxTurnSpanId = turn
  if (parent !== undefined) extracted.aquanoxParentSpanId = parent
  if (root !== undefined) extracted.aquanoxRootSessionId = root
  if (thinking !== undefined) extracted.aquanoxThinkingMode = thinking
  if (Object.keys(extracted).length === 0) return metadata
  return { ...extracted, ...(metadata ?? {}) } as unknown as T
}

export const recordFromMetadata = (
  sessionId: string,
  metadata: Record<string, unknown> | undefined,
  parentSessionId?: string,
): void => {
  const extracted = extractAquanoxMetadata(metadata)
  if (Object.keys(extracted).length === 0 && parentSessionId === undefined) return
  const existing = correlationCache.get(sessionId) ?? {}
  correlationCache.set(sessionId, {
    ...existing,
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    ...(extracted.aquanoxConversationId !== undefined ? { conversationId: extracted.aquanoxConversationId } : {}),
    ...(extracted.aquanoxRootSessionId !== undefined ? { rootSessionId: extracted.aquanoxRootSessionId } : {}),
    ...(extracted.aquanoxTurnSpanId !== undefined ? { turnSpanId: extracted.aquanoxTurnSpanId } : {}),
    ...(extracted.aquanoxParentSpanId !== undefined ? { parentSpanId: extracted.aquanoxParentSpanId } : {}),
    ...(extracted.aquanoxThinkingMode !== undefined ? { thinkingMode: extracted.aquanoxThinkingMode } : {}),
  })
}

export const recordFromSession = (session: SessionSchema.Info): void => {
  recordFromMetadata(session.id, session.metadata, session.parentID)
}

export const recordSubagentBinding = (input: {
  readonly childSessionId: string
  readonly parentSessionId: string
  readonly conversationId: string
  readonly rootSessionId: string
  readonly subSpanId: string
  readonly thinkingMode: string | null
}): void => {
  const existing = correlationCache.get(input.childSessionId) ?? {}
  correlationCache.set(input.childSessionId, {
    ...existing,
    conversationId: input.conversationId,
    rootSessionId: input.rootSessionId,
    parentSessionId: input.parentSessionId,
    parentSpanId: input.subSpanId,
    ...(input.thinkingMode ? { thinkingMode: input.thinkingMode } : {}),
  })
}

const resolveFromChain = (chain: ReadonlyArray<SessionSchema.Info>): SessionCorrelation => {
  const leaf = chain[0]!
  const root = chain[chain.length - 1]!
  let conversationId: string | undefined
  let rootSessionId: string | undefined
  let thinkingMode: string | undefined

  for (const node of chain) {
    const cached = correlationCache.get(node.id)
    const meta = extractAquanoxMetadata(node.metadata)
    if (conversationId === undefined) conversationId = cached?.conversationId ?? meta.aquanoxConversationId
    if (rootSessionId === undefined) rootSessionId = cached?.rootSessionId ?? meta.aquanoxRootSessionId
    if (thinkingMode === undefined) thinkingMode = cached?.thinkingMode ?? meta.aquanoxThinkingMode
  }

  // Also walk cached parentSessionId chain if store chain stopped early
  let cursorParent: string | undefined = chain[chain.length - 1]?.parentID
  const seen = new Set<string>(chain.map((s) => s.id))
  let fallbackRootId: string = root.id
  while (cursorParent && !seen.has(cursorParent)) {
    seen.add(cursorParent)
    fallbackRootId = cursorParent
    const cached = correlationCache.get(cursorParent)
    if (conversationId === undefined) conversationId = cached?.conversationId
    if (rootSessionId === undefined) rootSessionId = cached?.rootSessionId
    if (thinkingMode === undefined) thinkingMode = cached?.thinkingMode
    cursorParent = cached?.parentSessionId
  }

  const resolvedRootId = rootSessionId ?? fallbackRootId
  const resolvedConversationId = conversationId ?? resolvedRootId
  const leafCached = correlationCache.get(leaf.id)
  const leafMeta = extractAquanoxMetadata(leaf.metadata)
  const isSubagent = Boolean(leaf.parentID)

  let parentTurnSpanId: string | null = null
  if (isSubagent) {
    parentTurnSpanId =
      leafCached?.parentSpanId ??
      leafMeta.aquanoxParentSpanId ??
      (leaf.parentID ? (activeStepSpans.get(leaf.parentID) ?? activeTurnSpans.get(leaf.parentID) ?? null) : null)
  } else {
    parentTurnSpanId =
      leafCached?.turnSpanId ??
      leafMeta.aquanoxTurnSpanId ??
      leafCached?.parentSpanId ??
      leafMeta.aquanoxParentSpanId ??
      null
  }

  return {
    conversationId: resolvedConversationId,
    rootSessionId: resolvedRootId,
    sessionId: leaf.id,
    parentSessionId: leaf.parentID ?? null,
    parentTurnSpanId,
    thinkingMode: thinkingMode ?? null,
    isSubagent,
  }
}

export const resolveSessionCorrelationSync = (session: SessionSchema.Info): SessionCorrelation => {
  recordFromSession(session)
  return resolveFromChain([session])
}

export const resolveSessionCorrelation = Effect.fnUntraced(function* (
  store: SessionStore.Interface,
  session: SessionSchema.Info,
) {
  recordFromSession(session)
  const chain: SessionSchema.Info[] = [session]
  const visited = new Set<string>([session.id])
  let current = session
  while (current.parentID && !visited.has(current.parentID)) {
    visited.add(current.parentID)
    const parent = yield* store.get(current.parentID)
    if (!parent) break
    recordFromSession(parent)
    chain.push(parent)
    current = parent
  }
  const resolved = resolveFromChain(chain)
  const existing = correlationCache.get(session.id) ?? {}
  correlationCache.set(session.id, {
    ...existing,
    conversationId: resolved.conversationId,
    rootSessionId: resolved.rootSessionId,
    ...(session.parentID ? { parentSessionId: session.parentID } : {}),
    ...(resolved.thinkingMode ? { thinkingMode: resolved.thinkingMode } : {}),
  })
  return resolved
})

export const setActiveTurnSpan = (sessionId: string, spanId: string | null): void => {
  if (spanId === null) activeTurnSpans.delete(sessionId)
  else activeTurnSpans.set(sessionId, spanId)
}

export const getActiveTurnSpan = (sessionId: string): string | null => activeTurnSpans.get(sessionId) ?? null

export const setActiveStepSpan = (sessionId: string, spanId: string | null): void => {
  if (spanId === null) activeStepSpans.delete(sessionId)
  else activeStepSpans.set(sessionId, spanId)
}

export const getActiveStepSpan = (sessionId: string): string | null => activeStepSpans.get(sessionId) ?? null

export const setActiveCompactSpan = (sessionId: string, spanId: string | null): void => {
  if (spanId === null) activeCompactSpans.delete(sessionId)
  else activeCompactSpans.set(sessionId, spanId)
}

export const getActiveCompactSpan = (sessionId: string): string | null => activeCompactSpans.get(sessionId) ?? null

export const usageMetrics = (
  tokens:
    | {
        readonly input: number
        readonly output: number
        readonly reasoning: number
        readonly cache: { readonly read: number; readonly write: number }
      }
    | undefined,
  contextLimit?: number | null,
) => {
  const contextWindowLimit = contextLimit && contextLimit > 0 ? contextLimit : null
  if (!tokens) {
    return {
      contextWindowUsed: null,
      contextWindowLimit,
      promptTokens: null,
      cachedTokens: null,
      completionTokens: null,
      reasoningTokens: null,
      contentTokens: null,
    }
  }
  const promptTokens = tokens.input + tokens.cache.read + tokens.cache.write
  const completionTokens = tokens.output + tokens.reasoning
  return {
    contextWindowUsed: promptTokens + completionTokens,
    contextWindowLimit,
    promptTokens,
    cachedTokens: tokens.cache.read,
    completionTokens,
    reasoningTokens: tokens.reasoning,
    contentTokens: tokens.output,
  }
}
