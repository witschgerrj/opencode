import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Agent } from "@opencode/core/agent"
import { Job } from "@opencode/core/job"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { SessionSlotLease } from "@opencode/core/session/slot-lease"
import { SessionStore } from "@opencode/core/session/store"
import { Shell } from "@opencode/core/shell"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Permission } from "@opencode/core/permission"
import { AquanoxTrace } from "@opencode/core/session/aquanox-trace"
import { ScheduleTool } from "@opencode/core/tool/plugin/schedule"
import { SendMessageTool } from "@opencode/core/tool/plugin/send-message"
import { Tool } from "@opencode/core/tool"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const wokenSessions: Session.ID[] = []
const activeSessions = new Set<Session.ID>()

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      return SessionExecution.Service.of({
        active: Effect.sync(() => new Set(activeSessions)),
        isActive: (sessionID) => Effect.sync(() => activeSessions.has(sessionID)),
        resume: () => Effect.void,
        wake: (sessionID) =>
          Effect.sync(() => {
            wokenSessions.push(sessionID)
          }),
        interrupt: () => Effect.succeed(false),
        awaitIdle: () => Effect.void,
      })
    }),
  ),
  deps: [Bus.node, SessionStore.node, Database.node],
})

const sendMessagePluginSupervisor = makeLocationNode({
  name: "test/send-message-plugins",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      yield* registerToolPlugin(SendMessageTool.Plugin, {}, (name, callback) => hooks.register("tool", name, callback))
      yield* registerToolPlugin(ScheduleTool.Plugin, {}, (name, callback) => hooks.register("tool", name, callback))
    }),
  ),
  deps: [
    Global.node,
    Agent.node,
    Config.node,
    Model.node,
    Permission.node,
    Session.node,
    Job.node,
    Tool.node,
    PluginHooks.node,
  ],
})

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  Job.node,
  Session.node,
  SessionExecution.node,
  LocationServiceMap.node,
])

const it = testEffect(
  AppNodeBuilder.build(nodes, [
    SessionExecution.node.replace(executionNode),
    Global.node.replace(tempGlobalLayer),
    offlineModels,
    PluginSupervisor.node.replace(sendMessagePluginSupervisor),
  ]),
)

const setupLocation = (location: Location.Ref) =>
  Effect.gen(function* () {
    wokenSessions.length = 0
    activeSessions.clear()
    const locations = yield* LocationServiceMap.Service
    yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(Effect.provide(locations.get(location)))
    yield* Agent.Service.use((agents) =>
      agents.transform((editor) => {
        editor.update(toolIdentity.agent, (agent) => {
          agent.mode = "primary"
          agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
        })
        editor.update(Agent.ID.make("general"), (agent) => {
          agent.mode = "subagent"
          agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
        })
        editor.update(Agent.ID.make("explore"), (agent) => {
          agent.mode = "subagent"
          agent.permissions.push(
            { action: "*", resource: "*", effect: "deny" },
            { action: "send_message", resource: "*", effect: "allow" },
            { action: "send_message", resource: "delete:*", effect: "deny" },
          )
        })
      }),
    ).pipe(Effect.provide(locations.get(location)))
  })

const callSendMessage = (
  location: Location.Ref,
  sessionID: Session.ID,
  input: Record<string, unknown>,
  agent: Agent.ID = toolIdentity.agent,
) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    return yield* Tool.Service.use((registry) =>
      executeTool(registry, {
        sessionID,
        agent,
        messageID: toolIdentity.messageID,
        call: {
          type: "tool-call",
          id: "call-send-msg-" + Math.random().toString(36).slice(2),
          name: "send_message",
          input,
        },
      }),
    ).pipe(Effect.provide(locations.get(location)))
  })

const callSchedule = (location: Location.Ref, sessionID: Session.ID, input: Record<string, unknown>) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    return yield* Tool.Service.use((registry) =>
      executeTool(registry, {
        sessionID,
        agent: toolIdentity.agent,
        messageID: toolIdentity.messageID,
        call: {
          type: "tool-call",
          id: "call-sched-" + Math.random().toString(36).slice(2),
          name: "schedule",
          input,
        },
      }),
    ).pipe(Effect.provide(locations.get(location)))
  })

describe("SendMessageTool — intra-conversation and cross-conversation agent messaging", () => {
  it.live("supports intra-conversation messaging: sibling <-> sibling, child -> parent/root, and parent -> children", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => tmpdir())
      const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
      yield* setupLocation(location)

      const sessions = yield* Session.Service
      const rootA = yield* sessions.create({
        location,
        title: "Conv A Root Orchestrator",
        metadata: { aquanoxConversationId: "task_conv_a" },
      })
      const child1 = yield* sessions.create({
        parentID: rootA.id,
        title: "Backend API Subagent",
        agent: Agent.ID.make("general"),
        metadata: { aquanoxConversationId: "task_conv_a", aquanoxRootSessionId: rootA.id },
      })
      const child2 = yield* sessions.create({
        parentID: rootA.id,
        title: "Frontend UI Subagent",
        agent: Agent.ID.make("explore"),
        metadata: { aquanoxConversationId: "task_conv_a", aquanoxRootSessionId: rootA.id },
      })

      activeSessions.add(child1.id)
      activeSessions.add(child2.id)

      // 1. Child 1 lists sessions in same conversation
      const listRes = yield* callSendMessage(
        location,
        child1.id,
        {
          action: "list",
          scope: "same_conversation",
        },
        Agent.ID.make("general"),
      )
      const listOut = listRes.output as SendMessageTool.Output
      expect(listOut.action).toBe("list")
      expect(listOut.sameConversation?.map((p) => p.relationship)).toEqual(["parent", "sibling", "self"])

      // 2. Child 1 sends contract directly to its sibling (Child 2) using recipient="siblings"
      const sibRes = yield* callSendMessage(
        location,
        child1.id,
        {
          recipient: "siblings",
          summary: "REST route contract for /api/items",
          message: "GET /api/items returns { items: Array<{ id: string; name: string }> }",
          delivery: "steer",
        },
        Agent.ID.make("general"),
      )
      const sibOut = sibRes.output as SendMessageTool.Output
      expect(sibOut.action).toBe("send")
      expect(sibOut.delivered).toHaveLength(1)
      expect(sibOut.delivered?.[0]).toMatchObject({
        recipientSessionID: child2.id,
        recipientRootSessionID: rootA.id,
        recipientConversationID: "task_conv_a",
        scope: "same_conversation",
        relationship: "sibling",
        delivery: "steer",
        woke: true,
      })

      // Verify synthetic message was admitted into Child 2's inbox with steer delivery
      const child2Inbox = yield* sessions.inbox(child2.id)
      expect(child2Inbox).toHaveLength(1)
      expect(child2Inbox[0]?.type).toBe("synthetic")
      expect(child2Inbox[0]?.delivery).toBe("steer")
      if (child2Inbox[0]?.type === "synthetic") {
        expect(child2Inbox[0].payload.text).toContain("<agent-message")
        expect(child2Inbox[0].payload.text).toContain('relationship="sibling"')
        expect(child2Inbox[0].payload.text).toContain("GET /api/items returns")
      }

      // 3. Child 2 (explore agent) sends early finding to parent/root using alias to="parent" and text=...
      const parentRes = yield* callSendMessage(
        location,
        child2.id,
        {
          to: "parent",
          subject: "Found legacy endpoint collision",
          text: "src/routes/items.ts already defines /api/items at L42.",
          delivery: "queue",
        },
        Agent.ID.make("explore"),
      )
      const parentOut = parentRes.output as SendMessageTool.Output
      expect(parentOut.delivered?.[0]).toMatchObject({
        recipientSessionID: rootA.id,
        scope: "same_conversation",
        relationship: "parent",
        delivery: "queue",
      })

      // 4. Root broadcasts steering update to all children (recipient="children")
      const childrenRes = yield* callSendMessage(location, rootA.id, {
        recipient: "children",
        message: "Use /api/v2/items to avoid the legacy collision.",
        delivery: "steer",
      })
      const childrenOut = childrenRes.output as SendMessageTool.Output
      expect(childrenOut.delivered?.map((d) => d.recipientSessionID).sort()).toEqual([child1.id, child2.id].sort())
    }),
  )

  it.live("supports cross-conversation discovery, non-waking read inspection, and cross-conversation messaging", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => tmpdir())
      const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
      yield* setupLocation(location)

      const sessions = yield* Session.Service
      const convARoot = yield* sessions.create({
        location,
        title: "Physics Engine Refactor",
        metadata: { aquanoxConversationId: "task_physics_1" },
      })
      const convAChild = yield* sessions.create({
        parentID: convARoot.id,
        title: "Collision Broadphase Worker",
        agent: Agent.ID.make("general"),
        metadata: { aquanoxConversationId: "task_physics_1", aquanoxRootSessionId: convARoot.id },
      })
      const convBRoot = yield* sessions.create({
        location,
        title: "WebGPU Renderer Pipeline",
        metadata: { aquanoxConversationId: "task_renderer_2" },
      })

      // Seed a message in Conv B so Conv A can inspect it via action="read"
      yield* sessions.synthetic({
        sessionID: convBRoot.id,
        text: "Renderer uniform buffer layout finalized at 64 bytes per instance.",
        description: "Uniform buffer note",
        resume: false,
      })

      // 1. Subagent in Conv A discovers Conv B via cross_conversation list
      const listCross = yield* callSendMessage(
        location,
        convAChild.id,
        {
          action: "list",
          scope: "cross_conversation",
          query: "renderer",
        },
        Agent.ID.make("general"),
      )
      const listCrossOut = listCross.output as SendMessageTool.Output
      expect(listCrossOut.crossConversations).toHaveLength(1)
      expect(listCrossOut.crossConversations?.[0]).toMatchObject({
        sessionID: convBRoot.id,
        conversationID: "task_renderer_2",
        title: "WebGPU Renderer Pipeline",
        scope: "cross_conversation",
        relationship: "cross_conversation",
      })

      // 2. Subagent in Conv A inspects Conv B by Aquanox conversation ID ("task_renderer_2") without waking it
      wokenSessions.length = 0
      const readCross = yield* callSendMessage(
        location,
        convAChild.id,
        {
          action: "read",
          recipient: "task_renderer_2",
        },
        Agent.ID.make("general"),
      )
      const readCrossOut = readCross.output as SendMessageTool.Output
      expect(readCrossOut.action).toBe("read")
      expect(readCrossOut.inspected?.target.sessionID).toBe(convBRoot.id)
      expect(wokenSessions).toHaveLength(0)

      // 3. Subagent in Conv A sends a cross-conversation message to Conv B by conversationID "task_renderer_2"
      const sendCross = yield* callSendMessage(
        location,
        convAChild.id,
        {
          recipient: "task_renderer_2",
          summary: "RigidBody transform matrix offset",
          message: "Physics world transforms are now packed in mat4x4f at offset 0 of the storage buffer.",
          delivery: "queue",
          wake: true,
        },
        Agent.ID.make("general"),
      )
      const sendCrossOut = sendCross.output as SendMessageTool.Output
      expect(sendCrossOut.delivered).toHaveLength(1)
      expect(sendCrossOut.delivered?.[0]).toMatchObject({
        recipientSessionID: convBRoot.id,
        recipientConversationID: "task_renderer_2",
        scope: "cross_conversation",
        relationship: "cross_conversation",
        delivery: "queue",
        woke: true,
      })
      expect(wokenSessions).toContain(convBRoot.id)

      const convBInbox = yield* sessions.inbox(convBRoot.id)
      const deliveredItem = convBInbox.find(
        (item) => item.type === "synthetic" && item.payload.metadata?.source === "agent-message",
      )
      expect(deliveredItem).toBeDefined()
      if (deliveredItem?.type === "synthetic") {
        expect(deliveredItem.payload.text).toContain('fromConversationID="task_physics_1"')
        expect(deliveredItem.payload.text).toContain('toConversationID="task_renderer_2"')
        expect(deliveredItem.payload.text).toContain('scope="cross_conversation"')
      }
    }),
  )

  it.live("supports wake=false passive delivery, cross-conversation subagent targeting, and clear error diagnostics", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => tmpdir())
      const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
      yield* setupLocation(location)

      const sessions = yield* Session.Service
      const convARoot = yield* sessions.create({
        location,
        title: "Conv A Root",
        metadata: { aquanoxConversationId: "task_a" },
      })
      const convBRoot = yield* sessions.create({
        location,
        title: "Conv B Root",
        metadata: { aquanoxConversationId: "task_b" },
      })
      const convBChild = yield* sessions.create({
        parentID: convBRoot.id,
        title: "Conv B Shader Subagent",
        agent: Agent.ID.make("general"),
        metadata: { aquanoxConversationId: "task_b", aquanoxRootSessionId: convBRoot.id },
      })

      // 1. Listing cross-conversation with includeSubagents=true discovers convBChild
      const listWithSubs = yield* callSendMessage(location, convARoot.id, {
        action: "list",
        scope: "cross_conversation",
        includeSubagents: true,
      })
      const listOut = listWithSubs.output as SendMessageTool.Output
      expect(listOut.crossConversations?.map((p) => p.sessionID)).toContain(convBRoot.id)
      expect(listOut.crossConversations?.map((p) => p.sessionID)).toContain(convBChild.id)

      // 2. Sending with wake=false deposits into inbox without waking target
      wokenSessions.length = 0
      const passiveRes = yield* callSendMessage(location, convARoot.id, {
        recipient: convBChild.id,
        message: "Passive note: shader bindings updated in common.wgsl",
        wake: false,
      })
      const passiveOut = passiveRes.output as SendMessageTool.Output
      expect(passiveOut.delivered?.[0]?.woke).toBe(false)
      expect(wokenSessions).toHaveLength(0)

      // 3. Root calling recipient="parent" returns descriptive error
      const parentErr = yield* callSendMessage(location, convARoot.id, {
        recipient: "parent",
        message: "Hello parent",
      })
      expect(parentErr.status).toBe("error")
      expect(parentErr.error?.message).toContain("already the root session")

      // 4. Self-messaging returns descriptive error
      const selfErr = yield* callSendMessage(location, convARoot.id, {
        recipient: convARoot.id,
        message: "Hello self",
      })
      expect(selfErr.status).toBe("error")
      expect(selfErr.error?.message).toContain("Cannot send an agent message to yourself")
    }),
  )

  it.live("enforces Propose -> Approve flow, owner isolation, and safety exclusions for action='delete'", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => tmpdir())
      const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
      yield* setupLocation(location)

      const locations = yield* LocationServiceMap.Service
      const sessions = yield* Session.Service

      const callerRoot = yield* sessions.create({
        location,
        title: "Active Caller Conversation",
        metadata: { aquanoxConversationId: "task_caller", aquanoxOwnerUserId: "user_alice" },
      })
      const deletableA = yield* sessions.create({
        location,
        title: "Old Idle Conversation A",
        metadata: { aquanoxConversationId: "task_del_a", aquanoxOwnerUserId: "user_alice" },
      })
      const deletableB = yield* sessions.create({
        location,
        title: "Old Idle Conversation B",
        metadata: { aquanoxConversationId: "task_del_b", aquanoxOwnerUserId: "user_alice" },
      })
      const otherOwnerConv = yield* sessions.create({
        location,
        title: "Bob Private Conversation",
        metadata: { aquanoxConversationId: "task_bob", aquanoxOwnerUserId: "user_bob" },
      })
      const unconfirmedStopConv = yield* sessions.create({
        location,
        title: "Unconfirmed Stop Conversation",
        metadata: {
          aquanoxConversationId: "task_unconfirmed",
          aquanoxOwnerUserId: "user_alice",
          aquanoxWorkerStopUnconfirmed: true,
        },
      })
      const recoveryConv = yield* sessions.create({
        location,
        title: "Recovery Required Conversation",
        metadata: {
          aquanoxConversationId: "task_recovery",
          aquanoxOwnerUserId: "user_alice",
          aquanoxRecoveryRequired: true,
        },
      })
      const revertIntentConv = yield* sessions.create({
        location,
        title: "Staged Revert Conversation",
        metadata: {
          aquanoxConversationId: "task_revert",
          aquanoxOwnerUserId: "user_alice",
        },
      })
      const bus = yield* Bus.Service
      yield* bus.publish(SessionEvent.RevertEvent.Staged, {
        sessionID: revertIntentConv.id,
        revert: {
          messageID: SessionMessage.ID.create(),
          files: [],
        },
      })
      const pendingInboxConv = yield* sessions.create({
        location,
        title: "Pending Inbox Conversation",
        metadata: {
          aquanoxConversationId: "task_inbox",
          aquanoxOwnerUserId: "user_alice",
        },
      })
      yield* sessions.synthetic({
        sessionID: pendingInboxConv.id,
        text: "Queued follow-up message",
        delivery: "queue",
        resume: false,
      })

      // 0. AquanoxTrace.mergeHeaderMetadata extracts x-aquanox-owner-user-id -> aquanoxOwnerUserId
      const mergedMeta = AquanoxTrace.mergeHeaderMetadata(
        {
          "x-aquanox-conversation-id": "task_hdr_1",
          "x-aquanox-owner-user-id": "user_alice",
        },
        undefined,
      )
      expect(mergedMeta).toEqual({
        aquanoxConversationId: "task_hdr_1",
        aquanoxOwnerUserId: "user_alice",
      })

      // 0b. Cross-owner isolation blocks Alice from reading or sending to Bob's session/conversation
      const crossReadBySes = yield* callSendMessage(location, callerRoot.id, {
        action: "read",
        recipient: otherOwnerConv.id,
      })
      expect(crossReadBySes.status).toBe("error")
      expect(crossReadBySes.error?.message).toContain("belongs to another account")

      const crossSendByTask = yield* callSendMessage(location, callerRoot.id, {
        action: "send",
        recipient: "task_bob",
        message: "Attempt cross-owner send",
      })
      expect(crossSendByTask.status).toBe("error")
      expect(crossSendByTask.error?.message).toContain("Could not resolve recipient")

      // 1. Read-only explore agent is denied delete:* before any proposal is staged
      const exploreBlocked = yield* callSendMessage(
        location,
        callerRoot.id,
        { action: "delete", recipient: "task_del_a" },
        Agent.ID.make("explore"),
      )
      expect(exploreBlocked.status).toBe("error")
      expect(exploreBlocked.error?.message).toContain("Permission denied")

      // 2. Self-deletion, invalid 'before' timestamp, and explicit targeting of stopping conversation are rejected immediately
      const selfDelete = yield* callSendMessage(location, callerRoot.id, {
        action: "delete",
        recipient: "task_caller",
      })
      expect(selfDelete.status).toBe("error")
      expect(selfDelete.error?.message).toContain("Cannot delete the currently running conversation")

      const badBefore = yield* callSendMessage(location, callerRoot.id, {
        action: "delete",
        before: "not-a-timestamp",
      })
      expect(badBefore.status).toBe("error")
      expect(badBefore.error?.message).toContain("Invalid ISO timestamp for 'before'")

      const explicitStopping = yield* callSendMessage(location, callerRoot.id, {
        action: "delete",
        recipient: "task_unconfirmed",
      })
      expect(explicitStopping.status).toBe("error")
      expect(explicitStopping.error?.message).toContain("currently active or stopping and cannot be deleted")

      // Schedule a timer on deletableB to verify session.deleted automatically cancels it
      const createTimerRes = yield* callSchedule(location, deletableB.id, {
        action: "create_timer",
        delaySeconds: 300,
        prompt: "Delayed follow-up on deletableB",
      })
      expect(createTimerRes.status).toBe("completed")
      const timerBeforeDelete = (createTimerRes.output as { schedule?: { id: string } }).schedule?.id
      expect(timerBeforeDelete).toBeDefined()

      // 2b. Rejecting a delete proposal leaves the conversation intact
      const rejectFiber = yield* Effect.forkChild(
        callSendMessage(location, callerRoot.id, {
          action: "delete",
          recipient: "task_del_a",
        }),
      )
      let rejectReq: Permission.Request | undefined
      for (let i = 0; i < 100 && !rejectReq; i++) {
        const list = yield* Permission.Service.use((p) => p.forSession(callerRoot.id)).pipe(
          Effect.provide(locations.get(location)),
        )
        rejectReq = list[0]
        if (!rejectReq) yield* Effect.promise(() => Bun.sleep(5))
      }
      expect(rejectReq).toBeDefined()
      yield* Permission.Service.use((p) =>
        p.reply({
          requestID: rejectReq!.id,
          reply: "reject",
          message: "Keep Old Idle Conversation A",
        }),
      ).pipe(Effect.provide(locations.get(location)))
      const rejectedResult = yield* Fiber.join(rejectFiber)
      expect(rejectedResult.status).toBe("error")
      expect(rejectedResult.error?.message).toContain("Keep Old Idle Conversation A")
      expect((yield* sessions.get(deletableA.id).pipe(Effect.option))._tag).toBe("Some")

      // Bind a slot lease and background shell to deletableA to verify Session.remove purges both
      SessionSlotLease.admitConversation({
        conversationId: "task_del_a",
        agentId: "general",
        reservedSubagentQuanta: 0,
      })
      SessionSlotLease.bindConversationSession({ conversationId: "task_del_a", sessionID: deletableA.id })
      expect(SessionSlotLease.getConversationIdForSession(deletableA.id)).toBe("task_del_a")

      const shellDelA = yield* Shell.Service.use((sh) =>
        sh.create({
          command: "sleep 30",
          metadata: { sessionID: deletableA.id },
        }),
      ).pipe(Effect.provide(locations.get(location)))
      const shellCaller = yield* Shell.Service.use((sh) =>
        sh.create({
          command: "sleep 30",
          metadata: { sessionID: callerRoot.id },
        }),
      ).pipe(Effect.provide(locations.get(location)))

      // 2c. Filter matching 0 conversations returns clear diagnostic without staging a permission request
      const emptyFilterRes = yield* callSendMessage(location, callerRoot.id, {
        action: "delete",
        olderThanHours: 999999,
      })
      expect(emptyFilterRes.status).toBe("error")
      expect(emptyFilterRes.error?.message).toContain(
        "No matching idle conversations associated with your account were found to delete",
      )

      // 3. Batch filter (olderThanHours: 0) stages an approval request with save=undefined ("Always allow" disabled),
      //    includes only Alice's safe idle conversations (task_del_a, task_del_b), and excludes Bob's, active, and recovery/stopping ones
      const deleteFiber = yield* Effect.forkChild(
        callSendMessage(location, callerRoot.id, {
          action: "delete",
          olderThanHours: 0,
        }),
      )

      // Poll until the permission request appears on callerRoot
      let pendingReq: Permission.Request | undefined
      for (let i = 0; i < 100 && !pendingReq; i++) {
        const list = yield* Permission.Service.use((p) => p.forSession(callerRoot.id)).pipe(
          Effect.provide(locations.get(location)),
        )
        pendingReq = list[0]
        if (!pendingReq) yield* Effect.promise(() => Bun.sleep(5))
      }

      expect(pendingReq).toBeDefined()
      expect(pendingReq?.action).toBe("send_message")
      expect(pendingReq?.save).toBeUndefined()
      expect(pendingReq?.metadata?.kind).toBe("conversation_delete_proposal")
      expect(pendingReq?.resources).toHaveLength(2)
      expect(pendingReq?.resources.some((r) => r.startsWith("delete:task_del_a"))).toBe(true)
      expect(pendingReq?.resources.some((r) => r.startsWith("delete:task_del_b"))).toBe(true)
      expect(pendingReq?.resources.some((r) => r.includes("task_bob"))).toBe(false)
      expect(pendingReq?.resources.some((r) => r.includes("task_unconfirmed"))).toBe(false)
      expect(pendingReq?.resources.some((r) => r.includes("task_recovery"))).toBe(false)
      expect(pendingReq?.resources.some((r) => r.includes("task_revert"))).toBe(false)
      expect(pendingReq?.resources.some((r) => r.includes("task_inbox"))).toBe(false)

      // Simulate Aquanox Harness respondToInteraction deleting deletableA via DELETE /api/session/:id
      // right before forwarding the "once" permission reply to OpenCode
      yield* sessions.remove(deletableA.id)
      expect(SessionSlotLease.getConversationIdForSession(deletableA.id)).toBeUndefined()
      const runningShellsAfterRemove = yield* Shell.Service.use((sh) => sh.list()).pipe(
        Effect.provide(locations.get(location)),
      )
      expect(runningShellsAfterRemove.some((s) => s.id === shellDelA.id)).toBe(false)
      expect(runningShellsAfterRemove.some((s) => s.id === shellCaller.id)).toBe(true)
      yield* Shell.Service.use((sh) => sh.remove(shellCaller.id)).pipe(
        Effect.provide(locations.get(location)),
        Effect.ignore,
      )

      // Approve once ("once")
      yield* Permission.Service.use((p) =>
        p.reply({
          requestID: pendingReq!.id,
          reply: "once",
        }),
      ).pipe(Effect.provide(locations.get(location)))

      const deleteResult = yield* Fiber.join(deleteFiber)
      expect(deleteResult.status).toBe("completed")
      const deleteOut = deleteResult.output as SendMessageTool.Output
      expect(deleteOut.action).toBe("delete")
      expect(deleteOut.deleted?.map((d) => d.conversationID)).toEqual(
        expect.arrayContaining(["task_del_a", "task_del_b"]),
      )

      // Deleted sessions are gone, while excluded sessions remain intact
      const delACheck = yield* sessions.get(deletableA.id).pipe(Effect.option)
      const delBCheck = yield* sessions.get(deletableB.id).pipe(Effect.option)
      const bobCheck = yield* sessions.get(otherOwnerConv.id).pipe(Effect.option)
      const unconfirmedCheck = yield* sessions.get(unconfirmedStopConv.id).pipe(Effect.option)
      const recoveryCheck = yield* sessions.get(recoveryConv.id).pipe(Effect.option)
      expect(delACheck._tag).toBe("None")
      expect(delBCheck._tag).toBe("None")
      expect(bobCheck._tag).toBe("Some")
      expect(unconfirmedCheck._tag).toBe("Some")
      expect(recoveryCheck._tag).toBe("Some")

      // Scheduled timer targeting deletableB was automatically cancelled on session.deleted
      const listTimersAfter = yield* callSchedule(location, callerRoot.id, {
        action: "list",
      })
      expect(listTimersAfter.status).toBe("completed")
      const remainingSchedules = (listTimersAfter.output as { schedules: Array<{ id: string; status: string }> }).schedules
      expect(remainingSchedules.find((s) => s.id === timerBeforeDelete)?.status).toBe("cancelled")
    }),
  )

  test("treats synthetic agent-message turns as turn entries in analyzeCausalStep and resets isRequestSynthesisTurn", () => {
    const created = DateTime.makeUnsafe(1_700_000_000_000)
    const synthMsg: SessionMessage.Info = {
      id: SessionMessage.ID.create(),
      type: "synthetic",
      text: "<agent-message>Contract update</agent-message>",
      description: "[Agent message] Contract update",
      time: { created },
    }
    const analysis = SessionRunnerLLM.analyzeCausalStep([synthMsg])
    expect(analysis.isTurnEntry).toBe(true)
    expect(SessionRunnerLLM.isRequestSynthesisTurn([synthMsg])).toBe(false)
  })
})
