export * as SessionRunnerLLM from "./llm.js"

import { Message } from "@opencode/ai/effect"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { Cause, Effect, Exit, FiberMap, Layer } from "effect"
import { Database } from "../../database/database.js"
import { Bus } from "../../bus.js"
import { LocationLifecycle } from "../../location-lifecycle.js"
import { InstructionState } from "../instruction-state.js"
import { AquanoxTrace } from "../aquanox-trace.js"
import { SessionCompaction } from "../compaction.js"
import { SessionContext } from "../context.js"
import { SessionEvent } from "../event.js"
import { SessionInbox } from "../inbox.js"
import { SessionHistory } from "../history.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionModelTransport } from "../model-transport.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"
import { SessionSlotLease } from "../slot-lease.js"
import { SessionStore } from "../store.js"
import { SessionMessageTable } from "../sql.js"
import { SessionTitle } from "../title.js"
import { toSessionError } from "../to-session-error.js"
import { DrainResult, Service, type Interface } from "./index.js"
import type { SessionRunnerModel } from "./model.js"
import { Snapshot } from "../../snapshot.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { llmClient } from "../../effect/app-node-platform.js"
import { StepFailedError } from "../error.js"
import { SessionRunnerRetry } from "./retry.js"
import { SessionStep } from "./step.js"
import { ToolOutput } from "../../tool-output.js"
import { Plugin } from "../../plugin.js"
import { MAX_STEPS_PROMPT } from "./max-steps.js"
import type { Agent } from "../../agent.js"

const CONTINUE_AFTER_INCOMPLETE_STREAM =
  "The previous response was interrupted. Continue from where you left off without repeating completed content."

export const CONTINUE_AFTER_OUTPUT_LIMIT =
  "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces."

export const SUBAGENT_CONTINUE_AFTER_OUTPUT_LIMIT =
  "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Synthesize and complete your final deliverable immediately in a single concise pass without re-running completed tool checks."

/**
 * Statelessly checks whether the current user turn just completed a `request_synthesis`
 * control tool call, flipping the immediately following step into synthesis mode
 * (`toolChoice: "none"` with `tools` kept identical for 100% KV prefix cache reuse).
 */
export const isRequestSynthesisTurn = (messages: ReadonlyArray<SessionMessage.Info>): boolean => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type === "user" || msg.type === "synthetic") return false
    if (msg.type !== "assistant") continue
    const toolParts = msg.content.filter((part): part is SessionMessage.AssistantTool => part.type === "tool")
    if (toolParts.length === 0) {
      if (msg.finish === "length" || msg.error !== undefined) continue
      return false
    }
    return toolParts.some((part) => part.name === "request_synthesis" && part.state.status === "completed")
  }
  return false
}

/**
 * Gates `id_slot` and dynamic `reasoning_budget_tokens` HTTP body overlays exclusively to
 * local `llama-server` / `deepseek-local` models or models whose configured `http.body`
 * defines `reasoning_budget_tokens`, never polluting `mock-local` (:18080) or cloud providers.
 */
export const supportsLocalSlotAndReasoningBudget = (model: SessionRunnerModel.Resolved): boolean => {
  if (String(model.ref.providerID) === "deepseek-local") return true
  const defaultBody = model.model.route.defaults.http?.body
  return (
    defaultBody !== undefined &&
    typeof defaultBody === "object" &&
    defaultBody !== null &&
    "reasoning_budget_tokens" in defaultBody
  )
}

export const FAILURE_DIAGNOSTIC_REGEX =
  /\bnot ok\b|\bFAIL(?:ED)?\b|\bERR_[A-Z0-9_]+|AssertionError|SyntaxError|TypeError|ReferenceError|error TS\d+|exit code [1-9]|Traceback \(most recent/i

export interface CausalStepAnalysis {
  readonly isTurnEntry: boolean
  readonly hasErrorOrDiagnostic: boolean
  readonly previousToolCount: number
  readonly isMultiToolFanIn: boolean
  readonly cumulativeExploratorySteps: number
  readonly isCleanMutatingContinuation: boolean
  readonly isSingleExploratoryContinuation: boolean
}

export const analyzeCausalStep = (messages: ReadonlyArray<SessionMessage.Info>): CausalStepAnalysis => {
  let lastMeaningfulIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const type = messages[i]?.type
    if (type === "user" || type === "synthetic" || type === "assistant" || type === "compaction") {
      lastMeaningfulIndex = i
      break
    }
  }

  if (lastMeaningfulIndex === -1) {
    return {
      isTurnEntry: true,
      hasErrorOrDiagnostic: false,
      previousToolCount: 0,
      isMultiToolFanIn: false,
      cumulativeExploratorySteps: 0,
      isCleanMutatingContinuation: false,
      isSingleExploratoryContinuation: false,
    }
  }

  const lastMsg = messages[lastMeaningfulIndex]!
  if (lastMsg.type !== "assistant") {
    return {
      isTurnEntry: true,
      hasErrorOrDiagnostic: false,
      previousToolCount: 0,
      isMultiToolFanIn: false,
      cumulativeExploratorySteps: 0,
      isCleanMutatingContinuation: false,
      isSingleExploratoryContinuation: false,
    }
  }

  const assistantTools = (lastMsg.content ?? []).filter(
    (part): part is SessionMessage.AssistantTool => part.type === "tool",
  )
  const previousToolCount = assistantTools.length

  const getToolText = (tool: SessionMessage.AssistantTool): string => {
    const parts: string[] = []
    if (tool.state.status === "error" && tool.state.error) {
      parts.push(typeof tool.state.error === "string" ? tool.state.error : tool.state.error.message || "")
    }
    if ("content" in tool.state && tool.state.content) {
      for (const c of tool.state.content) {
        if (c && typeof c === "object" && "text" in c && typeof (c as any).text === "string") {
          parts.push((c as any).text)
        }
      }
    }
    return parts.join("\n")
  }

  const hasErrorOrDiagnostic = assistantTools.some((tool) => {
    if (tool.state.status === "error") return true
    if (tool.name !== "shell" && tool.name !== "bash") return false
    const meta =
      "metadata" in tool.state && typeof tool.state.metadata === "object" && tool.state.metadata !== null
        ? (tool.state.metadata as Record<string, unknown>)
        : undefined
    if (meta?.status === "running") return false
    const exitCode = typeof meta?.exit === "number" ? meta.exit : undefined
    const timedOut = meta?.timeout === true
    const signal = typeof meta?.signal === "string" ? meta.signal : undefined
    if (exitCode === 0 && !timedOut && !signal) return false
    if ((exitCode !== undefined && exitCode !== 0) || timedOut || signal !== undefined) return true
    const text = getToolText(tool)
    return FAILURE_DIAGNOSTIC_REGEX.test(text)
  })

  const isMultiToolFanIn = previousToolCount >= 3

  let turnStartIndex = 0
  for (let i = lastMeaningfulIndex - 1; i >= 0; i--) {
    const type = messages[i]?.type
    if (type === "user" || type === "synthetic" || type === "compaction") {
      turnStartIndex = i + 1
      break
    }
  }

  const mutatingToolNames = new Set(["edit", "write", "patch", "shell", "bash"])
  const exploratoryToolNames = new Set(["read", "grep", "glob", "file_diff", "lsp", "skill"])

  let cumulativeExploratorySteps = 0
  for (let i = turnStartIndex; i <= lastMeaningfulIndex; i++) {
    const msg = messages[i]
    if (msg?.type !== "assistant") continue
    const tools = (msg.content ?? []).filter(
      (part): part is SessionMessage.AssistantTool => part.type === "tool",
    )
    if (tools.length === 0) continue

    const hasMutating = tools.some((t) => mutatingToolNames.has(t.name))
    const hasExploratory = tools.some((t) => exploratoryToolNames.has(t.name))

    if (hasMutating) {
      cumulativeExploratorySteps = 0
    } else if (hasExploratory) {
      cumulativeExploratorySteps++
    }
  }

  const isCleanMutatingContinuation =
    !hasErrorOrDiagnostic &&
    previousToolCount >= 1 &&
    previousToolCount <= 2 &&
    assistantTools.every((t) => mutatingToolNames.has(t.name))

  const isSingleExploratoryContinuation =
    !hasErrorOrDiagnostic &&
    cumulativeExploratorySteps === 1 &&
    assistantTools.every((t) => exploratoryToolNames.has(t.name))

  return {
    isTurnEntry: false,
    hasErrorOrDiagnostic,
    previousToolCount,
    isMultiToolFanIn,
    cumulativeExploratorySteps,
    isCleanMutatingContinuation,
    isSingleExploratoryContinuation,
  }
}

export const computeCausalReasoningBudget = (input: {
  readonly messages: ReadonlyArray<SessionMessage.Info>
  readonly variant: string
  readonly configuredBudget?: number
  readonly isSubagent: boolean
  readonly isExplore: boolean
  readonly isSynthesizing: boolean
  readonly stepLimitReached: boolean
}): number => {
  const { variant, configuredBudget, isExplore, isSynthesizing, stepLimitReached, isSubagent } = input

  if (variant === "minimal" || configuredBudget === 0) {
    return 0
  }

  const baseBudget =
    configuredBudget !== undefined && configuredBudget > 0
      ? Math.min(configuredBudget, 2048)
      : variant === "max"
        ? 2048
        : variant === "high" || variant === "subagent-high"
          ? 2048
          : variant === "medium"
            ? 1536
            : 1024

  const analysis = analyzeCausalStep(input.messages)

  let budget: number
  if (variant === "low" || baseBudget <= 1024) {
    if (analysis.isTurnEntry || analysis.hasErrorOrDiagnostic) {
      budget = Math.min(baseBudget, 1024)
    } else if (isSynthesizing || analysis.isCleanMutatingContinuation || analysis.isMultiToolFanIn) {
      budget = Math.min(baseBudget, 512)
    } else {
      budget = Math.min(baseBudget, isExplore ? 512 : 256)
    }
  } else {
    if (analysis.isTurnEntry) {
      budget = Math.min(2048, baseBudget)
    } else if (analysis.hasErrorOrDiagnostic) {
      budget = 2048
    } else if (stepLimitReached) {
      budget = 512
    } else if (isSynthesizing) {
      budget = 1024
    } else if (analysis.isCleanMutatingContinuation) {
      budget = 1024
    } else if (analysis.isMultiToolFanIn || analysis.cumulativeExploratorySteps >= 2) {
      budget = 512
    } else if (analysis.isSingleExploratoryContinuation) {
      budget = 256
    } else {
      budget = 512
    }
  }

  if (isSubagent) {
    return Math.min(budget, 2048)
  }
  return budget
}

export const capLiveReconciledReasoningBudget = (
  budget: number,
  input: {
    readonly isSubagent: boolean
    readonly isTurnEntry: boolean
    readonly isSynthesizing: boolean
    readonly hasErrorOrDiagnostic: boolean
  },
): number => {
  if (budget <= 0) return 0
  if (input.isSubagent) {
    return Math.min(budget, 384)
  }
  if (input.isTurnEntry || input.hasErrorOrDiagnostic) {
    return Math.min(budget, 512)
  }
  return Math.min(budget, 256)
}

export const resolveStepRouting = (input: {
  readonly session: SessionSchema.Info
  readonly agent: { readonly id: Agent.ID; readonly info: Agent.Info }
  readonly model: SessionRunnerModel.Resolved
  readonly messages: ReadonlyArray<SessionMessage.Info>
  readonly stepLimitReached: boolean
}): {
  readonly toolChoice: "none" | "auto" | undefined
  readonly httpBody:
    | {
        readonly id_slot: SessionSlotLease.SlotID
        readonly reasoning_budget_tokens: number
        readonly think_temp?: number
        readonly think_min_p?: number
      }
    | undefined
  readonly isSynthesizing: boolean
} => {
  const isSubagent = Boolean(input.session.parentID)
  const isSynthesizing = isRequestSynthesisTurn(input.messages)
  const localBudgeted = supportsLocalSlotAndReasoningBudget(input.model)
  const toolChoice: "none" | "auto" | undefined =
    input.stepLimitReached || isSynthesizing ? "none" : localBudgeted && isSubagent ? "auto" : undefined

  if (!localBudgeted) {
    return { toolChoice, httpBody: undefined, isSynthesizing }
  }

  const id_slot = SessionSlotLease.acquire(input.session.id, isSubagent)
  if (id_slot < 0) {
    throw new Error(`ERR_SLOT_LEASE_REQUIRED: No leased slot available for session ${input.session.id}`)
  }
  const defaultBody = input.model.model.route.defaults.http?.body
  const rawBudget =
    defaultBody !== undefined && typeof defaultBody === "object" && defaultBody !== null
      ? defaultBody["reasoning_budget_tokens"]
      : undefined
  const configuredBudget = typeof rawBudget === "number" ? rawBudget : undefined
  const variant = String(input.model.ref.variant ?? "").toLowerCase()
  const isExplore =
    String(input.agent.id).toLowerCase() === "explore" || String(input.agent.info.name).toLowerCase() === "explore"

  const rawComputedBudget = computeCausalReasoningBudget({
    messages: input.messages,
    variant,
    configuredBudget,
    isSubagent,
    isExplore,
    isSynthesizing,
    stepLimitReached: input.stepLimitReached,
  })

  const analysis = analyzeCausalStep(input.messages)
  const isLiveReconciledRuntime =
    SessionSlotLease.isBackendReconciled() &&
    !process.env.BUN_TEST &&
    process.env.NODE_ENV !== "test" &&
    !process.argv.some((arg) => arg.includes(".test.") || arg === "test")
  const reasoning_budget_tokens = isLiveReconciledRuntime
    ? capLiveReconciledReasoningBudget(rawComputedBudget, {
        isSubagent,
        isTurnEntry: analysis.isTurnEntry,
        isSynthesizing,
        hasErrorOrDiagnostic: analysis.hasErrorOrDiagnostic,
      })
    : rawComputedBudget

  return {
    toolChoice,
    httpBody: {
      id_slot,
      reasoning_budget_tokens,
      think_temp: analysis.hasErrorOrDiagnostic ? 0.85 : 0.55,
      think_min_p: 0.01,
    },
    isSynthesizing,
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const lifecycle = yield* LocationLifecycle.Service
    const store = yield* SessionStore.Service
    const context = yield* SessionContext.Service
    const modelTransport = yield* SessionModelTransport.Service
    const db = (yield* Database.Service).db
    const compaction = yield* SessionCompaction.Service
    const plugins = yield* Plugin.Service
    const title = yield* SessionTitle.Service
    const steps = yield* SessionStep.make
    // Title generation starts once input is visible and must not delay model execution.
    const titles = yield* FiberMap.make<SessionSchema.ID, void, never>()

    const drain = Effect.fn("SessionRunner.drain")(function* (input: Parameters<Interface["drain"]>[0]) {
      const sessionID = input.sessionID
      let force = input.force
      let continuing = input.continuation !== undefined
      let step = input.continuation?.step ?? 1
      let entering = true
      const promotable = input.promotable ?? "input"
      if (!force && !continuing) {
        const pending = yield* SessionInbox.nextPromotable(db, sessionID, "input")
        if (!pending) return DrainResult.Complete()
        const control = pending.type === "compaction" || pending.type === "move"
        if (promotable === "steer" && pending.delivery === "queue" && !control) return DrainResult.Complete()
      }
      yield* plugins.awaitActivation
      yield* settleStaleCompactions(sessionID)
      yield* settleStaleToolCalls(sessionID)

      type ActiveTurnTrace = {
        turnSpanId: string
        startUs: number
        corr: AquanoxTrace.SessionCorrelation
        agentName: string
        modelLabel: string | null
        thinkingMode: string | null
        contextWindowUsed: number | null
        contextWindowLimit: number | null
        promptTokens: number
        cachedTokens: number
        completionTokens: number
        reasoningTokens: number
        contentTokens: number
        hasMetrics: boolean
      }
      let activeTurn: ActiveTurnTrace | null = null
      let isSubagentSession = false

      const ensureTurnStarted = Effect.fnUntraced(function* (
        session: SessionSchema.Info,
        agentName: string,
        modelRef?: { readonly providerID: string; readonly id: string; readonly variant?: string },
      ) {
        if (!AquanoxTrace.isEnabled() || activeTurn !== null) return
        const corr = yield* AquanoxTrace.resolveSessionCorrelation(store, session)
        const turnSpanId = AquanoxTrace.newSpanId("sp_oc_turn")
        const startUs = AquanoxTrace.nowUs()
        const modelLabel = modelRef ? `${modelRef.providerID}/${modelRef.id}` : null
        const thinkingMode = modelRef?.variant ?? corr.thinkingMode ?? null
        activeTurn = {
          turnSpanId,
          startUs,
          corr,
          agentName,
          modelLabel,
          thinkingMode,
          contextWindowUsed: null,
          contextWindowLimit: null,
          promptTokens: 0,
          cachedTokens: 0,
          completionTokens: 0,
          reasoningTokens: 0,
          contentTokens: 0,
          hasMetrics: false,
        }
        AquanoxTrace.setActiveTurnSpan(sessionID, turnSpanId)
        yield* AquanoxTrace.postTraceIngest({
          sessionBinding: {
            sessionId: session.id,
            conversationId: corr.conversationId,
            rootSessionId: corr.rootSessionId,
            parentSessionId: session.parentID ?? null,
            parentSpanId: corr.parentTurnSpanId,
            agentName,
            isSubagent: corr.isSubagent,
            title: session.title ?? null,
          },
          span: {
            spanId: turnSpanId,
            conversationId: corr.conversationId,
            parentSpanId: corr.parentTurnSpanId,
            rootSessionId: corr.rootSessionId,
            sessionId: session.id,
            parentSessionId: session.parentID ?? null,
            layer: "opencode",
            kind: "agent.turn",
            name: corr.isSubagent ? `subagent turn (${agentName})` : `opencode turn (${agentName})`,
            status: "running",
            startUs,
            model: modelLabel,
            thinkingMode,
            agentName,
            isSubagent: corr.isSubagent,
          },
        })
      })

      const finishActiveTurn = (status: "ok" | "error" | "cancelled") => {
        const current = activeTurn
        if (!current) return Effect.void
        activeTurn = null
        if (AquanoxTrace.getActiveTurnSpan(sessionID) === current.turnSpanId) {
          AquanoxTrace.setActiveTurnSpan(sessionID, null)
        }
        const endUs = AquanoxTrace.nowUs()
        return AquanoxTrace.postTraceIngest({
          span: {
            spanId: current.turnSpanId,
            conversationId: current.corr.conversationId,
            parentSpanId: current.corr.parentTurnSpanId,
            rootSessionId: current.corr.rootSessionId,
            sessionId: sessionID,
            parentSessionId: current.corr.parentSessionId,
            layer: "opencode",
            kind: "agent.turn",
            name: current.corr.isSubagent
              ? `subagent turn (${current.agentName})`
              : `opencode turn (${current.agentName})`,
            status,
            startUs: current.startUs,
            endUs,
            durationMs: AquanoxTrace.durationMs(current.startUs, endUs),
            model: current.modelLabel,
            thinkingMode: current.thinkingMode,
            agentName: current.agentName,
            isSubagent: current.corr.isSubagent,
            contextWindowUsed: current.contextWindowUsed,
            contextWindowLimit: current.contextWindowLimit,
            promptTokens: current.hasMetrics ? current.promptTokens : null,
            cachedTokens: current.hasMetrics ? current.cachedTokens : null,
            completionTokens: current.hasMetrics ? current.completionTokens : null,
            reasoningTokens: current.hasMetrics ? current.reasoningTokens : null,
            contentTokens: current.hasMetrics ? current.contentTokens : null,
          },
        })
      }

      const recordTurnMetrics = (
        metrics: ReturnType<typeof AquanoxTrace.usageMetrics>,
        modelLabel: string,
        thinkingMode: string | null,
      ) => {
        if (!activeTurn) return
        activeTurn.modelLabel = modelLabel
        if (thinkingMode) activeTurn.thinkingMode = thinkingMode
        if (metrics.contextWindowLimit !== null) activeTurn.contextWindowLimit = metrics.contextWindowLimit
        if (metrics.contextWindowUsed !== null) {
          activeTurn.contextWindowUsed = metrics.contextWindowUsed
          activeTurn.promptTokens += metrics.promptTokens ?? 0
          activeTurn.cachedTokens += metrics.cachedTokens ?? 0
          activeTurn.completionTokens += metrics.completionTokens ?? 0
          activeTurn.reasoningTokens += metrics.reasoningTokens ?? 0
          activeTurn.contentTokens += metrics.contentTokens ?? 0
          activeTurn.hasMetrics = true
        }
      }

      const advanceToStep = Effect.fn("SessionRunner.advanceToStep")(() =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            while (true) {
              if (lifecycle.isClosed()) {
                yield* restore(modelTransport.close(sessionID))
                return DrainResult.Reloaded({ force, continuation: continuing ? { step } : undefined })
              }
              // Location entry and idle boundaries allow queued controls, not necessarily queued prompts.
              const pending = yield* SessionInbox.serialized(
                sessionID,
                Effect.gen(function* () {
                  const next = yield* SessionInbox.nextPromotable(
                    db,
                    sessionID,
                    entering || !continuing ? "input" : "steer",
                  )
                  if (next?.type === "compaction")
                    yield* bus.publishAll([
                      [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                      [SessionEvent.Compaction.Started, { sessionID, reason: "manual", inputID: next.id }],
                    ])
                  if (next?.type === "move")
                    yield* restore(
                      Effect.gen(function* () {
                        yield* modelTransport.close(sessionID)
                        yield* bus.publishAll([
                          [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                          [SessionEvent.Moved, { sessionID, ...next.payload }],
                        ])
                      }),
                    )
                  return next
                }),
              )
              if (!continuing && pending?.delivery !== "steer") {
                entering = true
                step = 1
              }
              if (pending?.type === "move")
                return DrainResult.Moved({ continuation: continuing ? { step } : undefined })
              if (pending?.type === "compaction") {
                const compacted = yield* restore(
                  Effect.gen(function* () {
                    yield* plugins.awaitActivation
                    const selected = yield* context.select(sessionID)
                    const model = yield* context.resolveModel(selected.session)
                    yield* ensureTurnStarted(selected.session, selected.agent.id, model.ref)
                    // Preview updates without admitting them after the already-delivered compaction marker.
                    const history = yield* SessionHistory.preview(db, sessionID, selected.instructions, model.ref)
                    return yield* compaction.compact({
                      reason: "manual",
                      inputID: pending.id,
                      context: {
                        session: selected.session,
                        agent: selected.agent,
                        tools: selected.tools,
                        model,
                        initial: history.initial,
                        messages: history.messages,
                      },
                    })
                  }).pipe(
                    Effect.catch((error) =>
                      bus.publish(SessionEvent.Compaction.Failed, {
                        sessionID,
                        reason: "manual",
                        inputID: pending.id,
                        error: toSessionError(error),
                      }),
                    ),
                  ),
                ).pipe(Effect.exit)
                if (Exit.isFailure(compacted)) {
                  yield* bus.publish(SessionEvent.Compaction.Failed, {
                    sessionID,
                    reason: "manual",
                    error: Cause.hasInterruptsOnly(compacted.cause)
                      ? { type: "aborted", message: "Compaction cancelled" }
                      : { type: "compaction.failed", message: Cause.pretty(compacted.cause) },
                    inputID: pending.id,
                  })
                  return yield* Effect.failCause(compacted.cause)
                }
                force = false
                continue
              }
              if (!force && !continuing && (!pending || (pending.delivery === "queue" && promotable === "steer")))
                return DrainResult.Complete()
              const ready = yield* restore(
                Effect.gen(function* () {
                  const selected = yield* prepareContext(sessionID)
                  const promoted = yield* SessionInbox.promote(
                    db,
                    bus,
                    sessionID,
                    entering && !continuing ? promotable : "steer",
                  )
                  // A control admitted during context preparation owns this boundary.
                  if (promoted === undefined) return undefined
                  if (promoted > 0 && !selected.session.parentID && SessionTitle.isUntitled(selected.session))
                    yield* FiberMap.run(titles, sessionID, title.generate(sessionID), {
                      onlyIfMissing: true,
                    })
                  if (promoted > 0) step = 1
                  return { _tag: "Ready" as const, context: yield* context.load(selected) }
                }),
              )
              if (ready) return ready
            }
          }),
        ),
      )

      return yield* Effect.gen(function* () {
        while (true) {
          const next = yield* advanceToStep()
          if (next._tag !== "Ready") {
            if (isSubagentSession) {
              SessionSlotLease.releaseSubagentSession(sessionID, { purge: false })
            } else {
              SessionSlotLease.release(sessionID)
            }
            yield* finishActiveTurn("ok")
            return next
          }
          isSubagentSession = Boolean(next.context.session.parentID)
          if (next.context.session.parentID && supportsLocalSlotAndReasoningBudget(next.context.model)) {
            const tier = SessionSlotLease.getSessionTier(next.context.session.id) ?? "128k"
            yield* SessionSlotLease.acquireSubagentAsync({
              sessionID: next.context.session.id,
              parentSessionID: next.context.session.parentID,
              tier,
            })
          }
          yield* ensureTurnStarted(next.context.session, next.context.agent.id, next.context.model.ref)
          continuing = yield* runStep(next.context, step, recordTurnMetrics)
          if (!continuing) {
            yield* compaction.interruptPrecompute(sessionID)
            if (isSubagentSession) {
              SessionSlotLease.releaseSubagentSession(sessionID, { purge: false })
            } else {
              SessionSlotLease.release(sessionID)
            }
            yield* finishActiveTurn("ok")
          }
          step++
          force = false
          entering = false
        }
      }).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            yield* compaction.interruptPrecompute(sessionID)
            if (isSubagentSession || activeTurn?.corr.isSubagent) {
              SessionSlotLease.releaseSubagentSession(sessionID, { purge: false })
            } else {
              SessionSlotLease.release(sessionID)
            }
            return yield* finishActiveTurn(
              Exit.isFailure(exit) ? (Exit.hasInterrupts(exit) ? "cancelled" : "error") : "ok",
            )
          }),
        ),
      )
    })

    const prepareContext = Effect.fn("SessionRunner.prepareContext")(function* (sessionID: SessionSchema.ID) {
      // Plugins can reload mid-turn; each step and retry must read the settled agents, models and skills.
      yield* plugins.awaitActivation
      const selected = yield* context.select(sessionID)
      // A blocked initial instruction baseline must leave admitted input pending.
      yield* InstructionState.prepare(db, bus, selected.instructions, sessionID)
      return selected
    })

    /** Owns logical Step policy; each attempt owns its streaming, tools, and durable settlement. */
    const runStep = Effect.fn("SessionRunner.runStep")(function* (
      first: SessionContext.Loaded,
      step: number,
      onTurnMetrics?: (
        metrics: ReturnType<typeof AquanoxTrace.usageMetrics>,
        modelLabel: string,
        thinkingMode: string | null,
      ) => void,
    ) {
      const sessionID = first.session.id
      let assistantMessageID = SessionMessage.ID.create()
      const retry = yield* SessionRunnerRetry.make(bus, sessionID)
      let initial: SessionContext.Loaded | undefined = first
      let recoverOverflow = true
      let recoverContinuation = true
      while (true) {
        // Reuse boundary preparation once; retries refresh context without delivering more input.
        const rawLoaded = initial ?? (yield* prepareContext(sessionID).pipe(Effect.flatMap(context.load)))
        initial = undefined
        const isLocalBudgeted = supportsLocalSlotAndReasoningBudget(rawLoaded.model)
        if (
          isLocalBudgeted &&
          !SessionSlotLease.isBackendReconciled() &&
          process.env.NODE_ENV !== "test" &&
          !process.env.BUN_TEST
        ) {
          yield* Effect.promise(() =>
            SessionSlotLease.reconcileBackendSlotCapacities(rawLoaded.model.model.route.endpoint.baseURL, {
              configuredContextTokens: rawLoaded.model.limit.context,
            }).catch(() => false),
          )
        }
        const isSubagentStep = Boolean(rawLoaded.session.parentID)
        const stepTier: SessionSlotLease.LeaseTier = isSubagentStep
          ? (SessionSlotLease.getSessionTier(rawLoaded.session.id) ?? "128k")
          : "384k"
        const preSlot = isLocalBudgeted ? SessionSlotLease.peek(rawLoaded.session.id, isSubagentStep) : undefined
        const loaded =
          isLocalBudgeted && SessionSlotLease.isBackendReconciled()
            ? {
                ...rawLoaded,
                model: {
                  ...rawLoaded.model,
                  limit: {
                    ...rawLoaded.model.limit,
                    context: SessionSlotLease.getEffectiveSlotContextLimit(
                      preSlot,
                      stepTier,
                      rawLoaded.model.limit.context,
                    ),
                  },
                },
              }
            : rawLoaded
        const estimate = SessionCompaction.estimatePrompt(loaded)
        const compacted = yield* compaction.compact({ reason: "auto", context: loaded, estimate })
        if (compacted.status === "failed") return yield* new StepFailedError({ error: compacted.error })
        if (compacted.status === "completed") {
          assistantMessageID = SessionMessage.ID.create()
          continue
        }
        yield* compaction.precompute(Effect.succeed(loaded), estimate)
        const stepLimitReached = loaded.agent.info.steps !== undefined && step >= loaded.agent.info.steps
        const transcript = SessionModelRequest.baseTranscript({
          agent: loaded.agent.info,
          model: loaded.model,
          tools: loaded.tools,
          initial: loaded.initial,
          messages: loaded.messages,
        })
        const traceActive =
          AquanoxTrace.isEnabled() || AquanoxTrace.hasExplicitCorrelation(loaded.session.id, loaded.session.metadata)
        const stepCorr = traceActive ? yield* AquanoxTrace.resolveSessionCorrelation(store, loaded.session) : undefined
        const stepSpanId = traceActive ? AquanoxTrace.newSpanId("sp_oc_step") : undefined
        const stepThinkingMode = loaded.model.ref.variant ?? stepCorr?.thinkingMode ?? null
        const stepModelLabel = `${loaded.model.ref.providerID}/${loaded.model.ref.id}`
        const routing = resolveStepRouting({
          session: loaded.session,
          agent: loaded.agent,
          model: loaded.model,
          messages: loaded.messages,
          stepLimitReached,
        })
        const stepModel =
          isLocalBudgeted && SessionSlotLease.isBackendReconciled() && routing.httpBody?.id_slot !== undefined
            ? {
                ...loaded.model,
                limit: {
                  ...loaded.model.limit,
                  context: SessionSlotLease.getEffectiveSlotContextLimit(
                    routing.httpBody.id_slot,
                    stepTier,
                    loaded.model.limit.context,
                  ),
                },
              }
            : loaded.model
        const prepared = yield* context.request
          .primary({
            session: loaded.session,
            agent: loaded.agent.id,
            model: stepModel,
            tools: loaded.tools,
            system: transcript.system,
            messages: stepLimitReached
              ? [...transcript.messages, Message.assistant(MAX_STEPS_PROMPT)]
              : transcript.messages,
            // Keep tool definitions on the final Step to preserve the provider's cached prefix.
            toolChoice: routing.toolChoice,
            ...(routing.httpBody ? { httpBody: routing.httpBody } : {}),
            webSocket: "session",
            inputTokens: estimate,
            ...(stepCorr && stepSpanId
              ? {
                  aquanox: {
                    conversationId: stepCorr.conversationId,
                    rootSessionId: stepCorr.rootSessionId,
                    parentSpanId: stepSpanId,
                    thinkingMode: stepThinkingMode,
                  },
                }
              : {}),
          })
          .pipe(
            // The hook event holds every message from before images are bounded, screenshots included, and is a separate
            // copy once a plugin hook has rewritten it. The step and its tool callbacks live as long as the slowest tool,
            // so they keep only what they use.
            Effect.map((prepared) => ({
              request: prepared.request,
              options: prepared.options,
              retry: prepared.retry,
              executeTool: prepared.executeTool,
            })),
          )
        yield* compaction.interruptPrecompute(sessionID)
        const outcome = yield* SessionSlotLease.withComputeTurnstile(
          sessionID,
          routing.httpBody?.id_slot,
          () =>
            steps.attempt({
              isLocationClosed: lifecycle.isClosed,
              sessionID,
              assistantMessageID,
              agent: loaded.agent.id,
              model: loaded.model,
              prepared: {
                ...prepared,
                // A tool call can arrive during a reload; its permission check reads the session's agent.
                executeTool: (call) => plugins.awaitActivation.pipe(Effect.andThen(prepared.executeTool(call))),
              },
              retry: (cause, error, proposed) =>
                retry.decide({
                  cause,
                  error,
                  agent: loaded.agent.id,
                  model: loaded.model.ref,
                  hook: prepared.retry,
                  retry: proposed,
                }),
              recoverContinuation,
              recoverOverflow: Effect.suspend(() =>
                recoverOverflow
                  ? compaction
                      .compact({ reason: "overflow", context: loaded, estimate })
                      .pipe(Effect.map((result) => result.status === "completed"))
                  : Effect.succeed(false),
              ),
              ...(stepCorr && stepSpanId
                ? {
                    aquanox: {
                      stepSpanId,
                      parentSpanId: AquanoxTrace.getActiveTurnSpan(sessionID) ?? stepCorr.parentTurnSpanId,
                      conversationId: stepCorr.conversationId,
                      rootSessionId: stepCorr.rootSessionId,
                      parentSessionId: stepCorr.parentSessionId,
                      isSubagent: stepCorr.isSubagent,
                      thinkingMode: stepThinkingMode,
                      stepNumber: step,
                      onMetrics: (metrics) => onTurnMetrics?.(metrics, stepModelLabel, stepThinkingMode),
                    },
                  }
                : {}),
            }),
        )
        const completed = yield* SessionStep.Outcome.$match(outcome, {
          Completed: Effect.fnUntraced(function* (outcome) {
            // The Session is about to go idle, which leaves the background summary time to finish.
            if (!outcome.needsContinuation)
              yield* compaction.precompute(
                store.context(sessionID).pipe(Effect.map((messages) => ({ ...loaded, messages }))),
              )
            return outcome.needsContinuation
          }),
          Retry: (outcome) =>
            retry.wait({
              decision: outcome.decision,
              error: outcome.error,
              assistantMessageID,
            }),
          Continue: Effect.fnUntraced(function* (outcome) {
            yield* retry.wait({
              decision: outcome.decision,
              error: outcome.error,
              assistantMessageID,
            })
            yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: CONTINUE_AFTER_INCOMPLETE_STREAM })
            assistantMessageID = SessionMessage.ID.create()
          }),
          OutputLimit: Effect.fn("SessionRunner.continueOutputLimit")(function* (outcome) {
            // The current response is included. User input or any other finish breaks the streak.
            const recent = yield* db
              .select({
                type: SessionMessageTable.type,
                finish: sql<string | null>`json_extract(${SessionMessageTable.data}, '$.finish')`,
              })
              .from(SessionMessageTable)
              .where(
                and(
                  eq(SessionMessageTable.session_id, sessionID),
                  inArray(SessionMessageTable.type, ["user", "assistant"]),
                ),
              )
              .orderBy(desc(SessionMessageTable.seq))
              .limit(3)
              .all()
              .pipe(Effect.orDie)
            const exhausted =
              recent.length === 3 && recent.every((row) => row.type === "assistant" && row.finish === "length")
            if (exhausted)
              return yield* new StepFailedError({
                error: {
                  type: "output-limit",
                  message: "Response still truncated after two output token limit continuations",
                },
              })
            if (outcome.needsContinuation) return true
            yield* bus.publish(SessionEvent.Synthetic, {
              sessionID,
              text: loaded.session.parentID ? SUBAGENT_CONTINUE_AFTER_OUTPUT_LIMIT : CONTINUE_AFTER_OUTPUT_LIMIT,
            })
            assistantMessageID = SessionMessage.ID.create()
          }),
          Compacted: Effect.fnUntraced(function* () {
            recoverOverflow = false
            assistantMessageID = SessionMessage.ID.create()
          }),
          RecoverFull: Effect.fnUntraced(function* () {
            recoverContinuation = false
          }),
        })
        if (completed !== undefined) return completed
      }
    })

    const settleStaleCompactions = Effect.fn("SessionRunner.settleStaleCompactions")(function* (
      sessionID: SessionSchema.ID,
    ) {
      // A process death skips compaction finalizers. Include orphans behind a
      // completed checkpoint, and settle newest first to match event projection.
      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "compaction"),
            sql`json_extract(${SessionMessageTable.data}, '$.status') = 'running'`,
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        const message = yield* SessionHistory.decodeMessageRow(row)
        if (message.type !== "compaction") continue
        yield* bus.publish(SessionEvent.Compaction.Failed, {
          sessionID,
          reason: message.reason,
          inputID: message.id,
          error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
        })
      }
    })

    const settleStaleToolCalls = Effect.fn("SessionRunner.settleStaleToolCalls")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* store.context(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "streaming" && tool.state.status !== "running")) continue
          const metadata = tool.state.status === "running" ? tool.state.metadata : undefined
          const childID =
            tool.name === "subagent" && typeof metadata?.sessionID === "string" ? metadata.sessionID : undefined
          yield* bus.publish(SessionEvent.Tool.Failed, {
            sessionID,
            assistantMessageID: message.id,
            id: tool.id,
            error: {
              type: "aborted",
              message: `Tool execution interrupted: ${tool.name}${childID ? ` (sessionID: ${childID})` : ""}`,
            },
            ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
            executed: tool.executed === true,
          })
        }
      }
    })

    return Service.of({ drain })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    LocationLifecycle.node,
    llmClient,
    SessionContext.node,
    SessionModelTransport.node,
    SessionStore.node,
    SessionCompaction.node,
    Plugin.node,
    SessionTitle.node,
    Snapshot.node,
    ToolOutput.node,
    Database.node,
  ],
})
