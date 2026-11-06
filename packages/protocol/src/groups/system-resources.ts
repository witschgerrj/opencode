import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"

export const BuddyBlockInfo = Schema.Struct({
  blockId: Schema.Int,
  mode: Schema.Literals(["idle", "384k_locked", "128k_split"]),
  ownerConversationId: Schema.optional(Schema.String),
  slots: Schema.Array(Schema.Int),
}).annotate({ identifier: "BuddyBlockInfo" })
export type BuddyBlockInfo = typeof BuddyBlockInfo.Type

export const BuddySlotInfo = Schema.Struct({
  slotId: Schema.Int,
  capacityTokens: Schema.Int,
  busy: Schema.Boolean,
  lockedBy384k: Schema.Boolean,
  activeSessionIds: Schema.Array(Schema.String),
  pinnedSessionId: Schema.optional(Schema.String),
}).annotate({ identifier: "BuddySlotInfo" })
export type BuddySlotInfo = typeof BuddySlotInfo.Type

export const AdmittedConversationInfo = Schema.Struct({
  conversationId: Schema.String,
  agentId: Schema.optional(Schema.String),
  rootSessionId: Schema.optional(Schema.String),
  leadSlotId: Schema.Int,
  reservedSubagentQuanta: Schema.Int,
  activeSubagentQuanta: Schema.Int,
  activeSubagentCount: Schema.Int,
  maxConcurrentSubagents: Schema.optional(Schema.Int),
}).annotate({ identifier: "AdmittedConversationInfo" })
export type AdmittedConversationInfo = typeof AdmittedConversationInfo.Type

export const ThisConversationInfo = Schema.Struct({
  conversationId: Schema.String,
  leadContextTier: Schema.Literal("384k"),
  leadContextTokens: Schema.optional(Schema.Int),
  subagentQuantumTokens: Schema.optional(Schema.Int),
  leadSlotId: Schema.Int,
  reservedSubagents128k: Schema.Int,
  activeSubagents: Schema.Int,
  activeSubagentQuanta128k: Schema.Int,
  guaranteedAvailable128k: Schema.Int,
  opportunisticAvailable128k: Schema.Int,
  maxSpawnableNow128k: Schema.Int,
  maxSpawnableNow384k: Schema.Int,
  queuedSubagentWaiters: Schema.Int,
}).annotate({ identifier: "ThisConversationInfo" })
export type ThisConversationInfo = typeof ThisConversationInfo.Type

export const SystemResourceSnapshot = Schema.Struct({
  generation: Schema.Int,
  totalQuanta128k: Schema.Int,
  totalTokens: Schema.Int,
  committedQuanta128k: Schema.Int,
  activeQuanta128k: Schema.Int,
  unreservedFreeQuanta128k: Schema.Int,
  unreservedFreeTokens: Schema.Int,
  freeFullBlocks384k: Schema.Int,
  canAdmitNewLeadConversation: Schema.Boolean,
  backendReconciled: Schema.optional(Schema.Boolean),
  backendLeadBlockTokens: Schema.optional(Schema.Int),
  backendQuantumTokens: Schema.optional(Schema.Int),
  configuredContextTokens: Schema.optional(Schema.Int),
  capacityMismatch: Schema.optional(Schema.Boolean),
  blocks: Schema.Array(BuddyBlockInfo),
  slots: Schema.Array(BuddySlotInfo),
  conversations: Schema.Array(AdmittedConversationInfo),
  thisConversation: Schema.optional(ThisConversationInfo),
}).annotate({ identifier: "SystemResourceSnapshot" })
export type SystemResourceSnapshot = typeof SystemResourceSnapshot.Type

export const AdmitConversationInput = Schema.Struct({
  conversationId: Schema.String,
  agentId: Schema.optional(Schema.String),
  rootSessionId: Schema.optional(Schema.String),
  reservedSubagentQuanta: Schema.optional(Schema.Int),
  maxConcurrentSubagents: Schema.optional(Schema.Int),
  resources: Schema.optional(
    Schema.Struct({
      contextTier: Schema.optional(Schema.Literals(["128k", "384k"])),
      reservedSubagents: Schema.optional(
        Schema.Struct({
          count: Schema.Int,
          contextTier: Schema.Literals(["128k", "384k"]),
        }),
      ),
      maxConcurrentSubagents: Schema.optional(Schema.Int),
    }),
  ),
}).annotate({ identifier: "AdmitConversationInput" })
export type AdmitConversationInput = typeof AdmitConversationInput.Type

export const AdmitConversationResult = Schema.Struct({
  admitted: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  leadSlotId: Schema.optional(Schema.Int),
  leadBlockId: Schema.optional(Schema.Int),
  snapshot: SystemResourceSnapshot,
}).annotate({ identifier: "AdmitConversationResult" })
export type AdmitConversationResult = typeof AdmitConversationResult.Type

export const BindConversationInput = Schema.Struct({
  conversationId: Schema.String,
  sessionId: Schema.optional(Schema.String),
  sessionID: Schema.optional(Schema.String),
}).annotate({ identifier: "BindConversationInput" })
export type BindConversationInput = typeof BindConversationInput.Type

export const BindConversationResult = Schema.Struct({
  success: Schema.Boolean,
}).annotate({ identifier: "BindConversationResult" })
export type BindConversationResult = typeof BindConversationResult.Type

export const ReleaseConversationInput = Schema.Struct({
  conversationId: Schema.String,
}).annotate({ identifier: "ReleaseConversationInput" })
export type ReleaseConversationInput = typeof ReleaseConversationInput.Type

export const ReleaseConversationResult = Schema.Struct({
  released: Schema.Boolean,
}).annotate({ identifier: "ReleaseConversationResult" })
export type ReleaseConversationResult = typeof ReleaseConversationResult.Type

export const SystemResourcesGroup = HttpApiGroup.make("system.resources")
  .add(
    HttpApiEndpoint.get("system.resources.snapshot", "/api/system/resources/snapshot", {
      query: Schema.Struct({
        conversationId: Schema.String.pipe(Schema.optional),
        sessionId: Schema.String.pipe(Schema.optional),
      }),
      success: SystemResourceSnapshot,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "system.resources.snapshot",
        summary: "Get atomic resource coordinator snapshot",
        description: "Returns the 9-quantum 3-block Buddy Arena snapshot.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("system.resources.admit", "/api/system/resources/conversations/admit", {
      payload: AdmitConversationInput,
      success: AdmitConversationResult,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "system.resources.admit",
        summary: "Admit a lead conversation into the atomic coordinator",
        description: "Attempts to admit a conversation with reservations.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("system.resources.bind", "/api/system/resources/conversations/bind", {
      payload: BindConversationInput,
      success: BindConversationResult,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "system.resources.bind",
        summary: "Bind a session to an admitted conversation",
        description: "Binds root session to conversation.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("system.resources.release", "/api/system/resources/conversations/release", {
      payload: ReleaseConversationInput,
      success: ReleaseConversationResult,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "system.resources.release",
        summary: "Release an admitted conversation",
        description: "Releases conversation and cleans up slots.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "system-resources" }))
