import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
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
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { SessionStore } from "@opencode/core/session/store"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Permission } from "@opencode/core/permission"
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
    }),
  ),
  deps: [
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
