import { SessionSlotLease } from "@opencode/core/session/slot-lease"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"

export const SystemResourcesHandler = HttpApiBuilder.group(Api, "system.resources", (handlers) =>
  Effect.sync(() =>
    handlers
      .handle(
        "system.resources.snapshot",
        Effect.fn("system.resources.snapshot")(function* (ctx) {
          const snapshot = SessionSlotLease.getResourceSnapshot({
            conversationId: ctx.query.conversationId,
            sessionId: ctx.query.sessionId,
          })
          return snapshot
        }),
      )
      .handle(
        "system.resources.admit",
        Effect.fn("system.resources.admit")(function* (ctx) {
          const res = SessionSlotLease.admitConversation(ctx.payload)
          const snapshot = SessionSlotLease.getResourceSnapshot({ conversationId: ctx.payload.conversationId })
          return {
            admitted: res.admitted,
            reason: res.reason,
            leadSlotId: res.leadSlotId,
            leadBlockId: res.leadBlockId,
            snapshot,
          }
        }),
      )
      .handle(
        "system.resources.bind",
        Effect.fn("system.resources.bind")(function* (ctx) {
          const res = SessionSlotLease.bindConversationSession({
            conversationId: ctx.payload.conversationId,
            sessionID: ctx.payload.sessionId ?? ctx.payload.sessionID ?? "",
          })
          return { success: res.ok }
        }),
      )
      .handle(
        "system.resources.release",
        Effect.fn("system.resources.release")(function* (ctx) {
          const res = SessionSlotLease.releaseConversation(ctx.payload.conversationId)
          return { released: res.ok }
        }),
      ),
  ),
)
