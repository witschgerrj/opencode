import { describe, expect } from "bun:test"
import { LanguageModel, LLMClient } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { Instructions } from "@opencode/core/instructions/index"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { Location } from "@opencode/core/location"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { Project } from "@opencode/core/project"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionContext } from "@opencode/core/session/context"
import { InstructionState } from "@opencode/core/session/instruction-state"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Tool } from "@opencode/core/tool"
import { Effect, Layer, Schema, Stream } from "effect"
import { testEffect } from "./lib/effect"

const sessionID = SessionSchema.ID.make("ses_context_test")

const builtins = Layer.mock(InstructionBuiltIns.Service, {
  load: () =>
    Effect.succeed(
      Instructions.combine([
        Instructions.make({
          key: Instructions.Key.make("test/static"),
          codec: Schema.toCodecJson(Schema.String),
          read: Effect.succeed("static info"),
          render: {
            initial: (v) => `Static: ${v}`,
            changed: (_p, v) => `Static changed: ${v}`,
          },
        }),
        Instructions.make({
          key: Instructions.Key.make("core/date"),
          codec: Schema.toCodecJson(Schema.String),
          read: Effect.succeed("Fri Oct 30 2026"),
          render: {
            initial: (date) => `Today's date: ${date}`,
            changed: (_p, date) => `Today's date is now: ${date}`,
          },
        }),
        Instructions.make({
          key: Instructions.Key.make("core/environment"),
          codec: Schema.toCodecJson(Schema.String),
          read: Effect.succeed("<env>dir: /project</env>"),
          render: {
            initial: (env) => `Environment: ${env}`,
            changed: (_p, env) => `Environment changed: ${env}`,
          },
        }),
      ]),
    ),
})

const discovery = Layer.mock(InstructionDiscovery.Service, {
  project: true,
  global: true,
  load: () => Effect.succeed(Instructions.empty),
})
const skills = Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const references = Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const mcp = Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })

const testModel = LanguageModel.make({ id: "context-model", provider: "test", route: OpenAIChat.route })

const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: () =>
    Effect.succeed(
      SessionRunnerModel.resolved(testModel, {
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 32_000 },
      }),
    ),
})

const tools = Layer.mock(Tool.Service, {
  snapshot: () =>
    Effect.succeed({
      tools: new Map(),
      codeModeCatalog: {
        imports: [],
        tools: [],
      },
      definitions: [],
      execute: () => Effect.die(new Error("unused")),
    }),
  transform: () => Effect.die(new Error("unused")),
})

const dummyClient = Layer.mock(LLMClient.Service, {
  stream: () => Stream.empty,
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Project.node,
      SessionProjector.node,
      SessionStore.node,
      Agent.node,
      InstructionBuiltIns.node,
      SessionContext.node,
      PluginHooks.node,
      llmClient,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      llmClient.replace(dummyClient),
      SessionRunnerModel.node.replace(models),
      InstructionBuiltIns.node.replace(builtins),
      InstructionDiscovery.node.replace(discovery),
      SkillInstructions.node.replace(skills),
      ReferenceInstructions.node.replace(references),
      McpInstructions.node.replace(mcp),
      PluginSupervisor.node.replace(Layer.empty),
      Tool.node.replace(tools),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    ],
  ),
)

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const bus = yield* Bus.Service
  const agents = yield* Agent.Service
  const projects = yield* Project.Service
  const instructionBuiltIns = yield* InstructionBuiltIns.Service
  const context = yield* SessionContext.Service
  const store = yield* SessionStore.Service

  yield* agents.transform((editor) =>
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    }),
  )
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: (yield* projects.resolve(AbsolutePath.make("/project"))).id,
      slug: "context-test",
      directory: "/project",
      title: "Context test",
      version: "test",
      agent: Agent.ID.make("build"),
    })
    .run()
    .pipe(Effect.orDie)
  const session = yield* store.get(sessionID)
  if (!session) return yield* Effect.die("Session fixture missing")
  return {
    db,
    bus,
    session,
    context,
    instructions: yield* instructionBuiltIns.load(),
  }
})

describe("SessionContext", () => {
  it.effect("relocates volatile core/date and core/environment instructions to first user message", () =>
    Effect.gen(function* () {
      const { db, bus, session, context, instructions } = yield* setup
      yield* InstructionState.prepare(db, bus, instructions, sessionID)

      const user1 = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.InboxEnqueued, {
        sessionID,
        inboxID: user1,
        item: { type: "user", payload: { text: "First message" }, delivery: "steer" },
      })
      yield* bus.publish(SessionEvent.InboxDelivered, {
        sessionID,
        inboxID: user1,
      })

      const user2 = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.InboxEnqueued, {
        sessionID,
        inboxID: user2,
        item: { type: "user", payload: { text: "Second message" }, delivery: "steer" },
      })
      yield* bus.publish(SessionEvent.InboxDelivered, {
        sessionID,
        inboxID: user2,
      })

      const selection = yield* context.select(session.id)

      // 1. Selection partitioning
      expect(selection.volatileInstructions).toBeDefined()
      const volatileKeys: string[] = selection.volatileInstructions!.map((i) => i.key)
      expect(volatileKeys).toContain("core/date")
      expect(volatileKeys).toContain("core/environment")
      expect(volatileKeys).not.toContain("test/static")

      const staticKeys: string[] = selection.instructions.map((i) => i.key)
      expect(staticKeys).toContain("test/static")
      expect(staticKeys).not.toContain("core/date")
      expect(staticKeys).not.toContain("core/environment")

      // 2. Load and verify messages
      const loaded = yield* context.load(selection)

      // Initial instructions rendered for LLM system prompt do NOT have volatile sources
      expect(loaded.initial).toContain("Static: static info")
      expect(loaded.initial).not.toContain("Today's date")
      expect(loaded.initial).not.toContain("Environment")

      // First user message receives the <system-reminder> wrapper containing date & env
      const userMessages = loaded.messages.filter((m) => m.type === "user")
      expect(userMessages).toHaveLength(2)

      const firstMsg = userMessages[0]
      expect(firstMsg.text).toContain("<system-reminder>")
      expect(firstMsg.text).toContain("Today's date: Fri Oct 30 2026")
      expect(firstMsg.text).toContain("Environment: <env>dir: /project</env>")
      expect(firstMsg.text).toContain("</system-reminder>")
      expect(firstMsg.text).toContain("First message")

      // Second user message does NOT receive <system-reminder>
      const secondMsg = userMessages[1]
      expect(secondMsg.text).toBe("Second message")
      expect(secondMsg.text).not.toContain("<system-reminder>")
    }),
  )
  it.effect("freezes initial date across epoch and emits date rollover reminder on tail user message", () =>
    Effect.gen(function* () {
      const { db, bus, session, context, instructions } = yield* setup
      yield* InstructionState.prepare(db, bus, instructions, session.id)

      const user1 = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.InboxEnqueued, {
        sessionID: session.id,
        inboxID: user1,
        item: { type: "user", payload: { text: "Turn 1 first message" }, delivery: "steer" },
      })
      yield* bus.publish(SessionEvent.InboxDelivered, {
        sessionID: session.id,
        inboxID: user1,
      })

      const selection1 = yield* context.select(session.id)
      const loaded1 = yield* context.load(selection1)
      const firstMsg1 = loaded1.messages.find((m) => m.type === "user")!
      expect(firstMsg1.text).toContain("<system-reminder>")
      expect(firstMsg1.text).toContain("Today's date: Fri Oct 30 2026")
      expect(firstMsg1.text).toContain("Turn 1 first message")
      expect(firstMsg1.text).not.toContain("[Date rollover:")
      const savedInitial = loaded1.initial

      // Step 2 in same turn: initial instructions and first message are byte-identical
      const selection2 = yield* context.select(session.id)
      const loaded2 = yield* context.load(selection2)
      expect(loaded2.initial).toBe(savedInitial)
      const firstMsg2 = loaded2.messages.find((m) => m.type === "user")!
      expect(firstMsg2.text).toBe(firstMsg1.text)

      // Turn 2 tail message arrives on a rolled-over date
      const user2 = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.InboxEnqueued, {
        sessionID: session.id,
        inboxID: user2,
        item: { type: "user", payload: { text: "Turn 2 continuation" }, delivery: "steer" },
      })
      yield* bus.publish(SessionEvent.InboxDelivered, {
        sessionID: session.id,
        inboxID: user2,
      })

      const rolledOverDateInstructions = Instructions.combine([
        Instructions.make({
          key: Instructions.Key.make("core/date"),
          codec: Schema.toCodecJson(Schema.String),
          read: Effect.succeed("Sat Oct 31 2026"),
          render: {
            initial: (date) => `Today's date: ${date}`,
            changed: (_p, date) => `Today's date is now: ${date}`,
          },
        }),
      ])

      const selection3 = {
        ...(yield* context.select(session.id)),
        volatileInstructions: rolledOverDateInstructions,
      }
      const loaded3 = yield* context.load(selection3)

      const userMessages3 = loaded3.messages.filter((m) => m.type === "user")
      expect(userMessages3).toHaveLength(2)

      // First message MUST remain 100% frozen (no KV token bust!)
      expect(userMessages3[0].text).toBe(firstMsg1.text)
      expect(loaded3.initial).toBe(savedInitial)

      // Tail user message receives the date rollover reminder without mutating message 0
      expect(userMessages3[1].text).toContain("[Date rollover: 2026-10-31]")
      expect(userMessages3[1].text).toContain("Turn 2 continuation")
      expect(userMessages3[1].text).not.toContain("<system-reminder>")
    }),
  )
})
