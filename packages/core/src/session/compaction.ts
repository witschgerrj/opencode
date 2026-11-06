export * as SessionCompaction from "./compaction.js"

import {
  AIError,
  type ContentPart,
  HttpOptions,
  InvalidProviderOutputError,
  InvalidRequestError,
  isContextOverflowFailure,
  LLMClient,
  LLMEvent,
  LLMRequest,
  Message,
  type ToolEntry,
  UnknownProviderError,
  type Usage,
} from "@opencode/ai/effect"
import type { StreamOptions } from "@opencode/ai/route"
import type { SessionCompactionResult } from "@opencode/plugin/effect/session"
import type { SessionError } from "@opencode/schema/session-error"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Exit, Fiber, Layer, Result, Scope, Stream } from "effect"
import { Agent } from "../agent.js"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { llmClient } from "../effect/app-node-platform.js"
import { Model } from "../model.js"
import { State } from "../state.js"
import { Token } from "../util/token.js"
import type { SessionContext } from "./context.js"
import { AquanoxTrace } from "./aquanox-trace.js"
import { SessionEvent } from "./event.js"
import { SessionHistory } from "./history.js"
import type { SessionMessage } from "./message.js"
import { SessionModelRequest } from "./model-request.js"
import { SessionRunnerModel } from "./runner/model.js"
import { SessionSlotLease } from "./slot-lease.js"
import { SessionRunnerRetry } from "./runner/retry.js"
import { toLLMMessages } from "./runner/to-llm-message.js"
import { SessionRecentText } from "./recent-text.js"
import { contentFilterError, toSessionError } from "./to-session-error.js"
import { SessionUsage } from "./usage.js"

export type Settings = {
  auto: boolean
  /** Tokens kept free below the model's limits before compacting. Unset keeps 15%, and at least 16k, free. */
  buffer?: number
  /** Tokens of recent conversation kept verbatim beside the summary. */
  keep: number
  /** Summarize in the background as the context nears the threshold, so automatic compaction can swap it in. */
  precompute: boolean
}

export type Editor = {
  configure: (settings: Partial<Settings>) => void
}

/** A prompt's size: `measured` is what the provider reported at the latest response, `estimated` is the text since. */
export type Estimate = { readonly measured: number; readonly estimated: number }

export type Trigger =
  /** `overflow`: the provider just rejected this context as too long. `estimate` is `estimatePrompt(context)`. */
  | { readonly reason: "auto" | "overflow"; readonly context: SessionContext.Loaded; readonly estimate?: Estimate }
  /** `inputID` is the `/compact` inbox item, whose message shows the outcome. */
  | { readonly reason: "manual"; readonly context: SessionContext.Loaded; readonly inputID: SessionMessage.ID }

export type Outcome =
  /** Only `auto` skips: the context fits, or automatic compaction is off. */
  | { readonly status: "skipped" }
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly error: SessionError.Error }

export interface Interface extends State.Transformable<Editor> {
  readonly compact: (trigger: Trigger) => Effect.Effect<Outcome>
  /**
   * Starts a background summary when the context nears the threshold. Never waits for it. Loads `context` only when
   * background summaries are on. `estimate`, when given, is `estimatePrompt` of the loaded context.
   */
  readonly precompute: <E>(
    context: Effect.Effect<SessionContext.Loaded, E>,
    estimate?: Estimate,
  ) => Effect.Effect<void, E>
  readonly interruptPrecompute: (sessionID: string) => Effect.Effect<void>
  readonly awaitPrecompute: (sessionID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

/**
 * A summary fills `text`, and references the messages it keeps verbatim with `metadata.keepID`; history
 * rebuilds their text from that. A native compaction fills `native.messages` with its replacement window.
 */
type Result = {
  readonly text: string
  readonly native?: SessionMessage.Native
  readonly metadata?: Record<string, unknown>
}

type Failure = {
  readonly error: SessionError.Error
}

type Prepared = Effect.Success<ReturnType<SessionModelRequest.Interface["compaction"]>>

type Streamed = {
  readonly text: string
}

/** A summary run off the critical path: it covers only `messages`, streams no deltas, and bills into `usage`. */
type Background = {
  readonly messages: ReadonlyArray<SessionMessage.Info>
  readonly usage: (usage: SessionUsage.Recorded) => void
}

/** A background summary of everything before `keepID`, held until automatic compaction is due. */
type Precomputed = {
  readonly firstID: SessionMessage.ID | undefined
  readonly keepID: SessionMessage.ID
  readonly model: SessionContext.Loaded["model"]["ref"]
  readonly initial: string
  /** The longest tail since `keepID` that compaction still accepts beside this summary. */
  readonly tailLimit: number
  /** Background summaries that failed since the last compaction, this one included once it has. */
  readonly failures: number
  readonly usage: SessionUsage.Recorded[]
  readonly fiber: Fiber.Fiber<Result, Failure>
}

const NOTHING_TO_COMPACT: Failure = { error: { type: "compaction.unavailable", message: "Nothing to compact yet" } }
/** After each "too long" rejection, the next attempt aims at this share of the first rejected request's size. */
const SHRINK_STEPS = [0.85, 0.7, 0.5, 0.35]
// The least of the window kept free for the last reply before compaction and for the summary itself.
const RESERVE_MIN = 16_000
/**
 * Share of the window kept free before automatic compaction. Above `RESERVE_MIN`, the margin between it and
 * `summaryRoom` absorbs a large step past the trigger, so the whole conversation still goes out unchanged and reuses
 * the cache. Single steps grew by up to ~22k tokens at p99 in real sessions.
 */
const RESERVE_SHARE = 0.15
/** A common window size, assumed for the compaction request when the model's window is unknown. */
const UNKNOWN_WINDOW = 200_000
/** A summary gets at least this much output, or the room left if less, even when the estimate margin leaves less. */
const SUMMARY_OUTPUT_FLOOR = 32_000
/**
 * How far one exchange of a summary transcript is shortened, in the order the levels apply: whole; tool outputs cut;
 * tool outputs left out and tool inputs cut; only the user's text, cut; omitted.
 */
const OUTPUTS_CLIPPED = 1
const OUTPUTS_REMOVED = 2
const USER_ONLY = 3
const OMITTED = 4
const TRANSCRIPT_LEVELS = [0, OUTPUTS_CLIPPED, OUTPUTS_REMOVED, USER_ONLY, OMITTED]
/** Characters kept, from the start and end, of a cut tool input, tool output, or user message. */
const TRANSCRIPT_CLIP = 2_000
const IMAGE_TOKEN_ESTIMATE = 1_500
const PDF_TOKEN_ESTIMATE = 2_000
/** Share of the compaction ceiling at which a background summary starts. */
const PRECOMPUTE_RATIO = 0.85
/** Measured prompt tokens below which a background summary is not worth its cost. */
const PRECOMPUTE_MIN_TOKENS = 64_000
/**
 * The most text a swapped-in summary keeps verbatim beside it: twice `keep`, at least 30k, at most a quarter of the
 * budget. A longer tail would leave the context near the threshold, so compaction summarizes from scratch instead.
 */
const PRECOMPUTED_TAIL_MIN = 30_000
const PRECOMPUTED_TAIL_SHARE = 0.25
/** Failed background summaries after which no new one starts until the next compaction. */
const PRECOMPUTE_MAX_FAILURES = 2

const SUMMARY_TEMPLATE = `You MUST use this format for your response (you may omit sections that aren't applicable). Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Requirements
- [constraints, preferences, requirements, and scope boundaries stated by the user, or "(none)"]

## Decisions
- [decisions already made and why, or "(none)"]

## Work State
Break the objective into smaller goals and report which are completed, which are being worked on, and which are blocked.
### Completed
- [goals that have been completed; otherwise "(none)"]

### Active
- [goals currently being worked on; otherwise "(none)"]

### Blocked
- [anything blocking progress, and why; otherwise "(none)"]

## Failed Hypotheses / Approaches Not to Repeat
- [debugging attempts, architectural approaches, or test fixes that failed, why they failed, and why they MUST NOT be retried; or "(none)"]

## Next Move
1. [ordered list of next actions, or "(none)"]

## Relevant Files
List the files and directories, other than the current working directory, that another agent would need to open to continue this work. Include at most 15, most important first. Do not list every file that was read or changed. Include paths outside the current working directory when relevant. If none, write "(none)".
- \`[file or directory path]\`: [brief reason it matters]

## Important Context
- [facts the next agent cannot continue without and cannot easily find on its own; or "(none)"]
</template>`

const SUMMARY_RULES = `Rules:
- Keep each section concise. Use terse, single-line bullets, not prose paragraphs or nested lists.
- Prefer short references over detailed restatement. It is fine to leave out information the next agent can recover from the code or the files listed above.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers.
- Carry forward only user questions or requests that remain unanswered or require further action. Do not repeat ones that newer history has answered or resolved. Preserve exact wording when carrying one forward.
- Preserve consequential workflow state, including whether changes are uncommitted, committed, pushed, under review, or merged.
- Under Failed Hypotheses, document failed fixes, incorrect assumptions, or broken approaches with their error messages so future turns avoid repeating them.
- Do not mention the summary process or that context was compacted.`

export const buildPrompt = (update: boolean, legacy = false) => {
  const shared = [
    "Summarize only what the user and the assistant said and did. Leave out instructions and setup the assistant was given rather than told by the user: repository conventions, instruction files such as AGENTS.md, and environment details like the session ID. The next agent receives current versions of all of these separately.",
    SUMMARY_TEMPLATE,
    SUMMARY_RULES,
    "Do not continue the task or call tools.",
    "Return only the structured summary in the requested format. Do not include a preamble, explanation, or other commentary.",
  ]
  if (!update) {
    return [
      "You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.",
      ...shared,
    ].join("\n\n")
  }
  return [
    "Update the existing checkpoint in the conversation above into one consolidated summary.",
    // Before #48058 (Sep 2026), summaries kept nearly everything: every file touched, per-edit changelogs,
    // restated AGENTS.md conventions, and an "Additional Context" section that grew on every update. The
    // preserve-first update prompt would carry that detail forward indefinitely, so a checkpoint from that
    // template is rewritten once at the current level of detail. The rewrite uses the new headings, so later
    // updates skip this. Remove once no session still in use has a latest checkpoint older than #48058.
    ...(legacy
      ? [
          "The existing checkpoint was written with an earlier format that recorded far more detail than this one asks for. Rewrite it at the level of detail described below rather than carrying its detail forward. Keep its requirements, decisions, and open questions; they came from earlier conversation with the user.",
        ]
      : []),
    "Newer history always takes precedence over the existing checkpoint. Preserve previous information unless newer history clearly contradicts, supersedes, resolves, or makes it stale. If something is no longer relevant to continuing the work, you may remove it.",
    "Incorporate newer requirements, decisions, progress, and context. Reconcile Work State and Next Move: move completed work out of Active, remove resolved blockers and answered questions, and preserve unresolved or pending work.",
    "Return only the updated Markdown sections. Do not reproduce the `<conversation-checkpoint>`, `<summary>`, or `<recent-context>` wrapper tags from the previous checkpoint.",
    ...shared,
  ].join("\n\n")
}

const NUDGE =
  "The previous response did not fill in the required summary template. Do not call tools. Return the summary as text using the exact section headings from the template."

/** Summaries written with the previous template carry this catch-all heading. */
const LEGACY_HEADING = "## Additional Context"

export const COMPACTION_SLOT_UNAVAILABLE_ERROR =
  "ERR_COMPACTION_SLOT_UNAVAILABLE: Cannot execute local LLM compaction without an active leased Buddy Slot (0..8)"

export function resolveCompactionLeaseOrFail(
  sessionID: string,
  isSubagent: boolean,
): { slot: SessionSlotLease.PhysicalSlotID; wasAlreadyHeldByTurn: boolean } {
  const existingSlot = SessionSlotLease.isActivelyHeld(sessionID)
  if (existingSlot !== undefined && existingSlot >= 0) {
    return { slot: existingSlot, wasAlreadyHeldByTurn: true }
  }
  const syncSlot = SessionSlotLease.acquire(sessionID, isSubagent)
  if (syncSlot >= 0) {
    return { slot: syncSlot as SessionSlotLease.PhysicalSlotID, wasAlreadyHeldByTurn: false }
  }
  throw new Error(COMPACTION_SLOT_UNAVAILABLE_ERROR)
}

export function resolveCompactionSlotOrFail(
  sessionID: string,
  isSubagent: boolean,
): SessionSlotLease.PhysicalSlotID {
  return resolveCompactionLeaseOrFail(sessionID, isSubagent).slot
}

export function acquireCompactionSlotEffect(
  sessionID: string,
  isSubagent: boolean,
  options?: {
    parentSessionID?: string
    tier?: SessionSlotLease.LeaseTier
    queueWhenBusy?: boolean
  },
): Effect.Effect<{ slot: SessionSlotLease.PhysicalSlotID; wasAlreadyHeldByTurn: boolean }, Error> {
  return Effect.gen(function* () {
    const existingSlot = SessionSlotLease.isActivelyHeld(sessionID)
    if (existingSlot !== undefined && existingSlot >= 0) {
      return { slot: existingSlot, wasAlreadyHeldByTurn: true }
    }
    const syncSlot = SessionSlotLease.acquire(sessionID, isSubagent)
    if (syncSlot >= 0) {
      return { slot: syncSlot as SessionSlotLease.PhysicalSlotID, wasAlreadyHeldByTurn: false }
    }
    if (options?.queueWhenBusy && isSubagent) {
      const tier = options.tier ?? SessionSlotLease.getSessionTier(sessionID) ?? "128k"
      const queuedSlot = yield* SessionSlotLease.acquireSubagentAsync({
        sessionID,
        parentSessionID: options.parentSessionID,
        tier,
      })
      if (queuedSlot >= 0) {
        return { slot: queuedSlot as SessionSlotLease.PhysicalSlotID, wasAlreadyHeldByTurn: false }
      }
    }
    return yield* Effect.fail(new Error(COMPACTION_SLOT_UNAVAILABLE_ERROR))
  })
}

export function shouldPrecompute(settings: { precompute?: boolean; auto?: boolean }): boolean {
  return Boolean(settings.precompute && settings.auto)
}

export const activePrecomputeFibers = new Map<string, Fiber.Fiber<Result, Failure>>()

export const interruptPrecompute = (sessionID: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const fiber = activePrecomputeFibers.get(sessionID)
    if (fiber) {
      activePrecomputeFibers.delete(sessionID)
      yield* Fiber.interrupt(fiber)
    }
  })

export const awaitPrecompute = (sessionID: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const fiber = activePrecomputeFibers.get(sessionID)
    if (fiber) {
      yield* Fiber.await(fiber).pipe(Effect.catch(() => Effect.void))
    }
  })

export interface ExtractCompactionSlotInput {
  sessionId?: string
  sessionID?: string
  request?: unknown
  options?: unknown
  leasedSlot?: number
}

function readSlotFromCarrier(carrier: unknown): number | undefined {
  if (!carrier || typeof carrier !== "object") return undefined
  const obj = carrier as Record<string, any>
  const candidates: unknown[] = [
    obj.id_slot,
    obj.body?.id_slot,
    obj.httpBody?.id_slot,
    obj.http?.body?.id_slot,
    obj.providerOptions?.["deepseek-local"]?.id_slot,
    obj.providerOptions?.openaiCompatible?.id_slot,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      return candidate
    }
  }
  return undefined
}

export function extractCompactionSlot(
  sessionOrInput?: string | ExtractCompactionSlotInput | unknown,
  requestArg?: unknown,
  optionsArg?: unknown,
  leasedSlotArg?: number,
): number | undefined {
  const isWrapperObj =
    typeof sessionOrInput === "object" &&
    sessionOrInput !== null &&
    ("sessionId" in sessionOrInput ||
      "sessionID" in sessionOrInput ||
      "request" in sessionOrInput ||
      "options" in sessionOrInput ||
      "leasedSlot" in sessionOrInput)

  const wrapper = isWrapperObj ? (sessionOrInput as ExtractCompactionSlotInput) : undefined
  const explicitLeasedCandidates: unknown[] = [
    wrapper?.leasedSlot,
    leasedSlotArg,
    typeof sessionOrInput === "number" ? sessionOrInput : undefined,
  ]
  for (const c of explicitLeasedCandidates) {
    if (typeof c === "number" && Number.isFinite(c) && c >= 0) {
      return c
    }
  }

  const carriers: unknown[] = isWrapperObj
    ? [wrapper?.options, wrapper?.request, requestArg, optionsArg]
    : [optionsArg, requestArg, sessionOrInput]
  for (const carrier of carriers) {
    const found = readSlotFromCarrier(carrier)
    if (found !== undefined) {
      return found
    }
  }

  const sessionCandidates: unknown[] = [
    wrapper?.sessionId,
    wrapper?.sessionID,
    typeof sessionOrInput === "string" ? sessionOrInput : undefined,
    typeof requestArg === "string" ? requestArg : undefined,
    typeof optionsArg === "string" ? optionsArg : undefined,
  ]
  for (const s of sessionCandidates) {
    if (typeof s === "string" && s.length > 0) {
      const active = SessionSlotLease.isActivelyHeld(s)
      if (typeof active === "number" && Number.isFinite(active) && active >= 0) {
        return active
      }
      const snapSlot = SessionSlotLease.getResourceSnapshot({ sessionId: s }).thisConversation?.leadSlotId
      if (typeof snapSlot === "number" && Number.isFinite(snapSlot) && snapSlot >= 0) {
        return snapSlot
      }
    }
  }

  return undefined
}

export const resolveCompactionRequestSlot = extractCompactionSlot

export function attachSlotToRequest(request: LLMRequest, slot: number | undefined): LLMRequest {
  if (typeof slot !== "number" || !Number.isFinite(slot) || slot < 0) return request
  const existingHttpBody =
    (request.http?.body && typeof request.http.body === "object"
      ? (request.http.body as Record<string, unknown>)
      : undefined) ??
    ((request as any)?.httpBody && typeof (request as any).httpBody === "object"
      ? ((request as any).httpBody as Record<string, unknown>)
      : {})
  const nextBody = {
    ...existingHttpBody,
    id_slot: slot,
  }
  const existingProviderOptions =
    request.providerOptions && typeof request.providerOptions === "object"
      ? (request.providerOptions as Record<string, unknown>)
      : {}
  const existingDeepSeekLocal =
    existingProviderOptions["deepseek-local"] && typeof existingProviderOptions["deepseek-local"] === "object"
      ? (existingProviderOptions["deepseek-local"] as Record<string, unknown>)
      : {}
  const existingOpenaiCompatible =
    existingProviderOptions.openaiCompatible && typeof existingProviderOptions.openaiCompatible === "object"
      ? (existingProviderOptions.openaiCompatible as Record<string, unknown>)
      : {}
  const nextProviderOptions = {
    ...existingProviderOptions,
    "deepseek-local": { ...existingDeepSeekLocal, id_slot: slot },
    openaiCompatible: { ...existingOpenaiCompatible, id_slot: slot },
  }
  const nextHttp = new HttpOptions({
    ...(request.http ?? {}),
    body: nextBody,
  })
  let updated: LLMRequest
  try {
    updated = LLMRequest.update(request, {
      http: nextHttp,
      providerOptions: nextProviderOptions,
    })
  } catch {
    updated = {
      ...(request as any),
      http: nextHttp,
      providerOptions: nextProviderOptions,
    } as LLMRequest
  }
  try {
    Object.assign(updated as any, {
      id_slot: slot,
      body: nextBody,
      httpBody: nextBody,
    })
  } catch {
    // Ignore if frozen
  }
  return updated
}

export function attachSlotToOptions(options: StreamOptions | undefined, slot: number | undefined): StreamOptions {
  const base = (options ?? {}) as Record<string, unknown>
  if (typeof slot !== "number" || !Number.isFinite(slot) || slot < 0) return base as StreamOptions
  const existingHttpBody =
    base.httpBody && typeof base.httpBody === "object" ? (base.httpBody as Record<string, unknown>) : {}
  const existingBody =
    base.body && typeof base.body === "object" ? (base.body as Record<string, unknown>) : {}
  const existingHttp =
    base.http && typeof base.http === "object" && typeof base.http !== "function"
      ? (base.http as Record<string, unknown>)
      : undefined
  const existingProviderOptions =
    base.providerOptions && typeof base.providerOptions === "object"
      ? (base.providerOptions as Record<string, unknown>)
      : {}
  const existingDeepSeekLocal =
    existingProviderOptions["deepseek-local"] && typeof existingProviderOptions["deepseek-local"] === "object"
      ? (existingProviderOptions["deepseek-local"] as Record<string, unknown>)
      : {}
  const existingOpenaiCompatible =
    existingProviderOptions.openaiCompatible && typeof existingProviderOptions.openaiCompatible === "object"
      ? (existingProviderOptions.openaiCompatible as Record<string, unknown>)
      : {}
  return {
    ...base,
    id_slot: slot,
    body: { ...existingBody, id_slot: slot },
    httpBody: { ...existingHttpBody, id_slot: slot },
    ...(existingHttp
      ? {
          http: {
            ...existingHttp,
            body: {
              ...(existingHttp.body && typeof existingHttp.body === "object"
                ? (existingHttp.body as Record<string, unknown>)
                : {}),
              id_slot: slot,
            },
          },
        }
      : {}),
    providerOptions: {
      ...existingProviderOptions,
      "deepseek-local": { ...existingDeepSeekLocal, id_slot: slot },
      openaiCompatible: { ...existingOpenaiCompatible, id_slot: slot },
    },
  } as unknown as StreamOptions
}

export function isLocalSlotBudgetedModel(context: SessionContext.Loaded): boolean {
  const defaultBody = context.model.model.route.defaults.http?.body
  return (
    String(context.model.ref.providerID) === "deepseek-local" ||
    (defaultBody !== undefined &&
      typeof defaultBody === "object" &&
      defaultBody !== null &&
      "reasoning_budget_tokens" in defaultBody)
  )
}

export function withCompactionLeaseAndTurnstile<A, E, R>(
  input: {
    sessionID: string
    isSubagent: boolean
    parentSessionID?: string
    localSlotBudgeted: boolean
    allowReentrantTurnstile?: boolean
    leasedSlot?: number
  },
  use: (leasedSlot: number | undefined, turnstileSessionKey: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const turnstileKey = input.allowReentrantTurnstile
      ? input.sessionID
      : `${input.sessionID}:background_compaction`
    const existingResolvedSlot = extractCompactionSlot({
      sessionId: input.sessionID,
      leasedSlot: input.leasedSlot,
    })
    const shouldManageSlot =
      input.localSlotBudgeted || input.leasedSlot !== undefined || existingResolvedSlot !== undefined

    if (!shouldManageSlot) {
      return yield* use(undefined, turnstileKey)
    }

    const isSlotOrSessionBusyInTurnstile = (targetSlot: number | undefined): boolean => {
      if (input.allowReentrantTurnstile) return false
      const activeSlots = SessionSlotLease.getTelemetry().activeComputeSlots
      return activeSlots.some(
        (entry) =>
          entry.sessionID === input.sessionID ||
          entry.sessionID === turnstileKey ||
          (targetSlot !== undefined && targetSlot >= 0 && entry.slot === targetSlot),
      )
    }

    while (
      isSlotOrSessionBusyInTurnstile(
        input.leasedSlot ??
          extractCompactionSlot(input.sessionID) ??
          SessionSlotLease.peek(input.sessionID, input.isSubagent),
      )
    ) {
      yield* Effect.sleep("5 millis")
    }

    let compactionOwnsLease = false
    let leasedSlot: number | undefined

    const activeNow = SessionSlotLease.isActivelyHeld(input.sessionID)
    if (activeNow !== undefined && activeNow >= 0) {
      leasedSlot = activeNow
      compactionOwnsLease = false
    } else if (input.leasedSlot !== undefined && input.leasedSlot >= 0) {
      const syncAcq = SessionSlotLease.acquire(input.sessionID, input.isSubagent)
      if (syncAcq >= 0) {
        leasedSlot = syncAcq
        compactionOwnsLease = true
      } else {
        leasedSlot = input.leasedSlot
        compactionOwnsLease = false
      }
    } else {
      const syncAcq = SessionSlotLease.acquire(input.sessionID, input.isSubagent)
      if (syncAcq >= 0) {
        leasedSlot = syncAcq
        compactionOwnsLease = true
      } else if (input.isSubagent) {
        const tier = SessionSlotLease.getSessionTier(input.sessionID) ?? "128k"
        const queuedSlot = yield* SessionSlotLease.acquireSubagentAsync({
          sessionID: input.sessionID,
          parentSessionID: input.parentSessionID,
          tier,
        })
        if (queuedSlot < 0) {
          if (input.localSlotBudgeted) {
            return yield* Effect.die(new Error(COMPACTION_SLOT_UNAVAILABLE_ERROR))
          }
          leasedSlot = undefined
        } else {
          leasedSlot = queuedSlot
          compactionOwnsLease = true
        }
      } else if (input.localSlotBudgeted) {
        leasedSlot = resolveCompactionSlotOrFail(input.sessionID, input.isSubagent)
        compactionOwnsLease = true
      } else {
        leasedSlot = existingResolvedSlot
        compactionOwnsLease = false
      }
    }

    while (isSlotOrSessionBusyInTurnstile(leasedSlot)) {
      yield* Effect.sleep("5 millis")
    }

    if (leasedSlot !== undefined && leasedSlot >= 0 && SessionSlotLease.isActivelyHeld(input.sessionID) === undefined) {
      const reacquired = SessionSlotLease.acquire(input.sessionID, input.isSubagent)
      if (reacquired >= 0) {
        leasedSlot = reacquired
        compactionOwnsLease = true
      }
    }

    return yield* SessionSlotLease.withComputeTurnstile(turnstileKey, leasedSlot, () =>
      use(leasedSlot, turnstileKey),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (compactionOwnsLease && leasedSlot !== undefined && leasedSlot >= 0) {
            if (input.isSubagent) {
              SessionSlotLease.releaseSubagentSession(input.sessionID)
            } else {
              SessionSlotLease.release(input.sessionID)
            }
          }
        }),
      ),
    )
  })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const bus = yield* Bus.Service
    const llm = yield* LLMClient.Service
    const catalog = yield* Model.Service
    const models = yield* SessionRunnerModel.Service
    const db = (yield* Database.Service).db
    const requests = yield* SessionModelRequest.Service

    const scope = yield* Scope.Scope
    const precomputed = new Map<SessionContext.Loaded["session"]["id"], Precomputed>()

    const state = State.create<Settings, Editor>({
      name: "session-compaction",
      initial: () => ({ auto: true, keep: 15_000, precompute: false }),
      editor: (settings) => ({
        configure: (update) => {
          Object.assign(settings, update)
        },
      }),
    })

    const sessionCeilingOptions = (session: SessionContext.Loaded["session"]) => ({
      slotId: SessionSlotLease.peek(session.id, Boolean(session.parentID)),
      tier: (session.parentID
        ? (SessionSlotLease.getSessionTier(session.id) ?? "128k")
        : "384k") as SessionSlotLease.LeaseTier,
    })

    /** The model that writes the summary, and the request size it aims for. */
    const selectModel = Effect.fnUntraced(function* (
      context: SessionContext.Loaded,
      buffer: number | undefined,
      native: boolean,
    ) {
      const agent = native ? undefined : yield* agents.get(Agent.ID.make("compaction"))
      const model =
        (agent?.model &&
          (yield* models
            .resolve({ ...context.session, model: agent.model }, catalog.available)
            .pipe(Effect.orElseSucceed(() => undefined)))) ??
        context.model
      const ceilingOpts = sessionCeilingOptions(context.session)
      const ceiling = calculateCeiling(model.limit, buffer, model.ref.providerID, ceilingOpts)
      // An unknown window never triggers auto compaction, but the compaction request still needs a size to aim for.
      const cap = Number.isFinite(ceiling)
        ? ceiling
        : calculateCeiling({ ...model.limit, context: UNKNOWN_WINDOW }, buffer, model.ref.providerID, ceilingOpts)
      return { context: model === context.model ? context : { ...context, model }, cap }
    })

    const compact = Effect.fn("SessionCompaction.compact")(function* (trigger: Trigger): Effect.fn.Return<Outcome> {
      const settings = state.get()
      const context = trigger.context

      // Only the user compacts when automatic compaction is off, overflow included.
      if (trigger.reason !== "manual" && !settings.auto) return { status: "skipped" }
      if (
        trigger.reason === "auto" &&
        !due(
          context,
          calculateCeiling(
            context.model.limit,
            settings.buffer,
            context.model.ref.providerID,
            sessionCeilingOptions(context.session),
          ),
          trigger.estimate,
        )
      )
        return { status: "skipped" }
      const held = precomputed.get(context.session.id)
      precomputed.delete(context.session.id)
      activePrecomputeFibers.delete(context.session.id)
      const native = context.model.compaction?.type === "native"
      const model = yield* selectModel(context, settings.buffer, native)
      // The provider just rejected this context, so the estimate ran low; the first attempt already aims below it.
      const budget =
        trigger.reason === "overflow"
          ? Math.min(model.cap, Math.floor(total(trigger.estimate ?? estimatePrompt(context)) * SHRINK_STEPS[0]))
          : model.cap

      const selected = model.context === context ? trigger : { ...trigger, context: model.context }
      // The runner opened the manual compaction's message when it delivered the `/compact` item. An automatic one
      // opens here, before any wait, so a background summary still being written shows as a running compaction.
      if (trigger.reason !== "manual")
        yield* bus.publish(SessionEvent.Compaction.Started, { sessionID: context.session.id, reason: "auto" })
      const traceEnabled = AquanoxTrace.isEnabled()
      const compactCorr = traceEnabled ? AquanoxTrace.resolveSessionCorrelationSync(selected.context.session) : undefined
      const compactSpanId = traceEnabled ? AquanoxTrace.newSpanId("sp_oc_compact") : undefined
      const compactParentSpanId = compactCorr
        ? (AquanoxTrace.getActiveTurnSpan(context.session.id) ?? compactCorr.parentTurnSpanId)
        : null
      const compactStartUs = traceEnabled ? AquanoxTrace.nowUs() : 0
      const compactModelLabel = `${selected.context.model.ref.providerID}/${selected.context.model.ref.id}`
      const compactThinkingMode = selected.context.model.ref.variant ?? compactCorr?.thinkingMode ?? null
      if (compactCorr && compactSpanId) {
        AquanoxTrace.setActiveCompactSpan(context.session.id, compactSpanId)
        yield* AquanoxTrace.postTraceIngest({
          span: {
            spanId: compactSpanId,
            conversationId: compactCorr.conversationId,
            parentSpanId: compactParentSpanId,
            rootSessionId: compactCorr.rootSessionId,
            sessionId: context.session.id,
            parentSessionId: compactCorr.parentSessionId,
            layer: "opencode",
            kind: "llm.compact",
            name: `compact (${trigger.reason})`,
            status: "running",
            startUs: compactStartUs,
            model: compactModelLabel,
            thinkingMode: compactThinkingMode,
            agentName: selected.context.agent.id,
            isSubagent: compactCorr.isSubagent,
            contextWindowLimit: selected.context.model.limit.context > 0 ? selected.context.model.limit.context : null,
            attributes: { reason: trigger.reason, native },
          },
        })
      }
      const emitCompactEnd = (status: "ok" | "error" | "cancelled") => {
        if (!compactCorr || !compactSpanId) return Effect.void
        if (AquanoxTrace.getActiveCompactSpan(context.session.id) === compactSpanId) {
          AquanoxTrace.setActiveCompactSpan(context.session.id, null)
        }
        const compactEndUs = AquanoxTrace.nowUs()
        const metrics = AquanoxTrace.usageMetrics(
          spent.get(context.session.id)?.tokens,
          selected.context.model.limit.context,
        )
        return AquanoxTrace.postTraceIngest({
          span: {
            spanId: compactSpanId,
            conversationId: compactCorr.conversationId,
            parentSpanId: compactParentSpanId,
            rootSessionId: compactCorr.rootSessionId,
            sessionId: context.session.id,
            parentSessionId: compactCorr.parentSessionId,
            layer: "opencode",
            kind: "llm.compact",
            name: `compact (${trigger.reason})`,
            status,
            startUs: compactStartUs,
            endUs: compactEndUs,
            durationMs: AquanoxTrace.durationMs(compactStartUs, compactEndUs),
            model: compactModelLabel,
            thinkingMode: compactThinkingMode,
            agentName: selected.context.agent.id,
            isSubagent: compactCorr.isSubagent,
            ...metrics,
            attributes: { reason: trigger.reason, native },
          },
        })
      }
      const swapped = held ? yield* usePrecomputed(selected, held, budget, settings) : undefined
      const compaction = swapped
        ? Effect.succeed(swapped)
        : native
          ? compactNatively(selected, budget, settings.keep)
          : summarize(selected, budget, settings.keep)
      return yield* compaction.pipe(
        Effect.matchEffect({
          onSuccess: (result) => publish(selected, result),
          onFailure: (failure) => publish(selected, failure),
        }),
        Effect.onExit((exit) => {
          if (Exit.isFailure(exit)) {
            return emitCompactEnd(Exit.hasInterrupts(exit) ? "cancelled" : "error")
          }
          return emitCompactEnd(exit.value.status === "failed" ? "error" : "ok")
        }),
      )
    })

    /**
     * Once the context passes `PRECOMPUTE_RATIO` of the ceiling, summarizes everything before the latest response in
     * the background. That is the prefix the provider just processed, so the summary request reads it from the prompt
     * cache. The summary is held, not applied: swapping it in now would rewrite the prefix and throw away the cache
     * for every step until compaction is actually due. One summary is held per Session until compaction takes it, or
     * until it fails or falls too far behind, when a newer response replaces it.
     */
    const precompute = Effect.fn("SessionCompaction.precompute")(function* <E>(
      load: Effect.Effect<SessionContext.Loaded, E>,
      given?: Estimate,
    ) {
      const settings = state.get()
      if (!shouldPrecompute(settings)) return
      const context = yield* load
      const isDeepSeekLocal = String(context.model.ref.providerID) === "deepseek-local"
      if (context.model.compaction?.type === "native") return
      const ceiling = calculateCeiling(
        context.model.limit,
        settings.buffer,
        context.model.ref.providerID,
        sessionCeilingOptions(context.session),
      )
      if (!Number.isFinite(ceiling)) return
      const estimate = given ?? estimatePrompt(context)
      if (due(context, ceiling, estimate)) return
      if (
        isDeepSeekLocal &&
        Boolean(context.session.parentID) &&
        ceiling <= 24_576 &&
        estimateConversationMessageTokens(context.messages) < 4_096
      ) {
        return
      }
      if (isDeepSeekLocal) {
        const floor = Math.floor(ceiling * PRECOMPUTE_RATIO)
        if (total(estimate) < floor) return
      } else {
        if (total(estimate) < ceiling * PRECOMPUTE_RATIO) return
      }

      const anchorIndex = context.messages.findLastIndex((message) => hasMeasuredPrompt(message, context.model.ref))
      const anchor = context.messages[anchorIndex]
      if (anchorIndex <= 0 || anchor?.type !== "assistant" || !anchor.tokens) return
      if (anchor.tokens.input + anchor.tokens.cache.read + anchor.tokens.cache.write < PRECOMPUTE_MIN_TOKENS) return

      const sessionID = context.session.id
      const existing = precomputed.get(sessionID)
      const exit = existing?.fiber.pollUnsafe()
      const failed = exit !== undefined && Exit.isFailure(exit)
      const failures = (existing?.failures ?? 0) + (failed ? 1 : 0)
      if (existing) {
        const index = heldIndex(existing, context)
        if (index >= 0 && !failed && tailTokens(context, index) <= existing.tailLimit) return
        // Summarizing up to the same response again would repeat the same request.
        if (index >= 0 && (existing.keepID === anchor.id || failures >= PRECOMPUTE_MAX_FAILURES)) return
        yield* Fiber.interrupt(existing.fiber)
        precomputed.delete(sessionID)
        activePrecomputeFibers.delete(sessionID)
      }
      // After a model switch nothing is cached for the new model yet; wait until its first response has written it.
      if (anchor.model.id !== context.model.ref.id || anchor.model.variant !== context.model.ref.variant) return

      const model = yield* selectModel(context, settings.buffer, false)
      const usage: SessionUsage.Recorded[] = []
      const fiber = yield* summarize({ reason: "auto", context: model.context }, model.cap, settings.keep, {
        messages: context.messages.slice(0, anchorIndex),
        usage: (recorded) => usage.push(recorded),
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (activePrecomputeFibers.get(sessionID) === fiber) {
              activePrecomputeFibers.delete(sessionID)
            }
          }),
        ),
        Effect.forkIn(scope),
      )
      activePrecomputeFibers.set(sessionID, fiber)
      precomputed.set(sessionID, {
        firstID: context.messages[0]?.id,
        keepID: anchor.id,
        model: context.model.ref,
        initial: context.initial,
        tailLimit: tailLimit(settings.keep, model.cap),
        failures,
        usage,
        fiber,
      })
    })

    /**
     * The held summary plus everything since it, kept verbatim, when it still describes this conversation and that
     * tail is short. Waits for a summary still being written. Undefined, after stopping the background work, when it
     * cannot be used; compaction then summarizes as usual.
     */
    const usePrecomputed = Effect.fnUntraced(function* (
      trigger: Trigger,
      held: Precomputed,
      budget: number,
      settings: Settings,
    ): Effect.fn.Return<Result | undefined> {
      const context = trigger.context
      const index = heldIndex(held, context)
      const isDeepSeekLocal = String(context.model.ref.providerID) === "deepseek-local"
      const usable =
        (settings.precompute || isDeepSeekLocal) &&
        trigger.reason !== "overflow" &&
        context.model.compaction?.type !== "native" &&
        index >= 0 &&
        tailTokens(context, index) <= tailLimit(settings.keep, budget)
      if (!usable) {
        yield* Fiber.interrupt(held.fiber)
        return undefined
      }

      const exit = yield* Fiber.await(held.fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(held.fiber)))
      if (Exit.isFailure(exit)) return undefined
      // Background calls were billed as they finished; the compaction's message still shows what it cost.
      held.usage.forEach((usage) => addSpent(context.session.id, usage))
      return { ...exit.value, metadata: { keepID: held.keepID, ...exit.value.metadata } }
    })

    /**
     *   first:  [E1 … E8][E9 E10]                  →  [S1 + "E9 E10"]
     *   again:  [S1 + "E9 E10"][E11 … E18][E19]    →  [S2 + "E19"]      S2 covers the whole current conversation
     *
     * The model is sent the whole conversation, including the tail kept beside the summary, then the summary prompt.
     * Keeping the normal request's prefix intact lets the summary reuse its prompt cache:
     *
     *   [system][S1 + "E9 E10"][E11 … E18][E19][prompt]    plus one nudge if the reply skips the template
     *
     * Later requests open with the checkpoint as one user message:
     *
     *   <conversation-checkpoint>
     *     <summary>S2</summary>
     *     <recent-context>E19</recent-context>
     *   </conversation-checkpoint>
     *   [new messages…]
     *
     * E = one exchange: a user message and the replies to it. S = a summary. [S + "…"] = one checkpoint: a summary
     * plus the newest `keep` tokens of messages, referenced by their first message and sent as text.
     */
    const summarize = Effect.fnUntraced(function* (
      trigger: Trigger,
      budget: number,
      keep: number,
      background?: Background,
    ): Effect.fn.Return<Result, Failure> {
      const context = trigger.context
      const messages = background?.messages ?? context.messages
      const split = splitConversation(messages, keep)
      if (split === undefined) return yield* Effect.fail(NOTHING_TO_COMPACT)
      // A background summary covers all of its messages; what follows them is kept when it is swapped in.
      const keepID = background ? undefined : split.keepID

      const previous = previousCompaction(messages)
      const prompt = buildPrompt(previous !== undefined, previous?.summary.includes(LEGACY_HEADING) ?? false)
      const headings = SUMMARY_TEMPLATE.split("\n").filter((line) => line.startsWith("##"))
      const filled = (text: string) => text.split("\n").some((line) => headings.includes(line.trim()))
      const isSubagent = Boolean(context.session.parentID)

      return yield* withCompactionLeaseAndTurnstile(
        {
          sessionID: context.session.id,
          isSubagent,
          parentSessionID: context.session.parentID ? String(context.session.parentID) : undefined,
          localSlotBudgeted: isLocalSlotBudgetedModel(context),
          allowReentrantTurnstile: trigger.reason === "overflow",
        },
        (leasedSlot, turnstileSessionKey) =>
          Effect.gen(function* () {
            const prepared = yield* prepare(context, messages, budget, undefined, leasedSlot)
            // Size the unchanged request with the number that decided to compact: the last response's count plus an
            // estimate of what came after it. Characters overstate a conversation whose old reasoning the provider drops.
            // A hook can still make this request larger than that count; the provider then rejects it and it is resent as
            // text. An overflow already proved the count low, so it keeps the character estimate.
            const measured = trigger.reason === "overflow" ? undefined : measuredPrompt({ ...context, messages })

            // Hooks saw the request without the summary prompt, so it is appended here. A reply that ignores the
            // template gets one reminder before it counts as a failure.
            const send = (request: LLMRequest, size?: Estimate) =>
              Effect.gen(function* () {
                const prompted = fitOutput(
                  LLMRequest.update(request, { messages: [...request.messages, Message.user(prompt)] }),
                  context.model.limit,
                  size && { ...size, estimated: size.estimated + Token.estimate(prompt) },
                )
                const reply = yield* stream(
                  context,
                  prompted,
                  prepared.options,
                  background,
                  leasedSlot,
                  turnstileSessionKey,
                )
                if (filled(reply.text)) return reply

                const nudged = fitOutput(
                  LLMRequest.update(prompted, { messages: [...prompted.messages, Message.user(NUDGE)] }),
                  context.model.limit,
                  size && { ...size, estimated: size.estimated + Token.estimate(prompt) + Token.estimate(NUDGE) },
                )
                const retry = yield* stream(
                  context,
                  nudged,
                  prepared.options,
                  background,
                  leasedSlot,
                  turnstileSessionKey,
                )
                if (filled(retry.text)) return retry
                return yield* Effect.fail<Failure>({
                  error: {
                    type: "compaction.failed",
                    message: retry.text.trim()
                      ? "Compaction summary did not match the required template"
                      : "Compaction produced no summary",
                  },
                })
              })

            const overhead = Token.estimate(prompt) + Token.estimate(NUDGE)
            // Automatic compaction starts past the ceiling, so the whole conversation is sent unchanged while the window can
            // still fit the summary. Below that, the history before the tail is sent instead, as before: unchanged when it fits,
            // which still reuses the cache for that shorter prefix, and as text otherwise. Dropping exchanges to make room
            // for the tail would leave them in neither the summary nor the tail. Where 15% of the window is under
            // `RESERVE_MIN`, the ceiling equals `summaryRoom`, so automatic compaction always takes this fallback.
            const fit =
              trigger.reason === "overflow"
                ? budget
                : Math.max(budget, summaryRoom(context.model.limit, prepared.request.generation?.maxTokens))
            const result = yield* deliver(
              trigger,
              prepared,
              budget - overhead,
              send,
              {
                fit: fit - overhead,
                history: attachSlotToRequest(withoutTail(prepared.request, keepID), leasedSlot),
                measured,
              },
              background,
            )
            if (!keepID) return result
            // A compaction hook may choose its own kept range.
            return { ...result, metadata: { keepID, ...result.metadata } }
          }),
      )
    })

    /**
     *   endpoint:  [window]                      →  [U U][item]    the provider picks which messages to keep
     *   trigger:   [window][compaction_trigger]  →  [item]
     *                                            →  [U U][item]    we add the newest user messages within `keep`
     *
     * Later requests open with that replacement window in place of the history it covers:
     *
     *   [U U][item][new messages…]
     *
     * window = the previous compaction and everything since. item = one encrypted compaction item, which only
     * replays on the model that made it. U = a user message as typed.
     */
    const compactNatively = Effect.fnUntraced(function* (
      trigger: Trigger,
      budget: number,
      keep: number,
    ): Effect.fn.Return<Result, Failure> {
      const context = trigger.context
      if (!context.messages.some(SessionRecentText.messageToText)) return yield* Effect.fail(NOTHING_TO_COMPACT)
      const unsupported = (message: string) =>
        Effect.fail<Failure>({ error: { type: "provider.unsupported-operation", message } })
      const isSubagent = Boolean(context.session.parentID)

      return yield* withCompactionLeaseAndTurnstile(
        {
          sessionID: context.session.id,
          isSubagent,
          parentSessionID: context.session.parentID ? String(context.session.parentID) : undefined,
          localSlotBudgeted: isLocalSlotBudgetedModel(context),
          allowReentrantTurnstile: trigger.reason === "overflow",
        },
        (leasedSlot) =>
          Effect.gen(function* () {
            const prepared = yield* prepare(context, context.messages, budget, "session", leasedSlot)

            const toResult = (window: ReadonlyArray<Message>, usage: Usage | undefined) =>
              spend(context.session.id, usage && SessionUsage.record(usage, context.model.cost)).pipe(
                Effect.as<Result>({
                  text: "",
                  // Plain JSON, not the schema encoder: provider metadata can hold undefined entries, which it rejects.
                  native: { messages: JSON.parse(JSON.stringify(window)) },
                }),
              )

            const send = (request: LLMRequest) => {
              const reqWithSlot = attachSlotToRequest(request, leasedSlot)
              const optsWithSlot = attachSlotToOptions(prepared.options, leasedSlot)
              if (LLMClient.canCompact(reqWithSlot, { mechanism: "trigger" })) {
                return Effect.gen(function* () {
                  const history = yield* SessionHistory.load(db, context.session.id, "local").pipe(Effect.orDie)
                  const retained = recentUserMessages(history, context.model, keep)
                  const response = yield* llm.compact(reqWithSlot, { ...optsWithSlot, mechanism: "trigger" })
                  return yield* toResult([...retained, Message.assistant(response.checkpoint)], response.usage)
                })
              }
              if (LLMClient.canCompact(reqWithSlot)) {
                return llm
                  .compact(reqWithSlot, { mechanism: "endpoint", http: optsWithSlot.http })
                  .pipe(Effect.flatMap((response) => toResult(response.replacement, response.usage)))
              }
              return unsupported(
                `Native compaction is not supported for ${reqWithSlot.model.provider}/${reqWithSlot.model.route.id}`,
              )
            }

            return yield* deliver(trigger, prepared, budget, send)
          }),
      )
    })

    /**
     * Sends the request as-is if it is estimated to fit `shrink.fit`, else `shrink.history` as-is if it fits `target`,
     * and otherwise `shrink.history` as text aimed at `target` (see `flattenAndDropOldest`). `shrink.measured`, when
     * given, sizes the unchanged request until the provider rejects it; after that it is only sent as text.
     * Limits and estimates can be wrong, so until the provider rejects something as too long, a request that cannot
     * be made to fit is sent whole: unchanged, or as text once its media has to go. A "too long" rejection means the
     * estimate ran low, so the next attempts aim at 85%, 70%, 50%, then 35% of the first rejected request's estimate,
     * each shortening the transcript again from scratch, and a rejection after those gives up. A "payload too large"
     * rejection is about bytes, which inline media almost always accounts for, so one on the unchanged request resends
     * it as text, which carries no media, without counting; one on text counts as "too long". Other provider errors
     * resend the same request under the session's retry policy. A `Failure` from `send` is a reply that cannot be
     * used, and is never retried.
     */
    const deliver = Effect.fnUntraced(function* (
      trigger: Trigger,
      prepared: Prepared,
      target: number,
      send: (request: LLMRequest, size?: Estimate) => Effect.Effect<Result, AIError | Failure>,
      shrink: { readonly fit: number; readonly history: LLMRequest; readonly measured?: Estimate } = {
        fit: target,
        history: prepared.request,
      },
      background?: Background,
    ): Effect.fn.Return<Result, Failure> {
      const context = trigger.context
      if (prepared.event.result) return yield* fromHook(context, prepared.event.result, background)

      const policy = yield* SessionRunnerRetry.policy(context.session.id)
      let rejections = 0
      let rejected: number | undefined
      let asText = false
      let fit = shrink.fit

      while (true) {
        const measured = rejections === 0 ? shrink.measured : undefined
        const unchanged = asText
          ? undefined
          : (measured ? total(measured) : estimateRequest(prepared.request)) <= fit
            ? prepared.request
            : estimateRequest(shrink.history) <= target
              ? shrink.history
              : undefined
        const request =
          unchanged ??
          flattenAndDropOldest(shrink.history, context, target) ??
          (rejections > 0
            ? undefined
            : asText
              ? flattenAndDropOldest(shrink.history, context, Number.POSITIVE_INFINITY)
              : shrink.history)
        if (!request) {
          return yield* Effect.fail<Failure>({
            error: {
              type: "compaction.failed",
              message:
                "The compaction request cannot be reduced further without losing the latest exchange or checkpoint",
            },
          })
        }

        const size = request === prepared.request ? measured : undefined
        const attempt = yield* Effect.result(send(request, size))
        if (Result.isSuccess(attempt)) return attempt.success
        const cause = attempt.failure
        if (!(cause instanceof AIError)) return yield* Effect.fail(cause)
        const error = toSessionError(cause)
        const tooLarge = cause.reason._tag === "InvalidRequest" && cause.reason.classification === "payload-too-large"

        if (tooLarge && (request === prepared.request || request === shrink.history)) {
          asText = true
          continue
        }

        if (tooLarge || isContextOverflowFailure(cause)) {
          const step = SHRINK_STEPS[rejections]
          if (step === undefined) return yield* Effect.fail<Failure>({ error })
          rejected ??= size ? total(size) : estimateRequest(request)
          // The characters can still say the rejected request fits, so it only goes out again as text.
          if (size) asText = true
          target = Math.floor(rejected * step)
          fit = target
          rejections++
          continue
        }

        const decision = yield* policy({
          cause,
          error,
          agent: context.agent.id,
          model: context.model.ref,
          hook: prepared.retry,
          retry: SessionRunnerRetry.isRetryable(cause),
        })
        if (!decision.retry) return yield* Effect.fail<Failure>({ error })
        yield* Effect.sleep(decision.delay)
      }
    })

    /**
     * History that has to change is sent as text rather than as edited messages: `[previous compaction][transcript]`,
     * the conversation since that compaction as one text message. A previous summary always stays in front, while
     * its verbatim recent part becomes the oldest transcript entry; a previous native window stays exactly as the
     * provider made it. The transcript has no tool definitions, which the summary does not need and which no longer
     * share a cached prefix, and leaves out reasoning, media, and instruction updates.
     *
     * When the whole transcript does not fit, exchanges are shortened oldest first, one level at a time, until it
     * does (see `flattenMessage` for the levels): every exchange reaches a level before any reaches the next, so
     * detail is lost from the oldest history first and whole exchanges are omitted only as a last resort. The newest
     * exchange is never omitted; undefined when the transcript cannot fit even so.
     */
    const flattenAndDropOldest = (request: LLMRequest, context: SessionContext.Loaded, target: number) => {
      const previous = previousCompaction(context.messages)
      const end =
        request.messages.findLastIndex(
          (message) =>
            (previous !== undefined && message.id === previous.id) ||
            message.content.some((part) => part.type === "compaction"),
        ) + 1
      const summary = previous !== undefined && !SessionHistory.isNativeCompaction(previous) ? previous : undefined
      // TODO: Read the previous summary from the hooked request once it no longer merges summary and recent into one
      // message. Until then it is rebuilt from storage, which drops a compaction hook's edits to that message.
      const lead = summary
        ? toLLMMessages([{ ...summary, metadata: { ...summary.metadata, recent: "" } }], context.model.ref)
        : request.messages.slice(0, end)
      const recent = summary ? SessionRecentText.kept(summary) : ""

      // A user message and everything after it, up to the next one, is one exchange. Each is rendered at every level
      // once, so shortening is running arithmetic over these sizes. The previous summary's recent part is already
      // shortened text: whole until it is omitted.
      const exchanges = [
        ...(recent ? [TRANSCRIPT_LEVELS.map((level) => (level === OMITTED ? "" : recent))] : []),
        ...request.messages
          .slice(end)
          .reduce<Message[][]>((groups, message) => {
            if (message.role === "user" || groups.length === 0) groups.push([message])
            else groups[groups.length - 1].push(message)
            return groups
          }, [])
          .map((group) =>
            TRANSCRIPT_LEVELS.map((level) =>
              group
                .map((message) => flattenMessage(message, level))
                .filter(Boolean)
                .join("\n"),
            ),
          )
          .filter((renders) => renders[0]),
      ]
      if (exchanges.length === 0) return undefined
      const note = (omitted: number) =>
        omitted ? `[${omitted} older ${omitted === 1 ? "exchange" : "exchanges"} omitted]\n\n` : ""
      const size = (text: string) => (text ? Token.estimate(text) + 1 : 0)
      // Room for the longest possible note is set aside before choosing what to keep.
      const room =
        target -
        estimateRequest({ system: request.system, tools: [], messages: lead }) -
        Token.estimate(note(exchanges.length))

      const levels = exchanges.map(() => 0)
      let total = exchanges.reduce((sum, renders) => sum + size(renders[0]), 0)
      const newest = exchanges.length - 1
      for (const level of TRANSCRIPT_LEVELS.slice(1)) {
        for (let index = 0; index < exchanges.length && total > room; index++) {
          // The newest exchange is what the summary most needs; it is shortened but never left out.
          if (index === newest && !exchanges[index][level]) continue
          total += size(exchanges[index][level]) - size(exchanges[index][levels[index]])
          levels[index] = level
        }
      }
      if (total > room) return undefined

      // Includes exchanges with no user text, which are already gone at `USER_ONLY`.
      const omitted = levels.filter((level, index) => !exchanges[index][level]).length
      const text = exchanges
        .map((renders, index) => renders[levels[index]])
        .filter(Boolean)
        .join("\n\n")
      return LLMRequest.update(request, { tools: [], messages: [...lead, Message.user(note(omitted) + text)] })
    }

    const stream = (
      context: SessionContext.Loaded,
      request: LLMRequest,
      options: StreamOptions,
      background?: Background,
      leasedSlot?: number,
      turnstileSessionKey?: string,
    ) => {
      const sessionID = context.session.id
      const isSubagent = Boolean(context.session.parentID)
      const unusable = (error: SessionError.Error) => Effect.fail<Failure>({ error })
      const slot = extractCompactionSlot({
        sessionId: sessionID,
        request,
        options,
        leasedSlot,
      })
      const requestWithSlot = attachSlotToRequest(request, slot)
      const optionsWithSlot = attachSlotToOptions(options, slot)

      const execution = Effect.suspend(() => {
        if (slot !== undefined && slot >= 0 && SessionSlotLease.isActivelyHeld(sessionID) === undefined) {
          SessionSlotLease.acquire(sessionID, isSubagent)
        }
        return llm.stream(requestWithSlot, optionsWithSlot).pipe(
          Stream.runFoldEffect(
            (): Streamed => ({ text: "" }),
            (streamed, event): Effect.Effect<Streamed, AIError | Failure> => {
              if (LLMEvent.is.providerError(event)) {
                if (event.classification === undefined)
                  return unusable({ type: "provider.error", message: event.message })
                return Effect.fail(
                  new AIError({
                    reason: new InvalidRequestError({ message: event.message, classification: event.classification }),
                  }),
                )
              }

              if (LLMEvent.is.textDelta(event)) {
                const next = { ...streamed, text: streamed.text + event.text }
                if (background) return Effect.succeed(next)
                return bus.publish(SessionEvent.Compaction.Delta, { sessionID, text: event.text }).pipe(Effect.as(next))
              }

              if (LLMEvent.is.stepFinish(event)) {
                return spend(sessionID, SessionUsage.record(event.usage, context.model.cost), background?.usage).pipe(
                  Effect.as(streamed),
                )
              }

              if (!LLMEvent.is.finish(event)) return Effect.succeed(streamed)
              switch (event.reason.normalized) {
                case "unknown":
                  return Effect.fail(
                    new AIError({
                      reason: new InvalidProviderOutputError({
                        message: "The provider response ended with an unknown finish reason.",
                        classification: "incomplete-stream",
                      }),
                    }),
                  )
                case "error":
                  return Effect.fail(
                    new AIError({ reason: new UnknownProviderError({ message: "Compaction generation failed" }) }),
                  )
                case "length":
                  return unusable({
                    type: "compaction.failed",
                    message: "Compaction summary reached the output token limit",
                  })
                case "content-filter":
                  return unusable(contentFilterError("Compaction summary was blocked by the provider", event.reason))
                default:
                  return Effect.succeed(streamed)
              }
            },
          ),
        )
      })

      const effectiveTurnstileKey = turnstileSessionKey ?? `${sessionID}:background_compaction`
      return SessionSlotLease.withComputeTurnstile(effectiveTurnstileKey, slot, () => execution)
    }

    /**
     * The conversation as the runner would send it, after request hooks.
     *
     * The output limit leaves room for `budget`, the most `deliver` sends. The request prepared here can be larger
     * when the conversation overshot the threshold, and is only shrunk to fit after hooks have seen it, so sizing the
     * output to it would leave next to no room. A prompt the estimate undersells is rejected and shrunk like any
     * other.
     */
    const prepare = (
      context: SessionContext.Loaded,
      messages: ReadonlyArray<SessionMessage.Info>,
      budget: number,
      webSocket?: "session",
      preLeasedSlot?: number,
    ) => {
      const base = transcript(context, messages)
      const traceActive =
        AquanoxTrace.isEnabled() || AquanoxTrace.hasExplicitCorrelation(context.session.id, context.session.metadata)
      const corr = traceActive ? AquanoxTrace.resolveSessionCorrelationSync(context.session) : undefined
      const localSlotBudgeted = isLocalSlotBudgetedModel(context)
      const isSubagent = Boolean(context.session.parentID)
      const managedExternally = preLeasedSlot !== undefined && preLeasedSlot >= 0
      const existingSlot = managedExternally
        ? preLeasedSlot
        : localSlotBudgeted
          ? SessionSlotLease.isActivelyHeld(context.session.id)
          : extractCompactionSlot(context.session.id)
      const wasAlreadyHeldByTurn = managedExternally || (existingSlot !== undefined && existingSlot >= 0)
      const syncSlot =
        localSlotBudgeted && !wasAlreadyHeldByTurn
          ? SessionSlotLease.acquire(context.session.id, isSubagent)
          : undefined
      const leasedSlot = wasAlreadyHeldByTurn
        ? existingSlot
        : syncSlot !== undefined && syncSlot >= 0
          ? syncSlot
          : undefined

      const makeCompactionEffect = (slotForRequest: number | undefined) => {
        if (
          slotForRequest !== undefined &&
          slotForRequest >= 0 &&
          SessionSlotLease.isActivelyHeld(context.session.id) === undefined
        ) {
          SessionSlotLease.acquire(context.session.id, isSubagent)
        }
        const effectiveModel =
          localSlotBudgeted && SessionSlotLease.isBackendReconciled()
            ? {
                ...context.model,
                limit: {
                  ...context.model.limit,
                  context: SessionSlotLease.getEffectiveSlotContextLimit(
                    slotForRequest,
                    isSubagent ? (SessionSlotLease.getSessionTier(context.session.id) ?? "128k") : "384k",
                    context.model.limit.context,
                  ),
                },
              }
            : context.model
        return requests
          .compaction({
            session: context.session,
            agent: context.agent.id,
            model: effectiveModel,
            tools: context.tools,
            system: base.system,
            messages: base.messages,
            webSocket,
            inputTokens: { measured: budget, estimated: 0 },
            ...(slotForRequest !== undefined && slotForRequest >= 0
              ? {
                  httpBody: {
                    id_slot: slotForRequest,
                    ...(localSlotBudgeted ? { reasoning_budget_tokens: 2048 } : {}),
                  },
                }
              : {}),
            ...(corr
              ? {
                  aquanox: {
                    conversationId: corr.conversationId,
                    rootSessionId: corr.rootSessionId,
                    parentSpanId:
                      AquanoxTrace.getActiveCompactSpan(context.session.id) ??
                      AquanoxTrace.getActiveTurnSpan(context.session.id) ??
                      corr.parentTurnSpanId,
                    thinkingMode: context.model.ref.variant ?? corr.thinkingMode,
                  },
                }
              : {}),
          })
          .pipe(
            Effect.map((prepared) =>
              slotForRequest !== undefined && slotForRequest >= 0
                ? {
                    ...prepared,
                    request: attachSlotToRequest(prepared.request, slotForRequest),
                    options: attachSlotToOptions(prepared.options, slotForRequest),
                  }
                : prepared,
            ),
          )
      }

      if (localSlotBudgeted && leasedSlot === undefined) {
        if (isSubagent) {
          return SessionSlotLease.withSubagentLease(
            context.session.id,
            (queuedSlot) => {
              if (queuedSlot < 0) {
                return Effect.die(new Error(COMPACTION_SLOT_UNAVAILABLE_ERROR))
              }
              return makeCompactionEffect(queuedSlot)
            },
            { parentSessionID: context.session.parentID ? String(context.session.parentID) : undefined },
          )
        }
        resolveCompactionSlotOrFail(context.session.id, isSubagent)
      }

      const compactionEffect = makeCompactionEffect(leasedSlot)
      return !managedExternally && localSlotBudgeted && !wasAlreadyHeldByTurn && leasedSlot !== undefined && leasedSlot >= 0
        ? compactionEffect.pipe(
            Effect.ensuring(Effect.sync(() => SessionSlotLease.release(context.session.id))),
          )
        : compactionEffect
    }

    /** A request hook supplied the summary itself, so no model call happens. */
    const fromHook = (context: SessionContext.Loaded, supplied: SessionCompactionResult, background?: Background) => {
      const usage = supplied.tokens && {
        tokens: supplied.tokens,
        cost: SessionUsage.calculateCost(context.model.cost, supplied.tokens),
      }
      return spend(context.session.id, usage, background?.usage).pipe(
        Effect.as<Result>({
          text: supplied.summary,
          native: supplied.native,
          metadata: supplied.metadata,
        }),
      )
    }

    /**
     * Each model call is billed as soon as it finishes, so failed and interrupted compactions are billed too. The
     * compaction's message shows the total across all of its calls. A session never runs two compactions at once;
     * a background summary keeps its own total until a compaction takes it.
     */
    const spent = new Map<SessionContext.Loaded["session"]["id"], SessionUsage.Recorded>()
    const addSpent = (sessionID: SessionContext.Loaded["session"]["id"], usage: SessionUsage.Recorded) => {
      const total = spent.get(sessionID)
      spent.set(sessionID, total ? SessionUsage.add(total, usage) : usage)
    }
    const spend = (
      sessionID: SessionContext.Loaded["session"]["id"],
      usage: SessionUsage.Recorded | undefined,
      record = (recorded: SessionUsage.Recorded) => addSpent(sessionID, recorded),
    ) =>
      Effect.gen(function* () {
        if (!usage) return
        record(usage)
        yield* bus.publish(SessionEvent.UsageRecorded, { sessionID, source: "compaction", ...usage })
      })

    const publish = Effect.fnUntraced(function* (
      trigger: Trigger,
      outcome: Result | Failure,
    ): Effect.fn.Return<Outcome> {
      const context = trigger.context
      const sessionID = context.session.id
      const reason = trigger.reason === "manual" ? "manual" : "auto"
      const usage = spent.get(sessionID)

      if ("error" in outcome) {
        yield* bus.publish(SessionEvent.Compaction.Failed, {
          sessionID,
          reason,
          inputID: trigger.reason === "manual" ? trigger.inputID : undefined,
          error: outcome.error,
          ...usage,
        })
        return { status: "failed", error: outcome.error }
      }

      yield* bus.publish(
        SessionEvent.Compaction.Ended,
        {
          sessionID,
          reason,
          model: context.model.ref,
          native: outcome.native,
          text: outcome.text,
          ...usage,
        },
        { metadata: outcome.metadata },
      )
      return { status: "completed" }
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      // A manual compaction settles through its `/compact` inbox item, which the runner owns.
      compact: (trigger) =>
        compact(trigger).pipe(
          Effect.onInterrupt(() =>
            trigger.reason === "manual"
              ? Effect.void
              : publish(trigger, { error: { type: "compaction.interrupted", message: "Compaction was interrupted" } }),
          ),
          Effect.ensuring(Effect.sync(() => spent.delete(trigger.context.session.id))),
        ),
      precompute,
      interruptPrecompute: (sessionID: string) => interruptPrecompute(sessionID),
      awaitPrecompute: (sessionID: string) => awaitPrecompute(sessionID),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Agent.node, Bus.node, Database.node, llmClient, Model.node, SessionModelRequest.node, SessionRunnerModel.node],
})

/**
 * Where the messages kept beside a held summary start, or -1 when the summary no longer describes this
 * conversation: a compaction or revert since replaced its start, or the model or instructions changed.
 */
const heldIndex = (held: Precomputed, context: SessionContext.Loaded) => {
  if (held.firstID !== context.messages[0]?.id || held.initial !== context.initial) return -1
  if (held.model.providerID !== context.model.ref.providerID || held.model.id !== context.model.ref.id) return -1
  if (held.model.variant !== context.model.ref.variant) return -1
  return context.messages.findIndex((message) => message.id === held.keepID)
}

/** Estimated text a swapped-in summary keeps verbatim: every message from `index` on. */
const tailTokens = (context: SessionContext.Loaded, index: number) =>
  Token.estimate(
    context.messages.slice(index).map(SessionRecentText.messageToBudgetText).filter(Boolean).join("\n\n"),
  )

const tailLimit = (keep: number, budget: number) =>
  Math.min(Math.max(keep * 2, PRECOMPUTED_TAIL_MIN), Math.floor(budget * PRECOMPUTED_TAIL_SHARE))

/** History loads from the latest completed compaction, so a previous one is always the first message. */
const previousCompaction = (messages: ReadonlyArray<SessionMessage.Info>) => {
  const [first] = messages
  return first?.type === "compaction" && first.status === "completed" ? first : undefined
}

const transcript = (context: SessionContext.Loaded, messages: ReadonlyArray<SessionMessage.Info>) =>
  SessionModelRequest.baseTranscript({
    agent: context.agent.info,
    model: context.model,
    tools: context.tools,
    initial: context.initial,
    messages,
  })

/**
 * The newest messages within `keep` tokens, from `keepID` on, are kept verbatim beside the summary.
 * Undefined when there is nothing to compact.
 */
const splitConversation = (messages: ReadonlyArray<SessionMessage.Info>, keep: number) => {
  const entries = messages.flatMap((message) => {
    const budgetText = SessionRecentText.messageToBudgetText(message)
    const text = SessionRecentText.messageToText(message)
    return text || budgetText ? [{ message, text: budgetText || text }] : []
  })
  if (entries.length === 0) return undefined

  const first = entries[recentStart(entries, keep, previousCompaction(messages))]
  return {
    keepID: first?.message.id,
  }
}

/** The request without the retained tail, which starts at the message with ID `from`. */
const withoutTail = (request: LLMRequest, from: SessionMessage.ID | undefined) => {
  const index = from === undefined ? -1 : request.messages.findIndex((message) => message.id === from)
  if (index < 0) return request
  // Never split an assistant tool-call message from its trailing `role: "tool"` result messages.
  let end = index
  while (end < request.messages.length && request.messages[end]?.role === "tool") {
    end++
  }
  return LLMRequest.update(request, { messages: request.messages.slice(0, end) })
}

const recentStart = (
  entries: ReadonlyArray<{ readonly message: SessionMessage.Info; readonly text: string }>,
  keep: number,
  previous: SessionMessage.CompactionCompleted | undefined,
) => {
  // Drop the oldest entries until the rest fit the allowance, but always keep the newest one.
  const dropped = Math.min(
    oldestToDrop(entries, (entry) => Token.estimate(entry.text), keep),
    entries.length - 1,
  )

  // Start at a user message so an assistant's tool calls and results stay together.
  const userBoundary = entries.findLastIndex((entry, index) => index <= dropped && entry.message.type === "user")
  if (userBoundary > 0) return userBoundary

  // Everything fits. Keep only the latest exchange rather than duplicating the whole conversation beside the summary.
  const latestUser = entries.findLastIndex((entry) => entry.message.type === "user")
  if (latestUser > 0) return latestUser

  // One exchange, nothing older. Summarize it all and keep nothing, unless a previous summary already
  // kept recent text, in which case keep everything and summarize only the summary before it.
  return previous && SessionRecentText.kept(previous) ? 0 : entries.length
}

const oldestToDrop = <T>(items: ReadonlyArray<T>, size: (item: T) => number, budget: number) => {
  let total = 0
  let start = items.length
  while (start > 0) {
    const next = total + size(items[start - 1])
    if (next > budget) break
    total = next
    start--
  }
  return start
}

/** One request message as transcript lines at a shortening level. Empty for what that level leaves out. */
const flattenMessage = (message: Message, level: number) => {
  if (message.role === "system" || level === OMITTED) return ""
  if (level >= USER_ONLY && message.role !== "user") return ""
  return message.content
    .flatMap((part) => {
      if (part.type === "text") {
        if (!part.text) return []
        const text = level >= USER_ONLY ? clip(part.text) : part.text
        return [`[${message.role === "user" ? "User" : "Assistant"}]: ${text}`]
      }
      if (level >= USER_ONLY) return []
      if (part.type === "media") return [`[${part.media.mediaType} omitted]`]
      if (part.type === "tool-call") {
        const input = JSON.stringify(part.input) ?? ""
        return [`[Assistant tool call]: ${part.name}(${level >= OUTPUTS_REMOVED ? clip(input) : input})`]
      }
      if (part.type !== "tool-result") return []
      const result = part.result
      const label = result.type === "error" ? "Tool error" : "Tool result"
      if (level >= OUTPUTS_REMOVED) return [`[${label} omitted]`]
      const output =
        result.type === "content"
          ? SessionRecentText.serializeToolContent(result.value)
          : typeof result.value === "string"
            ? result.value
            : (JSON.stringify(result.value) ?? "")
      return [`[${label}]: ${level >= OUTPUTS_CLIPPED ? clip(output) : output}`]
    })
    .join("\n")
}

/** `value` cut to `TRANSCRIPT_CLIP` characters from its start and end, never splitting a surrogate pair. */
const clip = (value: string) => {
  if (value.length <= TRANSCRIPT_CLIP) return value
  const chars = Array.from(value)
  if (chars.length <= TRANSCRIPT_CLIP) return value
  const half = TRANSCRIPT_CLIP / 2
  const omitted = chars.length - TRANSCRIPT_CLIP
  return `${chars.slice(0, half).join("")}\n[… ${omitted} characters omitted …]\n${chars.slice(-half).join("")}`
}

/** The newest whole, real user messages within `keep` tokens: no synthetic guidance, no half of an attachment. */
export const recentUserMessages = (
  messages: ReadonlyArray<SessionMessage.Info>,
  model: Pick<SessionContext.Loaded["model"], "ref" | "capabilities">,
  keep: number,
) => {
  const users = messages
    .filter((message) => message.type === "user")
    .map((message) => ({ ...message, skills: undefined }))
  const sendable = SessionModelRequest.boundImages(
    SessionModelRequest.unsupportedParts(toLLMMessages(users, model.ref), model.capabilities),
  )
  return sendable.slice(oldestToDrop(sendable, estimateMessage, keep))
}

export const estimateConversationMessageTokens = (messages: ReadonlyArray<SessionMessage.Info>): number => {
  const lastCompletedCompactionIndex = messages.findLastIndex(
    (msg) => msg.type === "compaction" && msg.status === "completed",
  )
  const slice = lastCompletedCompactionIndex >= 0 ? messages.slice(lastCompletedCompactionIndex + 1) : messages
  let sum = 0
  for (const msg of slice) {
    if (msg.type === "compaction") continue
    const text = SessionRecentText.messageToBudgetText(msg) || SessionRecentText.messageToText(msg) || ""
    if (text) {
      sum += Token.estimate(text)
    }
  }
  return sum
}

export const due = (context: SessionContext.Loaded, ceiling: number, estimate?: Estimate) => {
  const messages = context.messages
  // A compaction just completed; let the runner rebuild the request from it first.
  const last = messages.at(-1)
  if (last?.type === "compaction" && last.status === "completed") return false
  // An encrypted native window estimates as nothing, so wait for a response to measure it.
  const measured = messages.findLastIndex((message) => hasMeasuredPrompt(message, context.model.ref))
  if (measured < messages.findLastIndex(SessionHistory.isNativeCompaction)) return false
  const promptTotal = total(estimate ?? estimatePrompt(context))
  if (promptTotal < ceiling) return false
  if (
    String(context.model.ref.providerID) === "deepseek-local" &&
    Boolean(context.session.parentID) &&
    ceiling <= 24_576
  ) {
    const msgTokens = estimateConversationMessageTokens(messages)
    // When static system + tool schemas (~23.5k tokens) dominate a 32k subagent slot,
    // do not waste ~90s auto-compacting < 4k tokens of conversation while > 4k tokens of slot headroom remain.
    if (msgTokens < 4_096 && promptTotal < ceiling + 4_096) {
      return false
    }
  }
  return true
}

const total = (estimate: Estimate) => estimate.measured + estimate.estimated

export const estimateContext = (context: SessionContext.Loaded) => total(estimatePrompt(context))

/** The size of the prompt `context` sends. */
export const estimatePrompt = (context: SessionContext.Loaded): Estimate => {
  const anchorIndex = context.messages.findLastIndex((message) => hasMeasuredPrompt(message, context.model.ref))
  const anchor = context.messages[anchorIndex]
  const base = transcript(context, context.messages.slice(Math.max(0, anchorIndex)))
  // TODO: Pass compaction history the runner has already shaped. This and `recentUserMessages` repeat the
  // runner's unsupported-media and image-budget passes; here the image budget only sees images since the anchor,
  // so image-heavy sessions can estimate high.
  const sent = SessionModelRequest.boundImages(
    SessionModelRequest.unsupportedParts(base.messages, context.model.capabilities),
  )
  // The anchor's usage covers its own output, but not its local tool results, which the provider never saw.
  const unmeasured = sent.filter((message) => message.role !== "assistant" || message.id !== anchor?.id)

  if (anchor?.type !== "assistant" || !anchor.tokens)
    return {
      measured: 0,
      estimated: estimateRequest({ system: base.system, tools: context.tools.definitions, messages: unmeasured }),
    }

  const tokens = anchor.tokens
  return {
    measured: tokens.input + tokens.cache.read + tokens.cache.write + tokens.output + tokens.reasoning,
    estimated: unmeasured.reduce((sum, message) => sum + estimateMessage(message), 0),
  }
}

/**
 * The largest request the model takes while leaving room for its reply: `RESERVE_SHARE` of the window, or
 * `RESERVE_MIN` when that is more. A summary request that must be shrunk is aimed at the same size. A window too small
 * to give up `RESERVE_MIN` keeps `RESERVE_SHARE`.
 */
export const calculateCeiling = (
  limit:
    | SessionContext.Loaded["model"]["limit"]
    | {
        context?: number
        input?: number
        output?: number
        contextLimit?: number
        outputLimit?: number
        reserveBuffer?: number
      },
  bufferOrProviderID?: number | string,
  providerIDOrOptions?: string | { slotId?: number; tier?: SessionSlotLease.LeaseTier },
  optionsArg?: { slotId?: number; tier?: SessionSlotLease.LeaseTier },
) => {
  const buffer =
    typeof bufferOrProviderID === "number"
      ? bufferOrProviderID
      : typeof (limit as any)?.reserveBuffer === "number"
        ? (limit as any).reserveBuffer
        : undefined
  const providerID =
    typeof bufferOrProviderID === "string"
      ? bufferOrProviderID
      : typeof providerIDOrOptions === "string"
        ? providerIDOrOptions
        : undefined
  const options =
    typeof providerIDOrOptions === "object" && providerIDOrOptions !== null
      ? providerIDOrOptions
      : optionsArg

  // Unknown limits are reported as 0. An unknown input limit falls back to the context window; with no window at
  // all, only a provider rejection can limit the request.
  const rawWindow = (limit as any).input || (limit as any).context || (limit as any).contextLimit || 0
  if (rawWindow <= 0) return Number.POSITIVE_INFINITY

  const isDeepSeekLocal = String(providerID) === "deepseek-local"
  const window =
    isDeepSeekLocal &&
    SessionSlotLease.isBackendReconciled() &&
    (options?.slotId !== undefined || options?.tier !== undefined)
      ? Math.min(rawWindow, SessionSlotLease.getEffectiveSlotContextLimit(options?.slotId, options?.tier, rawWindow))
      : rawWindow

  // 32k dedicated_3gpu subagent quantum: window <= 32,768, default buffer = 8,192 -> ceiling = 24,576
  if (isDeepSeekLocal && window <= 32768) {
    const effectiveBuffer = buffer !== undefined && buffer < window ? Math.min(buffer, 8192) : 8192
    return window - effectiveBuffer
  }

  // 64k dedicated_3gpu 2-quantum slot: window <= 65,536, default buffer = 12,288 -> ceiling = 53,248
  if (isDeepSeekLocal && window <= 65536) {
    const effectiveBuffer = buffer !== undefined && buffer < window ? Math.min(buffer, 12288) : 12288
    return window - effectiveBuffer
  }

  // 96k dedicated_3gpu Lead block: window <= 98,304, 85% floor = 83,558 (buffer = 14,746)
  if (isDeepSeekLocal && window <= 98304) {
    const floor = Math.floor(0.85 * window)
    const maxBuffer = window - floor
    const effectiveBuffer = buffer !== undefined && buffer < window ? Math.min(buffer, maxBuffer) : maxBuffer
    return Math.max(window - effectiveBuffer, floor)
  }

  // 128k dual-tier: effectiveBuffer = 32768, ceiling = window - 32768 = 98304 (skip 0.85 floor clamp)
  if (isDeepSeekLocal && window <= 131072) {
    const effectiveBuffer = buffer !== undefined && buffer < window ? buffer : 32768
    return window - effectiveBuffer
  }

  // 256k tier: window = 262,144, buffer = 38,144 -> ceiling = 224,000
  if (isDeepSeekLocal && window <= 262144) {
    const effectiveBuffer = buffer !== undefined && buffer < window ? buffer : 38144
    return window - effectiveBuffer
  }

  let ceiling =
    buffer !== undefined && buffer < window
      ? window - buffer
      : window - Math.max(Math.floor(window * RESERVE_SHARE), window >= 2 * RESERVE_MIN ? RESERVE_MIN : 0)
  // Ensure deepseek-local never triggers premature < 320K compaction below 0.85 * contextLimit (~334K of 393,216)
  if (isDeepSeekLocal && (((limit as any).context ?? (limit as any).contextLimit ?? 0) > 0 || ((limit as any).input ?? 0) > 0)) {
    const contextLimit = window || 393_216
    const floor = Math.floor(0.85 * contextLimit)
    if (ceiling < floor) {
      ceiling = floor
    }
  }
  return ceiling
}

/**
 * The largest summary request that leaves `RESERVE_MIN` of the window for the summary, or less when the request
 * cannot generate that much. Zero for an unknown window.
 */
const summaryRoom = (limit: SessionContext.Loaded["model"]["limit"], output = RESERVE_MIN) =>
  Math.max(0, (limit.input || limit.context) - Math.min(RESERVE_MIN, output))

/**
 * Another provider's count may describe a native window this model cannot replay. History then holds the original
 * messages that window stood for, which the count leaves out, so only the current provider's counts are trusted.
 */
const hasMeasuredPrompt = (message: SessionMessage.Info, model: SessionContext.Loaded["model"]["ref"]) =>
  message.type === "assistant" &&
  message.model.providerID === model.providerID &&
  !message.error &&
  message.tokens !== undefined &&
  message.tokens.input + message.tokens.cache.read + message.tokens.cache.write > 0

/** The prompt size, only while the model, variant and agent that were measured still match; they shape the request. */
const measuredPrompt = (context: SessionContext.Loaded) => {
  const anchor = context.messages.findLast((message) => hasMeasuredPrompt(message, context.model.ref))
  if (
    anchor?.type !== "assistant" ||
    anchor.model.id !== context.model.ref.id ||
    anchor.model.variant !== context.model.ref.variant ||
    anchor.agent !== context.agent.id
  )
    return undefined
  return estimatePrompt(context)
}

/**
 * `prepare` sizes the output limit for a request of `budget` tokens, but `deliver` can send a larger one when it
 * cannot shrink the conversation further. Lower the limit to the room the request being sent leaves in the window,
 * so the input and the requested output never exceed the window by our own estimate.
 *
 * The limit leaves the same margin for a low estimate that primary requests do. `deliver` aims at about 90% of the
 * window, so that margin alone would cut a summary near its target to the minimum; there it still gets up to
 * `SUMMARY_OUTPUT_FLOOR` of the room left without the margin.
 */
const fitOutput = (request: LLMRequest, limit: SessionContext.Loaded["model"]["limit"], size?: Estimate) => {
  const current = request.generation?.maxTokens
  if (current === undefined) return request
  const input = size ?? { measured: 0, estimated: estimateRequest(request) }
  const maxTokens = Math.min(
    current,
    Math.max(
      SessionModelRequest.outputLimit(limit, input),
      Math.min(SUMMARY_OUTPUT_FLOOR, SessionModelRequest.outputLimit(limit, { measured: total(input), estimated: 0 })),
    ),
  )
  if (maxTokens === current) return request
  return LLMRequest.update(request, { generation: { ...request.generation, maxTokens } })
}

const estimateRequest = (request: Pick<LLMRequest, "system" | "tools" | "messages">) =>
  request.system.reduce((sum, part) => sum + Token.estimate(part.text), 0) +
  request.tools.reduce((sum, tool) => sum + estimateTool(tool), 0) +
  request.messages.reduce((sum, message) => sum + estimateMessage(message), 0)

/** Only what providers receive; `metadata` and `native` stay local. */
const estimateTool = (tool: ToolEntry): number => {
  if (tool.type === "tool") return Token.estimate(tool.name + tool.description + JSON.stringify(tool.inputSchema))
  return (
    Token.estimate(tool.name + (tool.description ?? "")) +
    tool.tools.reduce((sum, entry) => sum + estimateTool(entry), 0)
  )
}

const estimateMessage = (message: Message) => message.content.reduce((sum, part) => sum + estimatePart(part), 0)

const estimatePart = (part: ContentPart): number => {
  // An encrypted native compaction has no locally measurable size.
  if (part.type === "compaction") return Token.estimate(part.text ?? "")
  if (part.type === "effort") return 0
  if (part.type === "text" || part.type === "reasoning") return Token.estimate(part.text)
  if (part.type === "media") return estimateMedia(part.media.mediaType)
  if (part.type === "tool-call") return Token.estimate(part.name + (JSON.stringify(part.input) ?? ""))

  if (part.result.type === "content")
    return part.result.value.reduce(
      (sum, content) => sum + (content.type === "text" ? Token.estimate(content.text) : estimateMedia(content.mime)),
      0,
    )
  const value = part.result.value
  return Token.estimate(typeof value === "string" ? value : (JSON.stringify(value) ?? ""))
}

const estimateMedia = (mime: string) => {
  const type = mime.toLowerCase()
  if (type.startsWith("image/")) return IMAGE_TOKEN_ESTIMATE
  if (type === "application/pdf") return PDF_TOKEN_ESTIMATE
  return 0
}
