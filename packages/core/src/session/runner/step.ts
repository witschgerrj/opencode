export * as SessionStep from "./step.js"

import {
  AIError,
  InvalidProviderOutputError,
  LLMClient,
  LLMEvent,
  isContextOverflowFailure,
  type ProviderErrorEvent,
  type ToolCall,
} from "@opencode/ai/effect"
import type { Agent } from "@opencode/schema/agent"
import type { RelativePath } from "@opencode/schema/schema"
import { Cause, Clock, Data, Effect, Exit, Fiber, Option, Stream } from "effect"
import { SessionError } from "@opencode/schema/session-error"
import { Bus } from "../../bus.js"
import { Permission } from "../../permission.js"
import { Snapshot } from "../../snapshot.js"
import { Tool } from "../../tool.js"
import { ToolOutput } from "../../tool-output.js"
import { QuestionTool } from "../../tool/plugin/question.js"
import { AquanoxTrace } from "../aquanox-trace.js"
import { StepFailedError } from "../error.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionSchema } from "../schema.js"
import { toSessionError } from "../to-session-error.js"
import { SessionUsage } from "../usage.js"
import { SessionRunnerModel } from "./model.js"
import { createLLMEventPublisher } from "./publish-llm-event.js"
import { SessionRunnerRetry } from "./retry.js"

export type Outcome = Data.TaggedEnum<{
  Completed: { readonly needsContinuation: boolean }
  Retry: { readonly error: SessionError.Error; readonly decision: SessionRunnerRetry.Decision }
  Continue: {
    readonly error: SessionError.Error
    readonly decision: SessionRunnerRetry.Decision
  }
  RecoverFull: {}
  Compacted: {}
  OutputLimit: { readonly needsContinuation: boolean }
}>
export const Outcome = Data.taggedEnum<Outcome>()

interface CachedSessionSnapshot {
  readonly hash: Snapshot.ID
  readonly timestampMs: number
}

const lastCleanSessionSnapshot = new Map<string, CachedSessionSnapshot>()
const MAX_CACHED_SNAPSHOTS = 128
const SNAPSHOT_CACHE_TTL_MS = 120_000

function recordCleanSnapshot(sessionID: string, hash: Snapshot.ID): void {
  lastCleanSessionSnapshot.set(sessionID, { hash, timestampMs: Date.now() })
  if (lastCleanSessionSnapshot.size > MAX_CACHED_SNAPSHOTS) {
    const oldest = lastCleanSessionSnapshot.keys().next().value
    if (oldest !== undefined) lastCleanSessionSnapshot.delete(oldest)
  }
}

export function clearSnapshotCache(): void {
  lastCleanSessionSnapshot.clear()
}

export function getCachedSnapshot(sessionID: string): Snapshot.ID | undefined {
  return lastCleanSessionSnapshot.get(sessionID)?.hash
}

const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "list",
  "skill",
  "todowrite",
  "todoread",
  "question",
  "ask_question",
  "websearch",
  "webfetch",
  "codesearch",
  "lsp",
  "request_synthesis",
])

interface Input {
  readonly isLocationClosed: () => boolean
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly agent: Agent.ID
  readonly model: SessionRunnerModel.Resolved
  readonly prepared: Omit<SessionModelRequest.Prepared, "event">
  readonly retry: (
    cause: AIError,
    error: SessionError.Error,
    retry: boolean,
  ) => Effect.Effect<{ readonly retry: false } | SessionRunnerRetry.Decision>
  readonly recoverContinuation: boolean
  /** The runner owns compaction policy; the attempt invokes it only before durable output. */
  readonly recoverOverflow: Effect.Effect<boolean>
  readonly aquanox?: {
    readonly stepSpanId: string
    readonly parentSpanId: string | null
    readonly conversationId: string
    readonly rootSessionId: string
    readonly parentSessionId: string | null
    readonly isSubagent: boolean
    readonly thinkingMode: string | null
    readonly stepNumber: number
    readonly onMetrics?: (metrics: ReturnType<typeof AquanoxTrace.usageMetrics>) => void
  }
}

const TOOLS_INTERRUPTED = { type: "aborted", message: "Tool execution interrupted" } as const
const STEP_INTERRUPTED = { type: "aborted", message: "Step interrupted" } as const
const RESULT_MISSING = { type: "tool.result-missing", message: "Provider did not return a tool result" } as const

/** Captures Location-scoped dependencies without introducing another service or execution loop. */
export const make = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const llm = yield* LLMClient.Service
  const snapshots = yield* Snapshot.Service
  const toolOutput = yield* ToolOutput.Service

  const attempt = Effect.fn("SessionStep.attempt")(function* (input: Input) {
    const aq = input.aquanox
    const traceEnabled = Boolean(aq && AquanoxTrace.isEnabled())
    const stepStartUs = traceEnabled ? AquanoxTrace.nowUs() : 0
    let firstTokenUs: number | null = null
    let latestUsage: SessionUsage.Recorded | undefined
    const modelLabel = `${input.model.ref.providerID}/${input.model.ref.id}`
    if (aq && traceEnabled) {
      AquanoxTrace.setActiveStepSpan(input.sessionID, aq.stepSpanId)
      yield* Effect.forkDetach(
        AquanoxTrace.postTraceIngest({
          span: {
            spanId: aq.stepSpanId,
            conversationId: aq.conversationId,
            parentSpanId: aq.parentSpanId,
            rootSessionId: aq.rootSessionId,
            sessionId: input.sessionID,
            parentSessionId: aq.parentSessionId,
            layer: "opencode",
            kind: "llm.step",
            name: `llm step #${aq.stepNumber} (${input.agent})`,
            status: "running",
            startUs: stepStartUs,
            model: modelLabel,
            thinkingMode: aq.thinkingMode,
            agentName: input.agent,
            isSubagent: aq.isSubagent,
            contextWindowLimit: input.model.limit.context > 0 ? input.model.limit.context : null,
            attributes: { step: aq.stepNumber },
          },
        }).pipe(Effect.ignore),
      )
    }
    // The start snapshot only has to exist before local tools run, which cannot happen before Step.Started.
    // Dirty-gated snapshot carry-forward: if last clean snapshot exists within TTL, reuse immediately (0 process spawns).
    const cachedEntry = lastCleanSessionSnapshot.get(input.sessionID)
    const nowMs = Date.now()
    const canReuseStartSnapshot =
      cachedEntry !== undefined && nowMs - cachedEntry.timestampMs < SNAPSHOT_CACHE_TTL_MS
    const pendingStartSnapshot = canReuseStartSnapshot
      ? yield* Effect.succeed(cachedEntry.hash).pipe(Effect.forkScoped)
      : yield* snapshots.capture().pipe(Effect.forkScoped)
    const publisher = createLLMEventPublisher(bus, {
      sessionID: input.sessionID,
      assistantMessageID: input.assistantMessageID,
      agent: input.agent,
      model: input.model.ref,
      providerMetadataKey: input.model.model.route.providerMetadataKey ?? input.model.model.provider,
      pendingSnapshot: Fiber.join(pendingStartSnapshot),
      started: yield* Clock.currentTimeMillis,
    })
    const toolRuns: Array<{
      readonly call: ToolCall
      readonly fiber: Fiber.Fiber<void, Permission.DeclinedError | QuestionTool.CancelledError>
    }> = []
    const interruptTools = Effect.suspend(() => Fiber.interruptAll(toolRuns.map((run) => run.fiber)))
    let sawMutatingTool = false
    const executeTool = (call: ToolCall) => {
      const toolName = String(call.name ?? "").toLowerCase()
      if (!READ_ONLY_TOOLS.has(toolName)) {
        sawMutatingTool = true
      }
      if (input.prepared.request.toolChoice?.type === "none")
        return new Tool.Error({ message: "Tools are disabled after the maximum agent steps" })
      return input.prepared.executeTool({
        sessionID: input.sessionID,
        agent: input.agent,
        messageID: input.assistantMessageID,
        call,
        progress: (update) => publisher.progress(call.id, update),
      })
    }

    // Provider and tool fibers retain per-source order without a shared writer queue.
    // A local execution starts only after its Tool.Called publication completes.
    let overflowFailure: ProviderErrorEvent | undefined
    // Read to the end, not just the finish event, so the next request can reuse this response.
    const providerStream = llm.stream(input.prepared.request, input.prepared.options).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (overflowFailure || publisher.hasProviderError()) return
          // Wait here, where cancellation still works, rather than inside the uninterruptible publish.
          if (!publisher.hasStarted()) yield* Fiber.join(pendingStartSnapshot)
          if (
            LLMEvent.is.providerError(event) &&
            isContextOverflowFailure(event) &&
            !publisher.record().outputStarted
          ) {
            overflowFailure = event
            return
          }
          yield* publisher.publish(event)
          if (traceEnabled && firstTokenUs === null && publisher.record().outputStarted) {
            firstTokenUs = AquanoxTrace.nowUs()
          }
          if (event.type !== "tool-call" || event.providerExecuted) return
          const toolSpanId = `sp_oc_tool_${input.sessionID}_${event.id}`
          const toolStartUs = traceEnabled ? AquanoxTrace.nowUs() : 0
          toolRuns.push({
            call: event,
            fiber: yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                if (aq && traceEnabled) {
                  yield* AquanoxTrace.postTraceIngest({
                    span: {
                      spanId: toolSpanId,
                      conversationId: aq.conversationId,
                      parentSpanId: aq.stepSpanId,
                      rootSessionId: aq.rootSessionId,
                      sessionId: input.sessionID,
                      parentSessionId: aq.parentSessionId,
                      layer: "opencode",
                      kind: "tool.call",
                      name: `tool: ${event.name}`,
                      status: "running",
                      startUs: toolStartUs,
                      model: modelLabel,
                      thinkingMode: aq.thinkingMode,
                      agentName: input.agent,
                      isSubagent: aq.isSubagent,
                      attributes: { toolName: event.name, toolCallId: event.id },
                    },
                  })
                }
                let toolStatus: "ok" | "error" | "cancelled" = "ok"
                const emitToolEnd = (status: "ok" | "error" | "cancelled") => {
                  if (!aq || !traceEnabled) return Effect.void
                  const toolEndUs = AquanoxTrace.nowUs()
                  return AquanoxTrace.postTraceIngest({
                    span: {
                      spanId: toolSpanId,
                      conversationId: aq.conversationId,
                      parentSpanId: aq.stepSpanId,
                      rootSessionId: aq.rootSessionId,
                      sessionId: input.sessionID,
                      parentSessionId: aq.parentSessionId,
                      layer: "opencode",
                      kind: "tool.call",
                      name: `tool: ${event.name}`,
                      status,
                      startUs: toolStartUs,
                      endUs: toolEndUs,
                      durationMs: AquanoxTrace.durationMs(toolStartUs, toolEndUs),
                      model: modelLabel,
                      thinkingMode: aq.thinkingMode,
                      agentName: input.agent,
                      isSubagent: aq.isSubagent,
                      attributes: { toolName: event.name, toolCallId: event.id },
                    },
                  })
                }
                yield* restore(executeTool(event)).pipe(
                  Effect.flatMap(toolOutput.truncate),
                  Effect.flatMap((outcome) => publisher.toolExecution(event.id, event.name, outcome)),
                  Effect.catchTag("Tool.Error", (error) => {
                    toolStatus = "error"
                    return publisher.failTool(event.id, toSessionError(error), error.metadata).pipe(Effect.asVoid)
                  }),
                  Effect.onExit((exit) => {
                    if (Exit.isFailure(exit)) {
                      return emitToolEnd(Exit.hasInterrupts(exit) ? "cancelled" : "error")
                    }
                    return emitToolEnd(toolStatus)
                  }),
                )
              }),
            ).pipe(Effect.forkScoped),
          })
        }),
      ),
      Effect.ensuring(publisher.flush()),
    )

    // Keep the final tool and Step events uninterruptible, even when the work itself is cancelled.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const stream = yield* restore(providerStream).pipe(Effect.exit)
        const streamFailure = Option.getOrUndefined(Exit.findErrorOption(stream))
        const streamInterrupted = Exit.hasInterrupts(stream)
        // Cancelled before the start snapshot existed: record nothing, as when the capture preceded the request.
        if (streamInterrupted && !publisher.hasStarted() && !pendingStartSnapshot.pollUnsafe())
          return yield* Effect.failCause(stream.cause)
        if (!overflowFailure && publisher.hasStarted()) yield* publisher.streamed()
        if (streamInterrupted) yield* interruptTools
        const joined = yield* restore(Fiber.awaitAll(toolRuns.map((run) => run.fiber))).pipe(Effect.exit)
        if (Exit.isFailure(joined)) yield* interruptTools
        const tools = classifyToolExits(joined, toolRuns)

        const overflow = overflowFailure ?? streamFailure
        if (
          !publisher.record().outputStarted &&
          isContextOverflowFailure(overflow) &&
          (yield* restore(input.recoverOverflow))
        ) {
          yield* Effect.logWarning("provider rejected the request as too long; compacting", {
            sessionID: input.sessionID,
            model: input.model.ref,
            message: overflow?.message,
          })
          return Outcome.Compacted()
        }

        if (overflowFailure) yield* publisher.publish(overflowFailure)
        const recorded = publisher.record()
        const unknownFinish =
          Exit.isSuccess(stream) && recorded.finish?.finish === "unknown"
            ? new AIError({
                reason: new InvalidProviderOutputError({
                  message: "The provider response ended with an unknown finish reason.",
                  classification: "incomplete-stream",
                }),
              })
            : undefined
        const llmFailure = streamFailure instanceof AIError ? streamFailure : unknownFinish
        const llmError = llmFailure && !recorded.providerFailed ? toSessionError(llmFailure) : undefined
        if (
          input.recoverContinuation &&
          llmFailure?.reason._tag === "Transport" &&
          (llmFailure.reason.recovery === "retry-full" || llmFailure.reason.recovery === "rotate-and-retry-full") &&
          !recorded.outputStarted
        )
          return Outcome.RecoverFull()
        const retry =
          llmFailure && llmError && !isContextOverflowFailure(llmFailure)
            ? yield* restore(
                input.retry(
                  llmFailure,
                  llmError,
                  SessionRunnerRetry.isRetryable(llmFailure) ||
                    (recorded.outputStarted && isInterruptedStream(llmFailure)),
                ),
              )
            : undefined
        if (llmFailure && llmError && retry?.retry && !recorded.outputStarted) {
          // Retry state projects onto the existing assistant, even before it has produced output.
          yield* publisher.startAssistant()
          return Outcome.Retry({ error: llmError, decision: retry })
        }
        if (llmError) yield* publisher.failAssistant(llmError)

        for (const decline of tools.declines)
          yield* publisher.failTool(decline.call.id, {
            type: "aborted",
            message: input.isLocationClosed()
              ? "Interaction cancelled because the location shut down"
              : decline.reason._tag === "QuestionTool.CancelledError"
                ? decline.reason.message
                : "The user declined this tool call",
          })
        const interrupted = tools.declines.length > 0 || streamInterrupted || tools.interrupted
        const toolFailure = interrupted
          ? TOOLS_INTERRUPTED
          : tools.failure !== undefined
            ? toSessionError(Cause.squash(tools.failure))
            : recorded.providerFailed
              ? TOOLS_INTERRUPTED
              : undefined
        if (toolFailure) yield* publisher.failUnsettledTools(toolFailure)
        if (interrupted) yield* publisher.failAssistant(STEP_INTERRUPTED)

        // Parsers may leave unfinished calls without an execution event.
        if (llmError || (Exit.isSuccess(stream) && !recorded.providerFailed)) {
          const missing = yield* publisher.failUnsettledTools(RESULT_MISSING, "hosted")
          if (missing && !llmError && !recorded.finish) yield* publisher.failAssistant(RESULT_MISSING)
          yield* publisher.failIncompleteTools()
        }

        const record = publisher.record()
        if (record.finish || record.failure) {
          const startSnapshot = yield* Fiber.join(pendingStartSnapshot)
          let snapshot: Snapshot.ID | undefined
          let files: ReadonlyArray<RelativePath> | undefined
          if (!sawMutatingTool && startSnapshot) {
            snapshot = startSnapshot
            files = []
            recordCleanSnapshot(input.sessionID, snapshot)
          } else {
            snapshot = yield* snapshots.capture()
            files =
              startSnapshot && snapshot
                ? startSnapshot === snapshot
                  ? []
                  : yield* snapshots
                      .files({ from: startSnapshot, to: snapshot })
                      .pipe(Effect.orElseSucceed(() => undefined))
                : undefined
            if (snapshot) recordCleanSnapshot(input.sessionID, snapshot)
          }
          const usage = record.finish ? SessionUsage.record(record.finish.usage, input.model.cost) : undefined
          if (usage) latestUsage = usage
          if (record.failure) yield* publisher.publishStepFailure({ ...usage, snapshot, files })
          if (record.finish && usage && !record.failure)
            yield* bus.publish(SessionEvent.Step.Ended, {
              sessionID: input.sessionID,
              assistantMessageID: yield* publisher.startAssistant(),
              finish: record.finish.finish,
              rawFinish: record.finish.rawFinish,
              native: record.finish.native,
              ...usage,
              snapshot,
              files,
            })
        }

        if (
          llmFailure &&
          llmError &&
          retry?.retry &&
          record.outputStarted &&
          tools.declines.length === 0 &&
          !tools.interrupted
        )
          return Outcome.Continue({ error: llmError, decision: retry })

        if (Exit.isFailure(stream)) return yield* Effect.failCause(stream.cause)
        if (tools.declines.length > 0) {
          if (input.isLocationClosed()) return Outcome.Completed({ needsContinuation: true })
          return yield* Effect.interrupt
        }
        if (tools.interrupted && tools.failure) return yield* Effect.failCause(tools.failure)
        if (tools.interrupted && Exit.isFailure(joined)) return yield* Effect.failCause(joined.cause)
        if (record.failure) return yield* new StepFailedError({ error: record.failure })
        const needsContinuation = input.prepared.request.toolChoice?.type !== "none" && record.needsContinuation
        if (record.finish?.finish === "length") return Outcome.OutputLimit({ needsContinuation })
        return Outcome.Completed({ needsContinuation })
      }),
    ).pipe(
      Effect.onExit((exit) => {
        if (!aq || !traceEnabled) return Effect.void
        if (AquanoxTrace.getActiveStepSpan(input.sessionID) === aq.stepSpanId) {
          AquanoxTrace.setActiveStepSpan(input.sessionID, null)
        }
        const stepEndUs = AquanoxTrace.nowUs()
        const metrics = AquanoxTrace.usageMetrics(latestUsage?.tokens, input.model.limit.context)
        aq.onMetrics?.(metrics)
        let status: "ok" | "error" | "cancelled" = "ok"
        if (Exit.isFailure(exit)) {
          status = Exit.hasInterrupts(exit) ? "cancelled" : "error"
        } else if (
          exit.value._tag === "Retry" ||
          exit.value._tag === "Continue" ||
          exit.value._tag === "RecoverFull"
        ) {
          status = "error"
        }
        return AquanoxTrace.postTraceIngest({
          span: {
            spanId: aq.stepSpanId,
            conversationId: aq.conversationId,
            parentSpanId: aq.parentSpanId,
            rootSessionId: aq.rootSessionId,
            sessionId: input.sessionID,
            parentSessionId: aq.parentSessionId,
            layer: "opencode",
            kind: "llm.step",
            name: `llm step #${aq.stepNumber} (${input.agent})`,
            status,
            startUs: stepStartUs,
            endUs: stepEndUs,
            durationMs: AquanoxTrace.durationMs(stepStartUs, stepEndUs),
            model: modelLabel,
            thinkingMode: aq.thinkingMode,
            agentName: input.agent,
            isSubagent: aq.isSubagent,
            ...metrics,
            ttftMs: firstTokenUs !== null ? AquanoxTrace.durationMs(stepStartUs, firstTokenUs) : null,
            attributes: {
              step: aq.stepNumber,
              ...(Exit.isSuccess(exit) ? { outcome: exit.value._tag } : {}),
            },
          },
        })
      }),
    )
  }, Effect.scoped)

  return { attempt }
})

const isInterruptedStream = (failure: AIError) => {
  if (failure.reason._tag === "InvalidProviderOutput") return failure.reason.classification === "incomplete-stream"
  if (failure.reason._tag === "Transport") return failure.reason.operation === "read"
  return false
}

/** Tool.Error settles in each fiber; only user declines remain in the typed error channel. */
const classifyToolExits = (
  settled: Exit.Exit<Array<Exit.Exit<void, Permission.DeclinedError | QuestionTool.CancelledError>>>,
  runs: ReadonlyArray<{ readonly call: ToolCall }>,
) => {
  const exits = Exit.isSuccess(settled) ? settled.value : []
  const declines = exits.flatMap((exit, index) =>
    Exit.isFailure(exit)
      ? exit.cause.reasons.flatMap((reason) =>
          Cause.isFailReason(reason) ? [{ call: runs[index].call, reason: reason.error }] : [],
        )
      : [],
  )
  const causes = Exit.isFailure(settled)
    ? [settled.cause]
    : exits.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []))
  const failure = causes
    .flatMap((cause) => {
      if (Cause.hasInterrupts(cause)) return []
      const reasons = cause.reasons.filter(Cause.isDieReason)
      return reasons.length > 0 ? [Cause.fromReasons<never>(reasons)] : []
    })
    .at(0)
  return { interrupted: causes.some(Cause.hasInterrupts), declines, failure }
}
