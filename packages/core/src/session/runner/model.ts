export * as SessionRunnerModel from "./model.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LanguageModel } from "@opencode/ai/effect"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Context, Effect, Layer, Schema } from "effect"
import { Agent } from "../../agent.js"
import { ModelResolver } from "../../model-resolver.js"
import { SessionSchema } from "../schema.js"
import { SessionSlotLease } from "../slot-lease.js"

export class ModelNotSelectedError extends Schema.TaggedError<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  { sessionID: SessionSchema.ID },
) {
  override get message() {
    return "No model is available for session " + this.sessionID
  }
}

export class ModelUnavailableError extends Schema.TaggedError<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  { providerID: Provider.ID, modelID: Model.ID },
) {
  override get message() {
    if (this.providerID === "azure-cognitive-services")
      return "Model unavailable: " + this.providerID + "/" + this.modelID + ". This provider has been deprecated; use azure/" + this.modelID + " instead."
    if (this.providerID === "google-vertex-anthropic")
      return "Model unavailable: " + this.providerID + "/" + this.modelID + ". This provider has been deprecated; use google-vertex/" + this.modelID + " instead."
    return "Model unavailable: " + this.providerID + "/" + this.modelID
  }
}
export type Error = ModelNotSelectedError | ModelUnavailableError | ModelResolver.Error
export type Resolved = ModelResolver.Resolved

export interface Interface {
  /** Availability is sampled lazily for each explicitly selected model resolution. */
  readonly resolve: (
    session: SessionSchema.Info,
    available: () => Effect.Effect<ReadonlyArray<Model.Info>>,
  ) => Effect.Effect<Resolved, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunnerModel") {}

/** Builds a Resolved whose catalog identity mirrors the route model. Test or embedding seam. */
export const resolved = (
  model: LanguageModel,
  options: {
    readonly capabilities: Model.Capabilities
    readonly variant?: Model.VariantID
    readonly cost: Model.Info["cost"]
    readonly limit: Model.Info["limit"]
    readonly compaction?: Provider.Compaction
    readonly transport?: Provider.Transport
  },
): Resolved => ({
  model,
  ref: Model.Ref.make({
    id: Model.ID.make(model.id),
    providerID: Provider.ID.make(model.provider),
    ...(options.variant === undefined ? {} : { variant: options.variant }),
  }),
  capabilities: options.capabilities,
  cost: options.cost,
  limit: options.limit,
  compaction: options.compaction,
  transport: options.transport,
})

export const resolveSessionContextTier = (
  session: SessionSchema.Info,
  agentInfo?: Agent.Info,
): "128k" | "256k" | "384k" => {
  const metadata = session.metadata as Record<string, unknown> | undefined
  const metadataTier = metadata?.["contextTier"] ?? metadata?.["context_tier"]
  if (metadataTier === "128k" || metadataTier === "256k" || metadataTier === "384k") {
    return metadataTier
  }
  const leaseTier = SessionSlotLease.getSessionTier(session.id)
  if (leaseTier === "128k" || leaseTier === "256k" || leaseTier === "384k") {
    return leaseTier
  }
  if (agentInfo?.resources?.contextTier) {
    return agentInfo.resources.contextTier as "128k" | "256k" | "384k"
  }
  if (!session.parentID) {
    return "256k"
  }
  return "128k"
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const resolver = yield* ModelResolver.Service
    const agents = yield* Agent.Service
    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session, available) {
        const agentSelection = yield* agents.select(session.agent)
        const agentInfo = agentSelection.info
        let baseResolved: Resolved | undefined

        // Location plugins populate and filter the catalog asynchronously during layer startup.
        if (!session.model) {
          const agentModel = agentInfo?.model
          const preferred =
            agentModel &&
            (yield* available()).find((model) => model.providerID === agentModel.providerID && model.id === agentModel.id)
          baseResolved = preferred
            ? yield* resolver.resolveModel(preferred, agentModel.variant)
            : yield* resolver.resolve()
          if (!baseResolved) return yield* new ModelNotSelectedError({ sessionID: session.id })
        } else {
          const selected = (yield* available()).find(
            (model) => model.providerID === session.model?.providerID && model.id === session.model.id,
          )
          if (!selected)
            return yield* new ModelUnavailableError({
              providerID: session.model.providerID,
              modelID: session.model.id,
            })
          baseResolved = yield* resolver.resolveModel(selected, session.model.variant)
        }

        const tier = resolveSessionContextTier(session, agentInfo)
        const limit = { ...baseResolved.limit }
        const isDeepseekLocal =
          String(baseResolved.ref.providerID) === "deepseek-local" ||
          baseResolved.ref.id.includes("deepseek") ||
          baseResolved.ref.providerID.includes("deepseek")
        const reconciled = isDeepseekLocal && SessionSlotLease.isBackendReconciled()
        const configuredUnder96k =
          isDeepseekLocal && typeof baseResolved.limit.context === "number" && baseResolved.limit.context > 0 && baseResolved.limit.context <= 98304

        if (reconciled || configuredUnder96k) {
          const leadTokens = reconciled
            ? SessionSlotLease.getBackendLeadBlockTokens()
            : baseResolved.limit.context
          const quantumTokens = reconciled
            ? SessionSlotLease.getBackendQuantumTokens()
            : Math.max(1024, Math.floor(leadTokens / 3))
          if (tier === "128k") {
            limit.context = quantumTokens
            limit.output = Math.min(limit.output ?? 16384, quantumTokens <= 32768 ? 8192 : 16384) || 8192
          } else if (tier === "256k") {
            limit.context = Math.min(262144, leadTokens)
            limit.output = Math.min(limit.output ?? 32768, 32768) || 16384
          } else if (tier === "384k") {
            limit.context = leadTokens
            limit.output = Math.max(limit.output ?? 32768, 32768)
          }
        } else if (tier === "128k") {
          limit.context = 131072
          limit.output = Math.min(limit.output ?? 16384, 16384) || 8192
        } else if (tier === "256k") {
          limit.context = 262144
          limit.output = Math.min(limit.output ?? 32768, 32768) || 16384
        } else if (tier === "384k") {
          if (isDeepseekLocal) {
            limit.context = Math.max(limit.context ?? 393216, 393216)
            limit.output = Math.max(limit.output ?? 32768, 32768)
          }
        }

        return {
          ...baseResolved,
          limit,
        }
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [ModelResolver.node, Agent.node] })
