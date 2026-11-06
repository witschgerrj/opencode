export * as SendMessageTool from "./send-message.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { DateTime, Effect, Predicate, Schema } from "effect"
import { Permission } from "../../permission.js"
import { PositiveInt, optional } from "../../schema.js"
import { Session } from "../../session.js"
import { AquanoxTrace } from "../../session/aquanox-trace.js"
import { SessionInbox } from "../../session/inbox.js"
import { SessionMessage } from "../../session/message.js"
import { SessionSlotLease } from "../../session/slot-lease.js"

export const name = "send_message"

const ScopeSchema = Schema.Literals(["all", "same_conversation", "cross_conversation"])
const RelationshipSchema = Schema.Literals([
  "self",
  "root",
  "parent",
  "child",
  "sibling",
  "family",
  "cross_conversation",
])
const DeliverySchema = Schema.Literals(["steer", "queue"])
const ActionSchema = Schema.Literals(["send", "list", "read", "delete"])

export const PeerSession = Schema.Struct({
  sessionID: Session.ID,
  rootSessionID: Session.ID,
  parentID: Session.ID.pipe(optional),
  conversationID: Schema.String.pipe(optional),
  agent: Schema.String.pipe(optional),
  title: Schema.String,
  directory: Schema.String,
  scope: Schema.Literals(["same_conversation", "cross_conversation"]),
  relationship: RelationshipSchema,
  active: Schema.Boolean,
  pendingInboxCount: Schema.Number,
  updatedAt: Schema.Number,
  latestSummary: Schema.String.pipe(optional),
})
export type PeerSession = typeof PeerSession.Type

export const DeliveredReceipt = Schema.Struct({
  messageID: SessionMessage.ID,
  recipientSessionID: Session.ID,
  recipientRootSessionID: Session.ID,
  recipientConversationID: Schema.String.pipe(optional),
  recipientAgent: Schema.String.pipe(optional),
  recipientTitle: Schema.String,
  scope: Schema.Literals(["same_conversation", "cross_conversation"]),
  relationship: RelationshipSchema,
  delivery: DeliverySchema,
  woke: Schema.Boolean,
})
export type DeliveredReceipt = typeof DeliveredReceipt.Type

export const DeletedReceipt = Schema.Struct({
  sessionID: Session.ID,
  rootSessionID: Session.ID,
  conversationID: Schema.String.pipe(optional),
  agent: Schema.String.pipe(optional),
  title: Schema.String,
  directory: Schema.String,
  updatedAt: Schema.Number,
})
export type DeletedReceipt = typeof DeletedReceipt.Type

export const MessagePreview = Schema.Struct({
  id: SessionMessage.ID,
  type: Schema.String,
  role: Schema.String,
  agent: Schema.String.pipe(optional),
  createdAt: Schema.Number,
  preview: Schema.String,
})
export type MessagePreview = typeof MessagePreview.Type

export const Input = Schema.Struct({
  action: ActionSchema.annotate({
    description:
      "Operation to perform: 'send' delivers a message to a target agent/session or conversation; 'list' discovers sessions in the current conversation family and/or across other conversations; 'read' inspects recent messages and status of a target session or conversation without waking it; 'delete' proposes deleting one or more idle conversations associated with the user's account (requires explicit user approval).",
  }).pipe(optional),
  recipient: Schema.String.annotate({
    description:
      "Target agent, session, or conversation. Supports: (1) intra-conversation targets: 'parent', 'root', 'siblings' (or 'peers'), 'children' (or 'subagents'), 'family', or a session ID ('ses_...'); (2) cross-conversation targets: an Aquanox conversation ID ('task_...'), another conversation's root/child session ID ('ses_...'), or a session/conversation title or agent name.",
  }).pipe(optional),
  recipients: Schema.Array(Schema.String)
    .annotate({
      description:
        "When action='delete', optional list of target conversation IDs ('task_...'), root session IDs ('ses_...'), or titles to propose deleting.",
    })
    .pipe(optional),
  olderThanHours: Schema.Finite.annotate({
    description:
      "When action='delete', select idle conversations whose last update is older than this many hours (e.g. 20).",
  }).pipe(optional),
  before: Schema.String.annotate({
    description:
      "When action='delete', ISO-8601 timestamp cutoff; selects idle conversations last updated strictly before this time.",
  }).pipe(optional),
  message: Schema.String.annotate({
    description:
      "Markdown message content to deliver when action is 'send'. Include concrete contracts, file paths, findings, or questions.",
  }).pipe(optional),
  summary: Schema.String.annotate({
    description: "Short 3-10 word subject summary of the message for transcript and trace headers.",
  }).pipe(optional),
  delivery: DeliverySchema.annotate({
    description:
      "Inbox delivery mode when action is 'send': 'steer' (default) injects at the next step boundary of a running session; 'queue' waits until the target finishes its current turn.",
  }).pipe(optional),
  wake: Schema.Boolean.annotate({
    description:
      "Whether to wake/resume the target session immediately if it is currently idle (default: true). Set to false to deposit a passive note into the target's inbox without triggering an inference turn.",
  }).pipe(optional),
  scope: ScopeSchema.annotate({
    description:
      "Discovery or resolution scope: 'all' (default), 'same_conversation' (only current root + subagent tree), or 'cross_conversation' (other conversations in this workspace/project).",
  }).pipe(optional),
  query: Schema.String.annotate({
    description:
      "Optional case-insensitive filter matched against session ID, conversation ID, title, agent, or directory when listing, resolving, or deleting conversations.",
  }).pipe(optional),
  includeSubagents: Schema.Boolean.annotate({
    description:
      "When listing cross-conversation targets, whether to also include child subagent sessions of other conversations (default: false).",
  }).pipe(optional),
  limit: PositiveInt.annotate({
    description: "Maximum number of conversations or messages to return for 'list', 'read', or 'delete' (default: 12, max: 50).",
  }).pipe(optional),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({
  action: ActionSchema,
  sender: Schema.Struct({
    sessionID: Session.ID,
    rootSessionID: Session.ID,
    conversationID: Schema.String.pipe(optional),
    agent: Schema.String,
    title: Schema.String,
  }),
  delivered: Schema.Array(DeliveredReceipt).pipe(optional),
  deleted: Schema.Array(DeletedReceipt).pipe(optional),
  sameConversation: Schema.Array(PeerSession).pipe(optional),
  crossConversations: Schema.Array(PeerSession).pipe(optional),
  inspected: Schema.Struct({
    target: PeerSession,
    messages: Schema.Array(MessagePreview),
  }).pipe(optional),
})
export type Output = typeof Output.Type

export const DESCRIPTION = [
  "Communicate with other DeepSeek agents within the same conversation (parent/root, child subagents, concurrent sibling subagents) or across different conversations, and propose owner-scoped conversation cleanup.",
  "",
  "Capabilities:",
  "- action='list': Discover active and recent sessions in the current conversation family ('sameConversation') and across other conversations ('crossConversations'), including sessionID, conversationID ('task_...'), agent type, title, active status, pending inbox count, and latest summary.",
  "- action='read': Inspect recent messages and status of a sibling session or another conversation without waking it or consuming an inference slot.",
  "- action='send': Deliver a structured '<agent-message>' to any recipient within the same conversation ('parent', 'root', 'siblings', 'children', 'family', or 'ses_...') or across conversations ('task_...', 'ses_...', or conversation title).",
  "- action='delete': Propose permanent deletion of idle conversations associated with the user's account (by 'recipient'/'recipients', 'olderThanHours', 'before', or 'query'). Always presents a user approval card before deleting.",
  "",
  "Delivery guidance:",
  "- Use delivery='steer' (default) when handing off a contract/schema to a concurrently running sibling or steering an active session at its next step boundary.",
  "- Use delivery='queue' when sending follow-up work that should wait until the recipient completes its current turn.",
  "- Set wake=false when depositing passive context into an idle session/conversation without triggering an immediate LLM turn.",
  "- Do NOT send bare acknowledgement replies ('received', 'thanks') that wake another agent without new information or required action.",
].join("\n")

const extractConversationID = (session: Session.Info, rootSession: Session.Info): string | undefined => {
  for (const candidate of [session, rootSession]) {
    const meta = candidate.metadata
    if (!meta || typeof meta !== "object") continue
    const raw =
      (typeof meta.aquanoxConversationId === "string" && meta.aquanoxConversationId.trim()) ||
      (typeof meta.conversationId === "string" && meta.conversationId.trim()) ||
      (typeof meta.taskId === "string" && meta.taskId.trim()) ||
      undefined
    if (raw) return raw
  }
  return undefined
}

const extractOwnerUserID = (session: Session.Info, rootSession: Session.Info): string | undefined => {
  for (const candidate of [session, rootSession]) {
    const meta = candidate.metadata
    if (!meta || typeof meta !== "object") continue
    const raw =
      (typeof meta.aquanoxOwnerUserId === "string" && meta.aquanoxOwnerUserId.trim()) ||
      (typeof meta.ownerUserId === "string" && meta.ownerUserId.trim()) ||
      undefined
    if (raw) return raw
  }
  return undefined
}

const isSameOwnerOrUnscoped = (
  senderOwnerUserID: string | undefined,
  target: Session.Info,
  targetRoot: Session.Info,
): boolean => {
  if (!senderOwnerUserID) return true
  const targetOwner = extractOwnerUserID(target, targetRoot)
  if (!targetOwner) return true
  return targetOwner === senderOwnerUserID
}

const summarizeMessage = (msg: SessionMessage.Info): MessagePreview => {
  const createdAt = DateTime.toEpochMillis(msg.time.created)
  if (msg.type === "user") {
    return {
      id: msg.id,
      type: "user",
      role: "user",
      createdAt,
      preview: msg.text.replace(/\s+/g, " ").trim().slice(0, 280),
    }
  }
  if (msg.type === "synthetic") {
    const raw = (msg.description && msg.description.trim()) || msg.text
    return {
      id: msg.id,
      type: "synthetic",
      role: "user",
      createdAt,
      preview: raw.replace(/\s+/g, " ").trim().slice(0, 280),
    }
  }
  if (msg.type === "compaction") {
    const summaryText = "summary" in msg && typeof msg.summary === "string" ? msg.summary : "Compaction checkpoint"
    return {
      id: msg.id,
      type: "compaction",
      role: "system",
      createdAt,
      preview: summaryText.replace(/\s+/g, " ").trim().slice(0, 280),
    }
  }
  if (msg.type !== "assistant") {
    return {
      id: msg.id,
      type: msg.type,
      role: "system",
      createdAt,
      preview: msg.type,
    }
  }
  const textParts: string[] = []
  const toolNames: string[] = []
  for (const part of msg.content) {
    if (part.type === "text" && part.text.trim()) {
      textParts.push(part.text.trim())
    } else if (part.type === "tool") {
      toolNames.push(part.name)
    }
  }
  const joinedText = textParts.join(" ").replace(/\s+/g, " ").trim()
  const toolSuffix = toolNames.length > 0 ? `[tools: ${toolNames.join(", ")}]` : ""
  const combined = [joinedText, toolSuffix].filter(Boolean).join(" ").trim() || "(assistant step)"
  return {
    id: msg.id,
    type: "assistant",
    role: "assistant",
    agent: String(msg.agent),
    createdAt,
    preview: combined.slice(0, 280),
  }
}

const summarizeInboxItem = (item: SessionInbox.Info): MessagePreview => {
  const createdAt = DateTime.toEpochMillis(item.time.created)
  if (item.type === "synthetic") {
    const raw = (item.payload.description && item.payload.description.trim()) || item.payload.text
    return {
      id: item.id,
      type: `inbox:synthetic(${item.delivery})`,
      role: "user",
      createdAt,
      preview: raw.replace(/\s+/g, " ").trim().slice(0, 280),
    }
  }
  if (item.type === "user") {
    return {
      id: item.id,
      type: `inbox:user(${item.delivery})`,
      role: "user",
      createdAt,
      preview: item.payload.text.replace(/\s+/g, " ").trim().slice(0, 280),
    }
  }
  return {
    id: item.id,
    type: `inbox:${item.type}(${item.delivery})`,
    role: "system",
    createdAt,
    preview: `Pending ${item.type} (${item.delivery})`,
  }
}

const deriveSummary = (message: string, explicitSummary?: string): string => {
  if (explicitSummary && explicitSummary.trim().length > 0) {
    return explicitSummary.trim().slice(0, 120)
  }
  const firstLine =
    message
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find((line) => line.length > 0) ?? "Agent message"
  return firstLine.length > 96 ? `${firstLine.slice(0, 93)}...` : firstLine
}

export const Plugin = {
  id: "opencode.tool.send_message",
  effect: Effect.fn("SendMessageTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const permissions = yield* Permission.Service

    const rootCache = new Map<Session.ID, Session.Info>()

    const resolveRoot = (session: Session.Info): Effect.Effect<Session.Info> =>
      Effect.gen(function* () {
        if (!session.parentID) return session
        const cached = rootCache.get(session.id)
        if (cached) return cached
        let current: Session.Info = session
        const visited = new Set<Session.ID>([session.id])
        while (current.parentID && !visited.has(current.parentID)) {
          visited.add(current.parentID)
          const parent = yield* sessions
            .get(current.parentID)
            .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)))
          if (!parent) break
          current = parent
        }
        rootCache.set(session.id, current)
        return current
      })

    const classifyRelationship = (
      sender: Session.Info,
      senderRoot: Session.Info,
      target: Session.Info,
      targetRoot: Session.Info,
    ): {
      readonly scope: "same_conversation" | "cross_conversation"
      readonly relationship: typeof RelationshipSchema.Type
    } => {
      if (targetRoot.id !== senderRoot.id) {
        return { scope: "cross_conversation", relationship: "cross_conversation" }
      }
      if (target.id === sender.id) {
        return { scope: "same_conversation", relationship: "self" }
      }
      if (sender.parentID && target.id === sender.parentID) {
        return { scope: "same_conversation", relationship: "parent" }
      }
      if (target.id === senderRoot.id) {
        return { scope: "same_conversation", relationship: "root" }
      }
      if (target.parentID === sender.id) {
        return { scope: "same_conversation", relationship: "child" }
      }
      if (sender.parentID && target.parentID === sender.parentID) {
        return { scope: "same_conversation", relationship: "sibling" }
      }
      return { scope: "same_conversation", relationship: "family" }
    }

    const collectFamilyTree = (root: Session.Info): Effect.Effect<Session.Info[]> =>
      Effect.gen(function* () {
        const result: Session.Info[] = [root]
        const seen = new Set<Session.ID>([root.id])
        const queue: Session.ID[] = [root.id]
        while (queue.length > 0 && result.length < 64) {
          const parentID = queue.shift()!
          const listed = yield* sessions
            .list({ parentID, limit: 50 })
            .pipe(Effect.orElseSucceed(() => ({ data: [] as Session.Info[], cursor: {} })))
          for (const child of listed.data) {
            if (seen.has(child.id)) continue
            seen.add(child.id)
            rootCache.set(child.id, root)
            result.push(child)
            queue.push(child.id)
          }
        }
        return result
      })

    const buildPeerInfo = (
      sender: Session.Info,
      senderRoot: Session.Info,
      target: Session.Info,
      targetRoot: Session.Info,
      activeSet: ReadonlySet<Session.ID>,
      includeLatestSummary: boolean,
    ): Effect.Effect<PeerSession> =>
      Effect.gen(function* () {
        const { scope, relationship } = classifyRelationship(sender, senderRoot, target, targetRoot)
        const inboxItems = yield* sessions
          .inbox(target.id)
          .pipe(Effect.orElseSucceed(() => []))
        let latestSummary: string | undefined
        if (includeLatestSummary) {
          const recent = yield* sessions
            .messages({ sessionID: target.id, limit: 3, order: "desc" })
            .pipe(Effect.orElseSucceed(() => [] as SessionMessage.Info[]))
          const meaningful = recent.find((m) => m.type === "assistant" || m.type === "user" || m.type === "synthetic")
          if (meaningful) {
            latestSummary = summarizeMessage(meaningful).preview
          } else if (inboxItems.length > 0) {
            latestSummary = summarizeInboxItem(inboxItems[inboxItems.length - 1]!).preview
          }
        }
        const conversationID = extractConversationID(target, targetRoot)
        return {
          sessionID: target.id,
          rootSessionID: targetRoot.id,
          ...(target.parentID ? { parentID: target.parentID } : {}),
          ...(conversationID ? { conversationID } : {}),
          ...(target.agent ? { agent: String(target.agent) } : {}),
          title: target.title ?? target.id,
          directory: String(target.location.directory),
          scope,
          relationship,
          active: activeSet.has(target.id),
          pendingInboxCount: inboxItems.length,
          updatedAt: DateTime.toEpochMillis(target.time.updated),
          ...(latestSummary ? { latestSummary } : {}),
        }
      })

    const matchesQuery = (peer: PeerSession, query?: string): boolean => {
      if (!query) return true
      const q = query.toLowerCase()
      return (
        peer.sessionID.toLowerCase().includes(q) ||
        peer.rootSessionID.toLowerCase().includes(q) ||
        (peer.conversationID?.toLowerCase().includes(q) ?? false) ||
        (peer.agent?.toLowerCase().includes(q) ?? false) ||
        peer.title.toLowerCase().includes(q) ||
        peer.directory.toLowerCase().includes(q) ||
        peer.relationship.toLowerCase().includes(q)
      )
    }

    const resolveTargets = (
      sender: Session.Info,
      senderRoot: Session.Info,
      recipientRaw: string,
      scopeFilter: typeof ScopeSchema.Type,
    ): Effect.Effect<Array<{ readonly target: Session.Info; readonly targetRoot: Session.Info }>, ToolFailure> =>
      Effect.gen(function* () {
        const token = recipientRaw.trim()
        const lower = token.toLowerCase()
        const family = yield* collectFamilyTree(senderRoot)

        if (scopeFilter !== "cross_conversation") {
          if (lower === "parent") {
            if (!sender.parentID) {
              return yield* new ToolFailure({
                message:
                  "Current session is already the root session of this conversation and has no parent. Specify 'children', a child 'ses_...' ID, or a cross-conversation target ('task_...' or 'ses_...').",
              })
            }
            const parent =
              family.find((s) => s.id === sender.parentID) ??
              (yield* sessions
                .get(sender.parentID)
                .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined))))
            if (!parent) {
              return yield* new ToolFailure({ message: `Parent session ${sender.parentID} was not found.` })
            }
            return [{ target: parent, targetRoot: senderRoot }]
          }

          if (lower === "root") {
            if (sender.id === senderRoot.id) {
              return yield* new ToolFailure({
                message:
                  "Current session is already the root session. Specify 'children', a child 'ses_...' ID, or a cross-conversation target.",
              })
            }
            return [{ target: senderRoot, targetRoot: senderRoot }]
          }

          if (lower === "siblings" || lower === "sibling" || lower === "peers" || lower === "peer") {
            if (!sender.parentID) {
              return yield* new ToolFailure({
                message:
                  "Root session has no siblings. Use 'children' to message child subagents or specify a cross-conversation target.",
              })
            }
            const siblings = family.filter((s) => s.parentID === sender.parentID && s.id !== sender.id)
            if (siblings.length === 0) {
              return yield* new ToolFailure({
                message: "No sibling subagent sessions exist in the current conversation.",
              })
            }
            return siblings.map((target) => ({ target, targetRoot: senderRoot }))
          }

          if (lower === "children" || lower === "subagents") {
            const children = family.filter((s) => s.parentID === sender.id)
            if (children.length === 0) {
              return yield* new ToolFailure({
                message: "Current session has no direct child subagent sessions.",
              })
            }
            return children.map((target) => ({ target, targetRoot: senderRoot }))
          }

          if (lower === "family" || lower === "same_conversation" || lower === "all_same_conversation") {
            const others = family.filter((s) => s.id !== sender.id)
            if (others.length === 0) {
              return yield* new ToolFailure({
                message: "No other sessions exist in the current conversation family yet.",
              })
            }
            return others.map((target) => ({ target, targetRoot: senderRoot }))
          }
        }

        // Exact session ID lookup (ses_...)
        if (token.startsWith("ses_")) {
          const found = yield* sessions
            .get(Session.ID.make(token))
            .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)))
          if (found) {
            const targetRoot = yield* resolveRoot(found)
            const senderOwner = extractOwnerUserID(sender, senderRoot)
            if (targetRoot.id !== senderRoot.id && !isSameOwnerOrUnscoped(senderOwner, found, targetRoot)) {
              return yield* new ToolFailure({
                message: `Session ${found.id} belongs to another account and cannot be accessed.`,
              })
            }
            if (scopeFilter === "same_conversation" && targetRoot.id !== senderRoot.id) {
              return yield* new ToolFailure({
                message: `Session ${found.id} belongs to another conversation (${targetRoot.id}), but scope='same_conversation' was requested.`,
              })
            }
            if (scopeFilter === "cross_conversation" && targetRoot.id === senderRoot.id) {
              return yield* new ToolFailure({
                message: `Session ${found.id} belongs to the current conversation (${senderRoot.id}), but scope='cross_conversation' was requested.`,
              })
            }
            return [{ target: found, targetRoot }]
          }
        }

        // Check same-conversation family by agent name or title substring
        if (scopeFilter !== "cross_conversation") {
          const familyMatches = family.filter(
            (s) =>
              s.id !== sender.id &&
              (String(s.agent ?? "").toLowerCase() === lower ||
                (s.title ?? "").toLowerCase() === lower ||
                (s.title ?? "").toLowerCase().includes(lower)),
          )
          if (familyMatches.length > 0) {
            return familyMatches.map((target) => ({ target, targetRoot: senderRoot }))
          }
        }

        // Cross-conversation search across root sessions (by conversationID 'task_...', sessionID, title, or agent)
        if (scopeFilter !== "same_conversation") {
          const senderOwner = extractOwnerUserID(sender, senderRoot)
          const rootsList = yield* sessions
            .list({ parentID: null, limit: 50 })
            .pipe(Effect.orElseSucceed(() => ({ data: [] as Session.Info[], cursor: {} })))
          const otherRoots = rootsList.data.filter(
            (r) => r.id !== senderRoot.id && isSameOwnerOrUnscoped(senderOwner, r, r),
          )

          const exactConv = otherRoots.find((r) => {
            const cid = extractConversationID(r, r)
            return cid !== undefined && cid.toLowerCase() === lower
          })
          if (exactConv) {
            return [{ target: exactConv, targetRoot: exactConv }]
          }

          const titleOrCidMatches = otherRoots.filter((r) => {
            const cid = extractConversationID(r, r)
            return (
              (r.title ?? "").toLowerCase() === lower ||
              (r.title ?? "").toLowerCase().includes(lower) ||
              (cid !== undefined && cid.toLowerCase().includes(lower)) ||
              String(r.agent ?? "").toLowerCase() === lower
            )
          })
          if (titleOrCidMatches.length > 0) {
            const chosen = titleOrCidMatches[0]!
            return [{ target: chosen, targetRoot: chosen }]
          }
        }

        return yield* new ToolFailure({
          message: `Could not resolve recipient "${recipientRaw}". Call send_message with action="list" to inspect available same-conversation and cross-conversation targets.`,
        })
      })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          description: DESCRIPTION,
          options: { codemode: false },
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const action: typeof ActionSchema.Type =
                input.action ??
                (input.olderThanHours !== undefined || input.before !== undefined || (input.recipients?.length ?? 0) > 0
                  ? "delete"
                  : input.recipient
                    ? input.message && input.message.trim().length > 0
                      ? "send"
                      : "read"
                    : "list")

              if (action !== "delete") {
                const resource = input.recipient?.trim() || action
                yield* permissions
                  .assert({
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: {
                      type: "tool",
                      messageID: context.messageID,
                      id: context.id,
                    },
                    action: name,
                    resources: [resource],
                  })
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: "Permission denied for send_message", error }),
                    ),
                  )
              } else {
                yield* permissions
                  .assertNotDenied({
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: {
                      type: "tool",
                      messageID: context.messageID,
                      id: context.id,
                    },
                    action: name,
                    resources: ["delete:*"],
                  })
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: "Permission denied for conversation deletion", error }),
                    ),
                  )
              }

              const sender = yield* sessions
                .get(context.sessionID)
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Caller session ${context.sessionID} was not found.`, error }),
                  ),
                )
              const senderRoot = yield* resolveRoot(sender)
              const senderConversationID = extractConversationID(sender, senderRoot)
              const senderOwnerUserID = extractOwnerUserID(sender, senderRoot)
              const senderAgent = String(sender.agent ?? context.agent)
              const scopeFilter = input.scope ?? "all"
              const limit = Math.min(50, Math.max(1, input.limit ?? 12))
              const activeSet = yield* sessions.active

              const senderSummary = {
                sessionID: sender.id,
                rootSessionID: senderRoot.id,
                ...(senderConversationID ? { conversationID: senderConversationID } : {}),
                agent: senderAgent,
                title: sender.title ?? sender.id,
              }

              if (action === "list") {
                const sameConversation: PeerSession[] = []
                const crossConversations: PeerSession[] = []

                if (scopeFilter !== "cross_conversation") {
                  const family = yield* collectFamilyTree(senderRoot)
                  for (const member of family) {
                    const peer = yield* buildPeerInfo(sender, senderRoot, member, senderRoot, activeSet, true)
                    if (matchesQuery(peer, input.query)) {
                      sameConversation.push(peer)
                    }
                  }
                }

                if (scopeFilter !== "same_conversation") {
                  const rootsList = yield* sessions
                    .list({ parentID: null, limit: Math.max(limit * 2, 24) })
                    .pipe(Effect.orElseSucceed(() => ({ data: [] as Session.Info[], cursor: {} })))
                  for (const otherRoot of rootsList.data) {
                    if (otherRoot.id === senderRoot.id) continue
                    if (!isSameOwnerOrUnscoped(senderOwnerUserID, otherRoot, otherRoot)) continue
                    if (crossConversations.length >= limit) break
                    const rootPeer = yield* buildPeerInfo(sender, senderRoot, otherRoot, otherRoot, activeSet, true)
                    if (matchesQuery(rootPeer, input.query)) {
                      crossConversations.push(rootPeer)
                    }
                    if (input.includeSubagents && crossConversations.length < limit) {
                      const otherFamily = yield* collectFamilyTree(otherRoot)
                      for (const sub of otherFamily) {
                        if (sub.id === otherRoot.id) continue
                        if (crossConversations.length >= limit) break
                        const subPeer = yield* buildPeerInfo(sender, senderRoot, sub, otherRoot, activeSet, true)
                        if (matchesQuery(subPeer, input.query)) {
                          crossConversations.push(subPeer)
                        }
                      }
                    }
                  }
                }

                const lines: string[] = [
                  `Sender: ${sender.id} (agent=${senderAgent}, root=${senderRoot.id}${senderConversationID ? `, conversation=${senderConversationID}` : ""}, title=${JSON.stringify(sender.title ?? sender.id)})`,
                ]
                if (scopeFilter !== "cross_conversation") {
                  lines.push("", `Same-Conversation Sessions (${sameConversation.length}):`)
                  for (const p of sameConversation) {
                    lines.push(
                      `- [${p.relationship}] ${p.sessionID} (agent=${p.agent ?? "primary"}, active=${p.active}, inbox=${p.pendingInboxCount}) — ${JSON.stringify(p.title)}${p.latestSummary ? ` | latest: ${p.latestSummary}` : ""}`,
                    )
                  }
                }
                if (scopeFilter !== "same_conversation") {
                  lines.push("", `Cross-Conversation Sessions (${crossConversations.length}):`)
                  if (crossConversations.length === 0) {
                    lines.push("- (none)")
                  } else {
                    for (const p of crossConversations) {
                      lines.push(
                        `- [${p.conversationID ?? "root"}] ${p.sessionID} (agent=${p.agent ?? "primary"}, active=${p.active}, inbox=${p.pendingInboxCount}, dir=${p.directory}) — ${JSON.stringify(p.title)}${p.latestSummary ? ` | latest: ${p.latestSummary}` : ""}`,
                      )
                    }
                  }
                }

                return {
                  content: lines.join("\n"),
                  output: {
                    action: "list" as const,
                    sender: senderSummary,
                    sameConversation,
                    crossConversations,
                  },
                }
              }

              if (action === "delete") {
                const rawTokens: string[] = []
                if (input.recipient && input.recipient.trim().length > 0) {
                  const trimmed = input.recipient.trim()
                  const split = trimmed
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean)
                  if (split.length > 1 && split.every((s) => s.startsWith("task_") || s.startsWith("ses_"))) {
                    rawTokens.push(...split)
                  } else {
                    rawTokens.push(trimmed)
                  }
                }
                if (input.recipients && input.recipients.length > 0) {
                  for (const item of input.recipients) {
                    if (typeof item === "string" && item.trim().length > 0) {
                      rawTokens.push(item.trim())
                    }
                  }
                }

                let cutoffMs: number | undefined
                if (input.olderThanHours !== undefined) {
                  if (!Number.isFinite(input.olderThanHours) || input.olderThanHours < 0) {
                    return yield* new ToolFailure({
                      message: "olderThanHours must be a non-negative number.",
                    })
                  }
                  cutoffMs = Date.now() - input.olderThanHours * 3_600_000
                }
                if (input.before !== undefined && input.before.trim().length > 0) {
                  const parsed = Date.parse(input.before.trim())
                  if (!Number.isFinite(parsed)) {
                    return yield* new ToolFailure({
                      message: `Invalid ISO timestamp for 'before': ${JSON.stringify(input.before)}`,
                    })
                  }
                  cutoffMs = cutoffMs === undefined ? parsed : Math.min(cutoffMs, parsed)
                }

                const hasFilter = Boolean(input.query?.trim()) || cutoffMs !== undefined
                if (rawTokens.length === 0 && !hasFilter) {
                  return yield* new ToolFailure({
                    message:
                      'action="delete" requires at least one selector: recipient, recipients, olderThanHours, before, or query.',
                  })
                }

                // Prevent self-deletion when explicitly requested
                for (const tok of rawTokens) {
                  const lowerTok = tok.toLowerCase()
                  if (
                    lowerTok === sender.id.toLowerCase() ||
                    lowerTok === senderRoot.id.toLowerCase() ||
                    (senderConversationID && lowerTok === senderConversationID.toLowerCase()) ||
                    lowerTok === "self" ||
                    lowerTok === "root" ||
                    lowerTok === "parent" ||
                    lowerTok === "same_conversation"
                  ) {
                    return yield* new ToolFailure({
                      message: `Cannot delete the currently running conversation (${senderConversationID ?? senderRoot.id}).`,
                    })
                  }
                }

                const rootsList = yield* sessions
                  .list({ parentID: null, limit: 100 })
                  .pipe(Effect.orElseSucceed(() => ({ data: [] as Session.Info[], cursor: {} })))

                interface CandidateDelete {
                  readonly root: Session.Info
                  readonly peer: PeerSession
                  readonly explicitByID: boolean
                }
                const candidates: CandidateDelete[] = []
                const seenRoots = new Set<Session.ID>()

                for (const otherRoot of rootsList.data) {
                  if (otherRoot.id === senderRoot.id) continue
                  if (!isSameOwnerOrUnscoped(senderOwnerUserID, otherRoot, otherRoot)) continue
                  if (candidates.length >= limit) break

                  const cid = extractConversationID(otherRoot, otherRoot)
                  const title = otherRoot.title ?? otherRoot.id
                  const updatedMs = DateTime.toEpochMillis(otherRoot.time.updated)

                  let matched = false
                  let explicitByID = false

                  if (rawTokens.length > 0) {
                    for (const tok of rawTokens) {
                      const lowerTok = tok.toLowerCase()
                      if (
                        otherRoot.id.toLowerCase() === lowerTok ||
                        (cid !== undefined && cid.toLowerCase() === lowerTok)
                      ) {
                        matched = true
                        explicitByID = true
                        break
                      }
                      if (
                        title.toLowerCase() === lowerTok ||
                        title.toLowerCase().includes(lowerTok) ||
                        (cid !== undefined && cid.toLowerCase().includes(lowerTok))
                      ) {
                        matched = true
                      }
                    }
                  } else {
                    matched = true
                  }

                  if (!matched) continue
                  if (cutoffMs !== undefined && updatedMs >= cutoffMs) continue

                  const peer = yield* buildPeerInfo(sender, senderRoot, otherRoot, otherRoot, activeSet, false)
                  if (!matchesQuery(peer, input.query)) continue

                  const otherFamily = yield* collectFamilyTree(otherRoot)
                  const familyActive = otherFamily.some((m) => activeSet.has(m.id))
                  const meta = (otherRoot.metadata ?? {}) as Record<string, unknown>
                  const unsafeStopping =
                    meta.aquanoxWorkerStopUnconfirmed === true ||
                    meta.workerStopUnconfirmed === true ||
                    meta.stopping === true
                  const needsHumanOrRecovery =
                    Boolean(otherRoot.revert) ||
                    meta.aquanoxRecoveryRequired === true ||
                    meta.recoveryRequired === true ||
                    meta.aquanoxHasRevertIntent === true ||
                    meta.revertIntent === true ||
                    meta.waitingForHuman === true ||
                    peer.pendingInboxCount > 0

                  if (familyActive || unsafeStopping) {
                    if (explicitByID) {
                      return yield* new ToolFailure({
                        message: `Conversation ${cid ?? otherRoot.id} (${JSON.stringify(title)}) is currently active or stopping and cannot be deleted.`,
                      })
                    }
                    continue
                  }

                  if (needsHumanOrRecovery && !explicitByID) {
                    continue
                  }

                  if (!seenRoots.has(otherRoot.id)) {
                    seenRoots.add(otherRoot.id)
                    candidates.push({ root: otherRoot, peer, explicitByID })
                  }
                }

                if (candidates.length === 0) {
                  return yield* new ToolFailure({
                    message: "No matching idle conversations associated with your account were found to delete.",
                  })
                }

                const resources = candidates.map(({ peer }) => {
                  const idLabel = peer.conversationID ?? peer.rootSessionID
                  const iso = new Date(peer.updatedAt).toISOString()
                  return `delete:${idLabel} (${peer.title} — updated ${iso})`
                })

                const proposalSummary = `Approve permanent deletion of ${candidates.length} conversation${candidates.length === 1 ? "" : "s"} associated with your account?`

                yield* permissions
                  .assert({
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: {
                      type: "tool",
                      messageID: context.messageID,
                      id: context.id,
                    },
                    action: name,
                    resources,
                    metadata: {
                      kind: "conversation_delete_proposal",
                      requireApproval: true,
                      callerConversationID: senderConversationID ?? null,
                      callerRootSessionID: senderRoot.id,
                      ...(senderOwnerUserID ? { ownerUserId: senderOwnerUserID } : {}),
                      proposalSummary,
                      targets: candidates.map(({ peer, explicitByID }) => ({
                        conversationID: peer.conversationID ?? null,
                        sessionID: peer.rootSessionID,
                        title: peer.title,
                        directory: peer.directory,
                        updatedAt: peer.updatedAt,
                        explicit: explicitByID,
                      })),
                    },
                  })
                  .pipe(
                    Effect.mapError(
                      (error) =>
                        new ToolFailure({
                          message: `Conversation deletion was not approved: ${error.message}`,
                          error,
                        }),
                    ),
                  )

                const deletedReceipts: DeletedReceipt[] = []
                for (const { peer } of candidates) {
                  yield* sessions
                    .remove(peer.rootSessionID)
                    .pipe(
                      Effect.catchTag("Session.NotFoundError", () => Effect.void),
                      Effect.mapError(
                        (error) =>
                          new ToolFailure({
                            message: `Failed to remove session ${peer.rootSessionID}: ${(error as { message?: string })?.message ?? String(error)}`,
                            error,
                          }),
                      ),
                    )
                  SessionSlotLease.releaseConversation(
                    peer.conversationID ?? `conv_${peer.rootSessionID}`,
                    peer.rootSessionID,
                  )
                  deletedReceipts.push({
                    sessionID: peer.sessionID,
                    rootSessionID: peer.rootSessionID,
                    ...(peer.conversationID ? { conversationID: peer.conversationID } : {}),
                    ...(peer.agent ? { agent: peer.agent } : {}),
                    title: peer.title,
                    directory: peer.directory,
                    updatedAt: peer.updatedAt,
                  })
                }

                const lines = [
                  `Deleted ${deletedReceipts.length} conversation${deletedReceipts.length === 1 ? "" : "s"} after user approval:`,
                  ...deletedReceipts.map(
                    (d) =>
                      `- ${d.conversationID ?? d.rootSessionID} (session=${d.rootSessionID}, title=${JSON.stringify(d.title)}, updated=${new Date(d.updatedAt).toISOString()})`,
                  ),
                ]

                return {
                  content: lines.join("\n"),
                  output: {
                    action: "delete" as const,
                    sender: senderSummary,
                    deleted: deletedReceipts,
                  },
                }
              }

              if (action === "read") {
                if (!input.recipient || input.recipient.trim().length === 0) {
                  return yield* new ToolFailure({
                    message:
                      'action="read" requires a recipient (e.g. "parent", "siblings", "ses_...", or "task_...").',
                  })
                }
                const resolved = yield* resolveTargets(sender, senderRoot, input.recipient, scopeFilter)
                const first = resolved[0]!
                const peer = yield* buildPeerInfo(sender, senderRoot, first.target, first.targetRoot, activeSet, true)
                const rawMessages = yield* sessions
                  .messages({ sessionID: first.target.id, limit, order: "desc" })
                  .pipe(Effect.orElseSucceed(() => [] as SessionMessage.Info[]))
                const inboxItems = yield* sessions
                  .inbox(first.target.id)
                  .pipe(Effect.orElseSucceed(() => [] as SessionInbox.Info[]))
                const chronological = [
                  ...[...rawMessages].reverse().map(summarizeMessage),
                  ...inboxItems.map(summarizeInboxItem),
                ].slice(-limit)

                const lines: string[] = [
                  `Inspected Target: ${peer.sessionID} (${peer.scope}, relationship=${peer.relationship}, agent=${peer.agent ?? "primary"}, active=${peer.active}, inbox=${peer.pendingInboxCount}${peer.conversationID ? `, conversation=${peer.conversationID}` : ""})`,
                  `Title: ${peer.title}`,
                  `Directory: ${peer.directory}`,
                  "",
                  `Recent Messages (${chronological.length}):`,
                  ...(chronological.length === 0
                    ? ["- (no messages yet)"]
                    : chronological.map(
                        (m) => `- [${m.type}/${m.role}${m.agent ? `:${m.agent}` : ""}] (${m.id}): ${m.preview}`,
                      )),
                ]

                return {
                  content: lines.join("\n"),
                  output: {
                    action: "read" as const,
                    sender: senderSummary,
                    inspected: {
                      target: peer,
                      messages: chronological,
                    },
                  },
                }
              }

              // action === "send"
              if (!input.recipient || input.recipient.trim().length === 0) {
                return yield* new ToolFailure({
                  message:
                    'action="send" requires a recipient (e.g. "parent", "root", "siblings", "children", "ses_...", or "task_...").',
                })
              }
              if (!input.message || input.message.trim().length === 0) {
                return yield* new ToolFailure({
                  message: 'action="send" requires a non-empty message string.',
                })
              }

              const targets = yield* resolveTargets(sender, senderRoot, input.recipient, scopeFilter)
              const nonSelfTargets = targets.filter((item) => item.target.id !== sender.id)
              if (nonSelfTargets.length === 0) {
                return yield* new ToolFailure({
                  message: `Cannot send an agent message to yourself (${sender.id}). Specify another session or conversation.`,
                })
              }

              const delivery: typeof DeliverySchema.Type = input.delivery ?? "steer"
              const wake = input.wake ?? true
              const bodyText = input.message.trim()
              const summary = deriveSummary(bodyText, input.summary)
              const receipts: DeliveredReceipt[] = []
              const traceEnabled = AquanoxTrace.isEnabled()

              for (const { target, targetRoot } of nonSelfTargets) {
                const startUs = traceEnabled ? AquanoxTrace.nowUs() : 0
                const { scope, relationship } = classifyRelationship(sender, senderRoot, target, targetRoot)
                const targetConversationID = extractConversationID(target, targetRoot)
                const targetAgent = target.agent ? String(target.agent) : undefined

                const fromLabel = `${senderAgent} (${sender.id}${senderConversationID ? `, conv=${senderConversationID}` : ""})`
                const toLabel = `${targetAgent ?? "primary"} (${target.id}${targetConversationID ? `, conv=${targetConversationID}` : ""})`
                const description = `[Agent message: ${fromLabel} → ${toLabel}] ${summary}`

                const envelope = [
                  `<agent-message`,
                  `  fromSessionID=${JSON.stringify(sender.id)}`,
                  `  fromRootSessionID=${JSON.stringify(senderRoot.id)}`,
                  ...(senderConversationID ? [`  fromConversationID=${JSON.stringify(senderConversationID)}`] : []),
                  `  fromAgent=${JSON.stringify(senderAgent)}`,
                  `  fromTitle=${JSON.stringify(sender.title ?? sender.id)}`,
                  `  toSessionID=${JSON.stringify(target.id)}`,
                  `  toRootSessionID=${JSON.stringify(targetRoot.id)}`,
                  ...(targetConversationID ? [`  toConversationID=${JSON.stringify(targetConversationID)}`] : []),
                  `  scope=${JSON.stringify(scope)}`,
                  `  relationship=${JSON.stringify(relationship)}`,
                  `  delivery=${JSON.stringify(delivery)}`,
                  `  summary=${JSON.stringify(summary)}`,
                  `>`,
                  bodyText,
                  "",
                  `[Reply routing: To send a direct response or handoff back to this sender, call send_message with recipient: ${JSON.stringify(sender.id)}${scope === "cross_conversation" && senderConversationID ? ` (or conversationID ${JSON.stringify(senderConversationID)})` : ""}. Do NOT send a bare acknowledgement if no reply is needed.]`,
                  `</agent-message>`,
                ].join("\n")

                const syntheticMsg = yield* sessions
                  .synthetic({
                    sessionID: target.id,
                    text: envelope,
                    description,
                    delivery,
                    resume: wake,
                    metadata: {
                      source: "agent-message",
                      scope,
                      relationship,
                      fromSessionID: sender.id,
                      fromRootSessionID: senderRoot.id,
                      ...(senderConversationID ? { fromConversationID: senderConversationID } : {}),
                      fromAgent: senderAgent,
                      fromTitle: sender.title ?? sender.id,
                      toSessionID: target.id,
                      toRootSessionID: targetRoot.id,
                      ...(targetConversationID ? { toConversationID: targetConversationID } : {}),
                      ...(targetAgent ? { toAgent: targetAgent } : {}),
                      toTitle: target.title ?? target.id,
                      summary,
                      delivery,
                      woke: wake,
                    },
                  })
                  .pipe(
                    Effect.mapError(
                      (error) =>
                        new ToolFailure({
                          message: `Failed to deliver message to ${target.id}: ${error.message}`,
                          error,
                        }),
                    ),
                  )

                if (traceEnabled && senderConversationID) {
                  const endUs = AquanoxTrace.nowUs()
                  yield* AquanoxTrace.postTraceIngest({
                    span: {
                      spanId: `spn_msg_${syntheticMsg.id}`,
                      conversationId: senderConversationID,
                      rootSessionId: senderRoot.id,
                      sessionId: sender.id,
                      parentSessionId: sender.parentID ?? null,
                      layer: "opencode",
                      kind: "agent.message",
                      name: `send_message: ${relationship} -> ${target.id}`,
                      status: "ok",
                      startUs,
                      endUs,
                      durationMs: AquanoxTrace.durationMs(startUs, endUs),
                      agentName: senderAgent,
                      isSubagent: Boolean(sender.parentID),
                      attributes: {
                        messageId: context.messageID,
                        toolCallId: context.id,
                        scope,
                        relationship,
                        delivery,
                        wake,
                        fromSessionID: sender.id,
                        toSessionID: target.id,
                        toConversationID: targetConversationID ?? null,
                        summary,
                      },
                    },
                  })
                }

                receipts.push({
                  messageID: syntheticMsg.id,
                  recipientSessionID: target.id,
                  recipientRootSessionID: targetRoot.id,
                  ...(targetConversationID ? { recipientConversationID: targetConversationID } : {}),
                  ...(targetAgent ? { recipientAgent: targetAgent } : {}),
                  recipientTitle: target.title ?? target.id,
                  scope,
                  relationship,
                  delivery,
                  woke: wake,
                })
              }

              const lines = [
                `Delivered ${receipts.length} agent message${receipts.length === 1 ? "" : "s"} (delivery=${delivery}, wake=${wake}):`,
                ...receipts.map(
                  (r) =>
                    `- ${r.messageID} → ${r.recipientSessionID} [${r.scope}/${r.relationship}] (agent=${r.recipientAgent ?? "primary"}${r.recipientConversationID ? `, conversation=${r.recipientConversationID}` : ""}, title=${JSON.stringify(r.recipientTitle)})`,
                ),
              ]

              return {
                content: lines.join("\n"),
                output: {
                  action: "send" as const,
                  sender: senderSummary,
                  delivered: receipts,
                },
              }
            }),
        }),
      )
      .pipe(Effect.orDie)

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.sync(() => {
        if (event.tool !== name || !Predicate.isObject(event.input)) return
        const raw = event.input as Record<string, unknown>
        const pickString = (...keys: string[]): string | undefined => {
          for (const key of keys) {
            const val = raw[key]
            if (typeof val === "string" && val.trim().length > 0) return val.trim()
          }
          return undefined
        }
        const normalizedRecipient = pickString(
          "recipient",
          "to",
          "target",
          "sessionID",
          "session_id",
          "conversationID",
          "conversation_id",
        )
        if (normalizedRecipient !== undefined) {
          raw.recipient = normalizedRecipient
        } else {
          delete raw.recipient
        }
        const normalizedMessage = pickString("message", "text", "content", "body")
        if (normalizedMessage !== undefined) {
          raw.message = normalizedMessage
        } else {
          delete raw.message
        }
        const normalizedSummary = pickString("summary", "subject", "title")
        if (normalizedSummary !== undefined) {
          raw.summary = normalizedSummary
        } else {
          delete raw.summary
        }
        if (raw.delivery === undefined && (raw.mode === "steer" || raw.mode === "queue")) {
          raw.delivery = raw.mode
        }
        if (raw.olderThanHours === undefined && typeof raw.older_than_hours === "number") {
          raw.olderThanHours = raw.older_than_hours
        }
        if (raw.recipients === undefined) {
          for (const key of ["targets", "conversationIDs", "conversation_ids", "sessionIDs", "session_ids"]) {
            if (Array.isArray(raw[key])) {
              raw.recipients = raw[key]
              break
            }
          }
        }
        if (typeof raw.query === "string") {
          const trimmed = raw.query.trim()
          if (trimmed.length > 0) raw.query = trimmed
          else delete raw.query
        }
        delete raw.to
        delete raw.target
        delete raw.targets
        delete raw.sessionID
        delete raw.session_id
        delete raw.sessionIDs
        delete raw.session_ids
        delete raw.conversationID
        delete raw.conversation_id
        delete raw.conversationIDs
        delete raw.conversation_ids
        delete raw.older_than_hours
        delete raw.text
        delete raw.content
        delete raw.body
        delete raw.subject
        delete raw.mode
      }),
    )
  }),
}
