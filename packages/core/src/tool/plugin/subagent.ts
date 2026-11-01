export * as SubagentTool from "./subagent.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Exit, Predicate, Schema } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { Job } from "../../job.js"
import { Model } from "../../model.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import { AquanoxTrace } from "../../session/aquanox-trace.js"
import { SessionSchema } from "../../session/schema.js"
import { SessionSlotLease } from "../../session/slot-lease.js"
import { SubagentCompletion } from "../../session/subagent-completion.js"
import { SubagentJob } from "../../session/subagent-job.js"

export const name = "subagent"
export const MAX_SUBAGENT_DEPTH = 3

/**
 * When spawning a child sub-agent without an explicit tool-call `model` override or `agent.model`,
 * binds the child session's variant to `#subagent-high` (if configured on the model) or `#high`
 * (if `#subagent-high` is not yet configured), preventing sub-agents from inheriting Root's `#max`.
 */
export const bindChildSubagentModel = (
  parentModel: Model.Ref | undefined,
  available: ReadonlyArray<Model.Info>,
): Model.Ref | undefined => {
  if (parentModel === undefined) return undefined
  const catalogModel = available.find((m) => m.providerID === parentModel.providerID && m.id === parentModel.id)
  if (catalogModel === undefined || catalogModel.variants.length === 0) return parentModel
  const hasSubagentHigh = catalogModel.variants.some((v) => String(v.id) === "subagent-high")
  if (hasSubagentHigh) {
    return Model.Ref.make({
      providerID: parentModel.providerID,
      id: parentModel.id,
      variant: Model.VariantID.make("subagent-high"),
    })
  }
  const hasHigh = catalogModel.variants.some((v) => String(v.id) === "high")
  if (hasHigh) {
    return Model.Ref.make({
      providerID: parentModel.providerID,
      id: parentModel.id,
      variant: Model.VariantID.make("high"),
    })
  }
  return parentModel
}

/**
 * Resolves the parent session's reasoning_effort from metadata, model variant overlay, or default,
 * ensuring child subagents inherit the exact reasoning_effort and match token 8 of <｜System｜> 100%.
 */
export const resolveParentReasoningEffort = (
  parent: SessionSchema.Info,
  available: ReadonlyArray<Model.Info>,
): number | string | undefined => {
  if (parent.metadata && typeof parent.metadata === "object") {
    const parentMeta = parent.metadata as Record<string, unknown>
    const metaKwargs = parentMeta.chat_template_kwargs as Record<string, unknown> | undefined
    if (metaKwargs && (typeof metaKwargs.reasoning_effort === "number" || typeof metaKwargs.reasoning_effort === "string")) {
      return metaKwargs.reasoning_effort
    }
  }
  if (parent.model) {
    const catalog = available.find(
      (m) => m.providerID === parent.model?.providerID && m.id === parent.model?.id,
    )
    if (catalog) {
      const parentVar = catalog.variants.find((v) => v.id === parent.model?.variant)
      const varBody = parentVar?.body as Record<string, unknown> | undefined
      const varKwargs = varBody?.chat_template_kwargs as Record<string, unknown> | undefined
      if (typeof varKwargs?.reasoning_effort === "number" || typeof varKwargs?.reasoning_effort === "string") {
        return varKwargs.reasoning_effort
      }
      const varSettings = parentVar?.settings as Record<string, unknown> | undefined
      if (typeof varSettings?.reasoningEffort === "string" && varSettings.reasoningEffort.length > 0) {
        return varSettings.reasoningEffort
      }
      const modelBody = catalog.body as Record<string, unknown> | undefined
      const modelKwargs = modelBody?.chat_template_kwargs as Record<string, unknown> | undefined
      if (typeof modelKwargs?.reasoning_effort === "number" || typeof modelKwargs?.reasoning_effort === "string") {
        return modelKwargs.reasoning_effort
      }
    }
  }
  if (parent.model && String(parent.model.providerID) === "deepseek-local") {
    return 85
  }
  return undefined
}

const backgroundResult = (sessionID: SessionSchema.ID) => ({
  sessionID,
  status: "running" as const,
  output: [
    `The subagent is working in the background (sessionID: ${sessionID}). You will be notified automatically when it finishes.`,
    "DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using.",
    "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
  ].join("\n"),
})

export const Input = Schema.Struct({
  agent: Schema.String.annotate({
    description:
      "The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead.",
  }),
  description: Schema.String.annotate({ description: "A short 3-5 word label for the task, displayed to the user" }),
  prompt: Schema.String.annotate({ description: "The task for the subagent to perform" }),
  model: Schema.optionalKey(Schema.String).annotate({
    description:
      'NEVER set this unless the user explicitly asks for a particular model or variant. The value is written as "providerID/modelID", or "providerID/modelID#variant" to include a variant. Do not guess the ID: look the model up with the models tool, filtering to your own provider first.',
  }),
  sessionID: Schema.optionalKey(SessionSchema.ID).annotate({
    description:
      "Continue a specific previous subagent conversation by passing its sessionID. Calls without a sessionID start a new conversation.",
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Run the subagent in the background and return immediately. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress.",
  }),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literals(["completed", "running"]),
  output: Schema.String,
})
export const description = [
  "Spawns an agent in a child session to work on the specified task.",
  "The output includes a sessionID you can pass back later to continue that specific conversation with the subagent.",
  "New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
  "Foreground (default) runs the subagent to completion and returns its final response.",
  "Background mode (background=true) launches it asynchronously and returns immediately; you are notified when it finishes.",
  "Use background only for independent work that can run while you continue elsewhere.",
].join("\n")

export const Plugin = {
  id: "opencode.tool.subagent",
  effect: Effect.fn("SubagentTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const models = yield* Model.Service
    const subagents = yield* SubagentJob.Service

    const resolveModel = Effect.fn("SubagentTool.resolveModel")(function* (input: string) {
      const ref = yield* Effect.try({
        try: () => Model.Ref.parse(input),
        catch: () =>
          new ToolFailure({
            message: `Invalid model "${input}". Use "providerID/modelID" or "providerID/modelID#variant".`,
          }),
      })
      const model = (yield* models.available()).find(
        (model) => model.providerID === ref.providerID && model.id === ref.id,
      )
      if (model === undefined)
        return yield* new ToolFailure({
          message: `Model "${ref.providerID}/${ref.id}" is not available. Use the models tool to see what is available.`,
        })
      if (ref.variant !== undefined && !model.variants.some((variant) => variant.id === ref.variant))
        return yield* new ToolFailure({
          message:
            model.variants.length === 0
              ? `Model "${ref.providerID}/${ref.id}" has no variants. Omit the variant.`
              : `Variant "${ref.variant}" is not available for "${ref.providerID}/${ref.id}". Available: ${model.variants.map((variant) => variant.id).join(", ")}.`,
        })
      return ref
    })

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
              const parent = yield* sessions
                .get(context.sessionID)
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                  ),
                )
              let current = parent
              let depth = 0
              AquanoxTrace.recordFromSession(parent)
              while (current.parentID) {
                depth++
                current = yield* sessions
                  .get(current.parentID)
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Parent session not found: ${current.parentID}`, error }),
                    ),
                  )
                AquanoxTrace.recordFromSession(current)
              }
              const configuredLimit = Config.latest(yield* config.entries(), "experimental")?.subagent_depth
              const limit = configuredLimit ?? MAX_SUBAGENT_DEPTH
              if (depth >= limit) {
                const message =
                  limit === MAX_SUBAGENT_DEPTH
                    ? `Maximum subagent nesting depth (${MAX_SUBAGENT_DEPTH}) reached. Complete this task directly or coordinate with peers via send_message.`
                    : `Subagent depth limit reached (${limit}). Increase "experimental.subagent_depth" to allow nested subagents.`
                return yield* new ToolFailure({ message })
              }
              const agent = yield* agents.resolve(input.agent)
              if (agent === undefined) return yield* new ToolFailure({ message: `Unknown agent: ${input.agent}` })
              if (agent.mode === "primary")
                return yield* new ToolFailure({ message: `Agent ${input.agent} cannot run as a subagent` })
              yield* permission
                .assert({
                  action: name,
                  resources: [agent.id],
                  save: [agent.id],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: {
                    type: "tool",
                    messageID: context.messageID,
                    id: context.id,
                  },
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: `Subagent denied: ${agent.id}`, error })))

              const existing =
                input.sessionID === undefined
                  ? undefined
                  : yield* sessions
                      .get(input.sessionID)
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new ToolFailure({ message: `Subagent session not found: ${input.sessionID}`, error }),
                        ),
                      )
              if (existing !== undefined && existing.parentID !== context.sessionID)
                return yield* new ToolFailure({
                  message: `Session ${existing.id} is not a child of the current session`,
                })
              const override = input.model === undefined ? undefined : yield* resolveModel(input.model)
              // Continuing with a different agent switches the child, mirroring create semantics
              // where an explicit model wins over the agent's configured model, which wins over the inherited one.
              if (existing !== undefined) {
                const switched = existing.agent !== agent.id
                const model = override ?? (switched ? agent.model : undefined)
                yield* Effect.all([
                  switched ? sessions.switchAgent({ sessionID: existing.id, agent: agent.id }) : Effect.void,
                  model === undefined ? Effect.void : sessions.switchModel({ sessionID: existing.id, model }),
                ]).pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Failed to switch subagent session: ${existing.id}`, error }),
                  ),
                )
              }

              const availableModels = yield* models.available()
              let resolvedModel: Model.Ref | undefined
              if (override !== undefined) {
                resolvedModel = override
              } else if (agent.model !== undefined) {
                const isAgentModelAvailable = availableModels.some(
                  (m) => m.providerID === agent.model!.providerID && m.id === agent.model!.id,
                )
                if (!isAgentModelAvailable) {
                  // Fall back automatically when agent.model points to an unavailable provider/model
                  resolvedModel = bindChildSubagentModel(parent.model, availableModels)
                } else if (String(agent.model.providerID) === "deepseek-local" && agent.model.variant === undefined) {
                  // Upgrade deepseek-local without variant so #subagent-high applies
                  resolvedModel = bindChildSubagentModel(agent.model, availableModels)
                } else {
                  resolvedModel = agent.model
                }
              } else {
                resolvedModel = bindChildSubagentModel(parent.model, availableModels)
              }

              const model = resolvedModel
              const isDeepSeekLocal = model !== undefined && String(model.providerID) === "deepseek-local"

              const childCatalog = isDeepSeekLocal
                ? availableModels.find((m) => m.providerID === model?.providerID && m.id === model?.id)
                : undefined
              const childVariant = childCatalog?.variants.find((v) => v.id === model?.variant)
              // SAFETY: variant body and settings may contain custom configuration
              const childVarBody = childVariant?.body as Record<string, unknown> | undefined
              const childVarKwargs = childVarBody?.chat_template_kwargs as Record<string, unknown> | undefined
              const childVarSettings = childVariant?.settings as Record<string, unknown> | undefined
              const childHasExplicitBudget =
                childVarKwargs?.reasoning_effort !== undefined ||
                (typeof childVarSettings?.reasoningEffort === "string" && childVarSettings.reasoningEffort.length > 0) ||
                typeof childVarBody?.reasoning_budget_tokens === "number"

              const inheritedReasoningEffort =
                isDeepSeekLocal && !childHasExplicitBudget
                  ? resolveParentReasoningEffort(parent, availableModels)
                  : undefined

              const traceEnabled = AquanoxTrace.isEnabled()
              const propagateMeta =
                traceEnabled || AquanoxTrace.hasExplicitCorrelation(parent.id, parent.metadata)
              const parentCorr = propagateMeta ? AquanoxTrace.resolveSessionCorrelationSync(parent) : undefined
              const subSpanId = propagateMeta ? AquanoxTrace.newSpanId("sp_oc_sub") : undefined
              const parentToolSpanId = `sp_oc_tool_${context.sessionID}_${context.id}`
              const childThinkingMode = model?.variant ?? parentCorr?.thinkingMode ?? null
              const inheritedKwargs =
                inheritedReasoningEffort !== undefined
                  ? { chat_template_kwargs: { reasoning_effort: inheritedReasoningEffort } }
                  : {}
              const childMetadata: any = {
                ...(existing?.metadata ?? parent.metadata ?? {}),
                ...inheritedKwargs,
                ...(parentCorr && subSpanId
                  ? {
                      aquanoxConversationId: parentCorr.conversationId,
                      aquanoxRootSessionId: parentCorr.rootSessionId,
                      aquanoxParentSpanId: subSpanId,
                      ...(childThinkingMode ? { aquanoxThinkingMode: childThinkingMode } : {}),
                    }
                  : {}),
              }
              if (existing !== undefined) {
                yield* sessions.setMetadata({ sessionID: existing.id, metadata: childMetadata }).pipe(Effect.ignore)
              }
              const child =
                existing ??
                (yield* sessions
                  .create({
                    parentID: context.sessionID,
                    title: input.description,
                    agent: agent.id,
                    model,
                    metadata: childMetadata,
                  })
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                    ),
                  ))
              if (parentCorr && subSpanId) {
                AquanoxTrace.recordSubagentBinding({
                  childSessionId: child.id,
                  parentSessionId: context.sessionID,
                  conversationId: parentCorr.conversationId,
                  rootSessionId: parentCorr.rootSessionId,
                  subSpanId,
                  thinkingMode: childThinkingMode,
                })
              }

              const background = input.background === true
              const subStartUs = traceEnabled ? AquanoxTrace.nowUs() : 0
              const subModelLabel = model ? `${model.providerID}/${model.id}` : null
              const subSpanName = input.description
                ? `subagent: ${agent.id} (${input.description})`
                : `subagent: ${agent.id}`
              if (traceEnabled && parentCorr && subSpanId) {
                yield* AquanoxTrace.postTraceIngest({
                  sessionBinding: {
                    sessionId: child.id,
                    conversationId: parentCorr.conversationId,
                    rootSessionId: parentCorr.rootSessionId,
                    parentSessionId: context.sessionID,
                    parentSpanId: subSpanId,
                    agentName: agent.id,
                    isSubagent: true,
                    title: input.description || child.title || null,
                  },
                  span: {
                    spanId: subSpanId,
                    conversationId: parentCorr.conversationId,
                    parentSpanId: parentToolSpanId,
                    rootSessionId: parentCorr.rootSessionId,
                    sessionId: context.sessionID,
                    parentSessionId: parent.parentID ?? null,
                    layer: "opencode",
                    kind: "subagent.invoke",
                    name: subSpanName,
                    status: "running",
                    startUs: subStartUs,
                    model: subModelLabel,
                    thinkingMode: childThinkingMode,
                    agentName: agent.id,
                    isSubagent: true,
                    subagentSessionId: child.id,
                    attributes: {
                      background,
                      resumed: existing !== undefined,
                      description: input.description,
                    },
                  },
                })
              }
              yield* context.progress({ sessionID: child.id, status: "running" })

              const preleasedSlot = model !== undefined && String(model.providerID) === "deepseek-local"
              if (preleasedSlot) {
                SessionSlotLease.acquire(child.id, true)
              }
              let jobStarted = false

              return yield* Effect.gen(function* () {
                // Standard prompt admission outside the job: Job.start joining a running child skips
                // its run effect, and the default wake starts an idle child or steers a running one.
                yield* sessions
                  .prompt({
                    sessionID: child.id,
                    text:
                      existing === undefined
                        ? ["You are a subagent spawned by another session.", input.prompt].join("\n")
                        : input.prompt,
                    ...(background && existing === undefined ? { resume: false } : {}),
                  })
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Failed to prompt subagent: ${child.id}`, error }),
                    ),
                  )

                const recovery = {
                  kind: "subagent" as const,
                  parentSessionID: context.sessionID,
                  childSessionID: child.id,
                  agent: agent.name,
                  description: input.description,
                }
                yield* subagents.start(recovery)
                jobStarted = true

                if (background) {
                  yield* subagents.background(recovery)
                  return backgroundResult(child.id)
                }

                SessionSlotLease.release(context.sessionID)
                const result = yield* jobs.block({ id: child.id, sessionID: context.sessionID }).pipe(
                  Effect.onInterrupt(() =>
                    Effect.all([sessions.interrupt(child.id), jobs.cancel(child.id)], {
                      discard: true,
                    }),
                  ),
                  Effect.ensuring(
                    Effect.sync(() => {
                      SessionSlotLease.acquire(context.sessionID, Boolean(parent.parentID))
                    }),
                  ),
                )
                if (result?.type === "backgrounded") {
                  yield* subagents.notify(recovery, result.info.started_at)
                  return backgroundResult(child.id)
                }
                if (preleasedSlot) {
                  SessionSlotLease.release(child.id)
                }
                // Failure surfaces keep the sessionID visible so the model can continue the child.
                if (result?.info.status === "error")
                  return yield* new ToolFailure({
                    message: `Subagent failed (sessionID: ${child.id}): ${result.info.error ?? "unknown error"}`,
                  })
                if (result?.info.status === "cancelled")
                  return yield* new ToolFailure({ message: `Subagent cancelled (sessionID: ${child.id})` })
                return {
                  sessionID: child.id,
                  status: "completed" as const,
                  output: result?.info.output ?? SubagentCompletion.NO_TEXT,
                }
              }).pipe(
                Effect.onExit((exit) => {
                  if (preleasedSlot && Exit.isFailure(exit) && (!jobStarted || !background)) {
                    SessionSlotLease.release(child.id)
                  }
                  if (!traceEnabled || !parentCorr || !subSpanId) return Effect.void
                  const subEndUs = AquanoxTrace.nowUs()
                  let status: "ok" | "error" | "cancelled" = "ok"
                  if (Exit.isFailure(exit)) {
                    status = Exit.hasInterrupts(exit) ? "cancelled" : "error"
                  }
                  return AquanoxTrace.postTraceIngest({
                    span: {
                      spanId: subSpanId,
                      conversationId: parentCorr.conversationId,
                      parentSpanId: parentToolSpanId,
                      rootSessionId: parentCorr.rootSessionId,
                      sessionId: context.sessionID,
                      parentSessionId: parent.parentID ?? null,
                      layer: "opencode",
                      kind: "subagent.invoke",
                      name: subSpanName,
                      status,
                      startUs: subStartUs,
                      endUs: subEndUs,
                      durationMs: AquanoxTrace.durationMs(subStartUs, subEndUs),
                      model: subModelLabel,
                      thinkingMode: childThinkingMode,
                      agentName: agent.id,
                      isSubagent: true,
                      subagentSessionId: child.id,
                      attributes: {
                        background: Exit.isSuccess(exit) ? exit.value.status === "running" : background,
                        resumed: existing !== undefined,
                        description: input.description,
                      },
                    },
                  })
                }),
              )
            }).pipe(
              Effect.map((output) => ({
                output,
                content:
                  output.status === "completed"
                    ? `<subagent sessionID="${output.sessionID}" state="completed">\n${output.output}\n</subagent>`
                    : output.output,
                metadata: { sessionID: output.sessionID, status: output.status },
              })),
            ),
        }),
      )
      .pipe(Effect.orDie)

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.sync(() => {
        if (event.tool !== name || !Predicate.isObject(event.input)) return
        if (event.input.model !== "" && event.input.sessionID !== "") return
        const input = { ...event.input }
        if (input.model === "") delete input.model
        if (input.sessionID === "") delete input.sessionID
        event.input = input
      }),
    )

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const tool = event.tools[name]
        if (!tool) return
        const selected = yield* agents.resolve(event.agent)
        if (!selected) return
        const available = (yield* agents.list())
          .filter(
            (agent) =>
              agent.mode !== "primary" &&
              !agent.hidden &&
              Permission.evaluate(name, agent.id, selected.permissions).effect !== "deny",
          )
          .toSorted((a, b) => a.id.localeCompare(b.id))
        if (available.length === 0) return
        tool.description = [
          tool.description,
          "",
          "Available subagents:",
          ...available.map(
            (agent) =>
              `- ${agent.id}: ${agent.description ?? "This subagent should only be called when explicitly requested."}`,
          ),
        ].join("\n")
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}
