import { describe, expect } from "bun:test"
import { LanguageModel, LLMClient, ToolCall } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { Instructions } from "@opencode/core/instructions/index"
import { Location } from "@opencode/core/location"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Project } from "@opencode/core/project"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionContext } from "@opencode/core/session/context"
import { SessionEpochPrefix } from "@opencode/core/session/epoch-prefix"
import { SessionEvent } from "@opencode/core/session/event"
import { InstructionState } from "@opencode/core/session/instruction-state"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionEpochPrefixTable, SessionTable, SessionTurnReminderTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Tool } from "@opencode/core/tool"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { eq } from "drizzle-orm"
import { Effect, Exit, Layer, Schema, Stream } from "effect"
import { testEffect } from "./lib/effect"

let volatileDate = "Fri Oct 30 2026"
let volatileEnv = "<env>dir: /project, branch: main</env>"

const builtins = Layer.mock(InstructionBuiltIns.Service, {
  load: () =>
    Effect.sync(() =>
      Instructions.combine([
        Instructions.make({
          key: Instructions.Key.make("test/static"),
          codec: Schema.toCodecJson(Schema.String),
          read: Effect.succeed("static baseline"),
          render: {
            initial: (v) => `Static: ${v}`,
            changed: (_p, v) => `Static changed: ${v}`,
          },
        }),
        Instructions.make({
          key: Instructions.Key.make("core/date"),
          codec: Schema.toCodecJson(Schema.String),
          read: Effect.sync(() => volatileDate),
          render: {
            initial: (date) => `Today's date: ${date}`,
            changed: (_p, date) => `Today's date is now: ${date}`,
          },
        }),
        Instructions.make({
          key: Instructions.Key.make("core/environment"),
          codec: Schema.toCodecJson(Schema.String),
          read: Effect.sync(() => volatileEnv),
          render: {
            initial: (env) => `Environment: ${env}`,
            changed: (_p, env) => `Environment changed: ${env}`,
          },
        }),
      ]),
    ),
})

const skills = Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const references = Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const mcp = Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })

const testModel = LanguageModel.make({ id: "durable-prefix-model", provider: "test", route: OpenAIChat.route })

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
      InstructionDiscovery.node,
      Tool.node,
      SessionContext.node,
      PluginHooks.node,
      llmClient,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      llmClient.replace(dummyClient),
      SessionRunnerModel.node.replace(models),
      InstructionBuiltIns.node.replace(builtins),
      SkillInstructions.node.replace(skills),
      ReferenceInstructions.node.replace(references),
      McpInstructions.node.replace(mcp),
      PluginSupervisor.node.replace(Layer.empty),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    ],
  ),
)

const setupFixture = (rawSessionId: string) =>
  Effect.gen(function* () {
    volatileDate = "Fri Oct 30 2026"
    volatileEnv = "<env>dir: /project, branch: main</env>"
    SessionContext.resetEpochCache()

    const sessionID = SessionSchema.ID.make(rawSessionId)
    const database = yield* Database.Service
    const db = database.db
    const bus = yield* Bus.Service
    const agents = yield* Agent.Service
    const projects = yield* Project.Service
    const discovery = yield* InstructionDiscovery.Service
    const registry = yield* Tool.Service
    const hooks = yield* PluginHooks.Service
    const context = yield* SessionContext.Service
    const store = yield* SessionStore.Service

    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("build"), (agent) => {
        agent.mode = "primary"
      }),
    )

    yield* discovery.transform((editor) => {
      for (const existing of editor.list()) editor.remove(existing.path)
      editor.add(
        new InstructionDiscovery.File({
          path: "/project/AGENTS.md",
          content: "# Workspace Rules\n- Keep logs concise.",
        }),
      )
    })

    let alphaHandlerVersion = "v1"
    yield* registry.transform((editor) => {
      for (const existing of editor.list()) editor.remove(existing.id)
      editor.add({
        name: "alpha",
        description: "Alpha tool v1 description",
        input: Schema.Struct({ query: Schema.String }),
        output: Schema.String,
        options: { codemode: false },
        execute: ({ query }) => Effect.succeed({ output: `alpha-${alphaHandlerVersion}:${query}` }),
      })
      editor.add({
        name: "restricted",
        description: "Restricted secret tool",
        input: Schema.Struct({ target: Schema.String }),
        output: Schema.String,
        options: { codemode: false },
        execute: ({ target }) => Effect.succeed({ output: `secret:${target}` }),
      })
    })

    const resolvedProject = yield* projects.resolve(AbsolutePath.make("/project"))
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: resolvedProject.id,
        slug: "durable-prefix-test",
        directory: "/project",
        title: "Durable prefix test",
        version: "test",
        agent: Agent.ID.make("build"),
      })
      .run()
      .pipe(Effect.orDie)

    const initialSelection = yield* context.select(sessionID)
    yield* InstructionState.prepare(db, bus, initialSelection.instructions, sessionID)

    const session = yield* store.get(sessionID)
    if (!session) return yield* Effect.die(new Error("Session fixture missing"))

    const deliverUserTurn = (text: string) =>
      Effect.gen(function* () {
        const msgID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.InboxEnqueued, {
          sessionID,
          inboxID: msgID,
          item: { type: "user", payload: { text }, delivery: "steer" },
        })
        yield* bus.publish(SessionEvent.InboxDelivered, {
          sessionID,
          inboxID: msgID,
        })
        return msgID
      })

    const preparePrimary = (loaded: SessionContext.Loaded) => {
      const transcript = SessionModelRequest.baseTranscript({
        agent: loaded.agent.info,
        model: loaded.model,
        tools: loaded.tools,
        initial: loaded.initial,
        messages: loaded.messages,
      })
      return context.request.primary({
        session: loaded.session,
        agent: loaded.agent.id,
        model: loaded.model,
        tools: loaded.tools,
        system: transcript.system,
        messages: transcript.messages,
      })
    }

    return {
      sessionID,
      db,
      bus,
      discovery,
      registry,
      hooks,
      context,
      deliverUserTurn,
      preparePrimary,
      setAlphaHandlerVersion: (v: string) => {
        alphaHandlerVersion = v
      },
    }
  })

describe("Durable Epoch-Frozen Prefix & Append-Only Tail Deltas", () => {
  it.effect(
    "Test 1: survives resetEpochCache across AGENTS.md edits, tool schema/permission/addition changes, and volatile mutations",
    () =>
      Effect.gen(function* () {
        const fx = yield* setupFixture("ses_durable_prefix_t1")

        let hookSuffix = "hook-v1"
        yield* fx.hooks.register("session", "context", (event) =>
          Effect.sync(() => {
            if (event.tools.alpha) {
              event.tools.alpha.description = `${event.tools.alpha.description} [${hookSuffix}]`
            }
          }),
        )

        const turn1ID = yield* fx.deliverUserTurn("Turn 1 prompt")
        const sel1 = yield* fx.context.select(fx.sessionID)
        const loaded1 = yield* fx.context.load(sel1)
        const prep1 = yield* fx.preparePrimary(loaded1)

        const turn1Initial = loaded1.initial
        const turn1SystemJson = JSON.stringify(prep1.request.system)
        const turn1LoadedToolsJson = JSON.stringify(loaded1.tools.definitions)
        const turn1PreparedToolsJson = JSON.stringify(prep1.request.tools)
        const turn1FirstMsgText = loaded1.messages[0]?.type === "user" ? loaded1.messages[0].text : ""

        expect(turn1Initial).toContain("# Workspace Rules")
        expect(turn1Initial).toContain("- Keep logs concise.")
        expect(turn1FirstMsgText).toContain("Today's date: Fri Oct 30 2026")
        expect(turn1FirstMsgText).toContain("branch: main")
        expect(turn1PreparedToolsJson).toContain("Alpha tool v1 description [hook-v1]")

        // Simulate full opencode process restart by wiping all L1 in-memory caches
        SessionContext.resetEpochCache()

        // Mutate workspace AGENTS.md, volatile date & env, existing tool schema + handler, hook suffix,
        // revoke 'restricted' tool permission, and add brand-new tool 'omega'
        yield* fx.discovery.transform((editor) => {
          editor.update("/project/AGENTS.md", (file) => {
            file.content = "# Workspace Rules\n- Keep logs concise.\n- Always prefer Zig over C."
          })
        })
        volatileDate = "Sat Oct 31 2026"
        volatileEnv = "<env>dir: /project, branch: feat/zig</env>"
        hookSuffix = "hook-v2-mutated"
        fx.setAlphaHandlerVersion("v2")

        yield* fx.registry.transform((editor) => {
          editor.update("alpha", (tool) => {
            tool.description = "Alpha tool v2 mutated description"
          })
          editor.add({
            name: "omega",
            description: "Brand new omega tool",
            input: Schema.Struct({ x: Schema.Number }),
            output: Schema.String,
            options: { codemode: false },
            execute: ({ x }) => Effect.succeed({ output: `omega:${x}` }),
          })
        })

        // Revoke permission for 'restricted' on the session
        yield* fx.bus.publish(SessionEvent.Permissions, {
          sessionID: fx.sessionID,
          permissions: [{ action: "restricted", resource: "*", effect: "deny" }],
        })

        const turn2ID = yield* fx.deliverUserTurn("Turn 2 prompt")
        const sel2 = yield* fx.context.select(fx.sessionID)
        const loaded2 = yield* fx.context.load(sel2)
        const prep2 = yield* fx.preparePrimary(loaded2)

        // 1. <｜System｜> initial instructions & system parts MUST be 100% byte-identical to Turn 1
        expect(loaded2.initial).toBe(turn1Initial)
        expect(JSON.stringify(prep2.request.system)).toBe(turn1SystemJson)

        // 2. LLM-facing tool schemas (both loaded.tools.definitions and post-hook prepared.request.tools) MUST be 100% byte-identical
        expect(JSON.stringify(loaded2.tools.definitions)).toBe(turn1LoadedToolsJson)
        expect(JSON.stringify(prep2.request.tools)).toBe(turn1PreparedToolsJson)

        // 3. Turn 1 user message MUST be 100% byte-identical (no KV prefix bust)
        const userMsgs2 = loaded2.messages.filter((m) => m.type === "user")
        expect(userMsgs2).toHaveLength(2)
        expect(userMsgs2[0]!.id).toBe(turn1ID)
        expect(userMsgs2[0]!.text).toBe(turn1FirstMsgText)

        // 4. Turn 2 tail user message receives compact instruction delta, date rollover, and new-tool notice
        expect(userMsgs2[1]!.id).toBe(turn2ID)
        expect(userMsgs2[1]!.text).toContain("<system-reminder>")
        expect(userMsgs2[1]!.text).toContain("[Workspace instructions updated since session start]")
        expect(userMsgs2[1]!.text).toContain("+ - Always prefer Zig over C.")
        expect(userMsgs2[1]!.text).toContain("[Date rollover: 2026-10-31]")
        expect(userMsgs2[1]!.text).toContain("[New tools available after /compact: omega]")
        expect(userMsgs2[1]!.text).toContain("Turn 2 prompt")
        const turn2PinnedText = userMsgs2[1]!.text

        // 5. Permitted tool executes UPDATED live v2 handler while keeping frozen v1 schema
        const alphaRes = yield* prep2.executeTool({
          sessionID: fx.sessionID,
          agent: Agent.ID.make("build"),
          messageID: turn2ID,
          call: ToolCall.make({ id: "call-alpha", name: "alpha", input: { query: "hello" } }),
        })
        expect(alphaRes.output).toBe("alpha-v2:hello")

        // 6. Revoked tool fails cleanly at runtime with permission-denied Tool.Error
        const restrictedExit = yield* Effect.exit(
          prep2.executeTool({
            sessionID: fx.sessionID,
            agent: Agent.ID.make("build"),
            messageID: turn2ID,
            call: ToolCall.make({ id: "call-restricted", name: "restricted", input: { target: "vault" } }),
          }),
        )
        expect(Exit.isFailure(restrictedExit)).toBe(true)
        expect(String(restrictedExit)).toContain('Permission denied: tool "restricted" is no longer permitted')

        // 7. Uncompacted new tool is blocked until /compact
        const omegaExit = yield* Effect.exit(
          prep2.executeTool({
            sessionID: fx.sessionID,
            agent: Agent.ID.make("build"),
            messageID: turn2ID,
            call: ToolCall.make({ id: "call-omega", name: "omega", input: { x: 42 } }),
          }),
        )
        expect(Exit.isFailure(omegaExit)).toBe(true)
        expect(String(omegaExit)).toContain("run /compact to enable new tools")

        // 8. Mid-turn Step 2 stability: editing AGENTS.md mid-turn (same lastUserMsg.id) MUST NOT mutate Turn 2 mid-turn
        SessionContext.resetEpochCache()
        yield* fx.discovery.transform((editor) => {
          editor.update("/project/AGENTS.md", (file) => {
            file.content =
              "# Workspace Rules\n- Keep logs concise.\n- Always prefer Zig over C.\n- Mid-turn step 2 edit."
          })
        })
        const sel2Step2 = yield* fx.context.select(fx.sessionID)
        const loaded2Step2 = yield* fx.context.load(sel2Step2)
        const userMsgs2Step2 = loaded2Step2.messages.filter((m) => m.type === "user")
        expect(userMsgs2Step2[1]!.text).toBe(turn2PinnedText)
      }),
  )

  it.effect(
    "Test 2: preserves strict multi-turn monotonicity across Turn 1 -> Turn 2 -> Turn 3 without retroactive stripping",
    () =>
      Effect.gen(function* () {
        const fx = yield* setupFixture("ses_durable_prefix_t2")

        yield* fx.deliverUserTurn("Turn 1 question")
        const loaded1 = yield* fx.context.load(yield* fx.context.select(fx.sessionID))
        const turn1Text = loaded1.messages.find((m) => m.type === "user")!.text

        // Restart + edit AGENTS.md before Turn 2
        SessionContext.resetEpochCache()
        yield* fx.discovery.transform((editor) => {
          editor.update("/project/AGENTS.md", (file) => {
            file.content = "# Workspace Rules\n- Keep logs concise.\n- Prefer immutable data structures."
          })
        })

        yield* fx.deliverUserTurn("Turn 2 question")
        const loaded2 = yield* fx.context.load(yield* fx.context.select(fx.sessionID))
        const users2 = loaded2.messages.filter((m) => m.type === "user")
        expect(users2).toHaveLength(2)
        expect(users2[0]!.text).toBe(turn1Text)
        expect(users2[1]!.text).toContain("[Workspace instructions updated since session start]")
        expect(users2[1]!.text).toContain("+ - Prefer immutable data structures.")
        const turn2Text = users2[1]!.text

        // Restart again + NO further AGENTS.md edits before Turn 3
        SessionContext.resetEpochCache()
        yield* fx.deliverUserTurn("Turn 3 follow-up")
        const loaded3 = yield* fx.context.load(yield* fx.context.select(fx.sessionID))
        const users3 = loaded3.messages.filter((m) => m.type === "user")
        expect(users3).toHaveLength(3)

        // Turn 1 and Turn 2 MUST remain 100% byte-identical (Turn 2 keeps its <system-reminder>, zero retroactive stripping)
        expect(users3[0]!.text).toBe(turn1Text)
        expect(users3[1]!.text).toBe(turn2Text)

        // Turn 3 has NO redundant <system-reminder>
        expect(users3[2]!.text).toBe("Turn 3 follow-up")
        expect(users3[2]!.text).not.toContain("<system-reminder>")
      }),
  )

  it.effect(
    "Test 3: refreshes frozen <｜System｜>, tool schemas, permissions, and volatile reminder on post-compaction epoch",
    () =>
      Effect.gen(function* () {
        const fx = yield* setupFixture("ses_durable_prefix_t3")

        yield* fx.deliverUserTurn("Epoch 1 turn 1")
        const loaded1 = yield* fx.context.load(yield* fx.context.select(fx.sessionID))
        expect(loaded1.initial).not.toContain("Always prefer Zig over C.")

        // Mid-epoch mutations
        yield* fx.discovery.transform((editor) => {
          editor.update("/project/AGENTS.md", (file) => {
            file.content = "# Workspace Rules\n- Keep logs concise.\n- Always prefer Zig over C."
          })
        })
        volatileDate = "Sun Nov 01 2026"
        volatileEnv = "<env>dir: /project, branch: release/v2</env>"

        yield* fx.registry.transform((editor) => {
          editor.update("alpha", (tool) => {
            tool.description = "Alpha tool post-compact v2"
          })
          editor.add({
            name: "omega",
            description: "Omega unlocked after compaction",
            input: Schema.Struct({ x: Schema.Number }),
            output: Schema.String,
            options: { codemode: false },
            execute: ({ x }) => Effect.succeed({ output: `omega-ok:${x}` }),
          })
        })
        yield* fx.bus.publish(SessionEvent.Permissions, {
          sessionID: fx.sessionID,
          permissions: [{ action: "restricted", resource: "*", effect: "deny" }],
        })

        // Prepare instruction state before compaction (matching SessionRunner.prepareContext) and complete compaction
        const preCompactSel = yield* fx.context.select(fx.sessionID)
        yield* InstructionState.prepare(fx.db, fx.bus, preCompactSel.instructions, fx.sessionID)
        yield* fx.bus.publish(SessionEvent.Compaction.Started, {
          sessionID: fx.sessionID,
          reason: "auto",
        })
        yield* fx.bus.publish(SessionEvent.Compaction.Ended, {
          sessionID: fx.sessionID,
          reason: "auto",
          model: loaded1.model.ref,
          text: "## Objective\n- Compacted epoch summary",
        })

        const postTurnID = yield* fx.deliverUserTurn("Epoch 2 first prompt")
        SessionContext.resetEpochCache()

        const selPost = yield* fx.context.select(fx.sessionID)
        const loadedPost = yield* fx.context.load(selPost)
        const prepPost = yield* fx.preparePrimary(loadedPost)

        // New epoch baseline picks up updated AGENTS.md directly in <｜System｜>
        expect(loadedPost.initial).toContain("- Always prefer Zig over C.")

        // New epoch tool schemas reflect updated description, newly unlocked 'omega', and omit revoked 'restricted'
        const toolNames = loadedPost.tools.definitions.map((t) => t.name)
        expect(toolNames).toContain("alpha")
        expect(toolNames).toContain("omega")
        expect(toolNames).not.toContain("restricted")
        expect(loadedPost.tools.definitions.find((t) => t.name === "alpha")?.description).toBe(
          "Alpha tool post-compact v2",
        )

        // 'omega' is now executable in the new epoch
        const omegaRes = yield* prepPost.executeTool({
          sessionID: fx.sessionID,
          agent: Agent.ID.make("build"),
          messageID: postTurnID,
          call: ToolCall.make({ id: "call-omega-post", name: "omega", input: { x: 99 } }),
        })
        expect(omegaRes.output).toBe("omega-ok:99")

        // First post-compaction user message receives refreshed volatile date & env without stale delta notice
        const postUsers = loadedPost.messages.filter((m) => m.type === "user")
        expect(postUsers).toHaveLength(1)
        expect(postUsers[0]!.text).toContain("Today's date: Sun Nov 01 2026")
        expect(postUsers[0]!.text).toContain("branch: release/v2")
        expect(postUsers[0]!.text).not.toContain("[Workspace instructions updated since session start]")
      }),
  )

  it.effect("Test 4: cascades SQLite cleanup on session deletion and caps large instruction deltas at <= 12 KiB", () =>
    Effect.gen(function* () {
      const fx = yield* setupFixture("ses_durable_prefix_t4")

      yield* fx.deliverUserTurn("Turn 1")
      yield* fx.context.load(yield* fx.context.select(fx.sessionID))
      yield* fx.deliverUserTurn("Turn 2")
      yield* fx.context.load(yield* fx.context.select(fx.sessionID))

      const epochsBefore = yield* fx.db
        .select()
        .from(SessionEpochPrefixTable)
        .where(eq(SessionEpochPrefixTable.session_id, fx.sessionID))
        .all()
        .pipe(Effect.orDie)
      const remindersBefore = yield* fx.db
        .select()
        .from(SessionTurnReminderTable)
        .where(eq(SessionTurnReminderTable.session_id, fx.sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(epochsBefore.length).toBeGreaterThan(0)
      expect(remindersBefore.length).toBeGreaterThan(0)

      // Verify getSubagentReminder reports available subagent slots when subagent tool is present
      const loadedWithAlpha = yield* fx.context.load(yield* fx.context.select(fx.sessionID))
      expect(SessionEpochPrefix.getSubagentReminder(fx.sessionID, loadedWithAlpha.tools, true, true)).toBe("")
      yield* fx.registry.transform((editor) => {
        editor.add({
          name: "subagent",
          description: "Spawn a child subagent",
          input: Schema.Struct({ prompt: Schema.String }),
          output: Schema.String,
          options: { codemode: false },
          execute: () => Effect.succeed({ output: "ok" }),
        })
      })
      const selWithSubagent = yield* fx.context.select(fx.sessionID)
      const reminderText = SessionEpochPrefix.getSubagentReminder(fx.sessionID, selWithSubagent.tools, true, true)
      expect(reminderText).toContain("concurrent 128k subagent slots available")
      expect(reminderText).toContain(
        "If this task can be split up and resources are available, do so and invoke subagents to help.",
      )
      expect(SessionEpochPrefix.getSubagentReminder(fx.sessionID, selWithSubagent.tools, false, true)).toBe("")

      // Deleting the session cascades to both session_epoch_prefix and session_turn_reminder
      yield* fx.db.delete(SessionTable).where(eq(SessionTable.id, fx.sessionID)).run().pipe(Effect.orDie)

      const epochsAfter = yield* fx.db
        .select()
        .from(SessionEpochPrefixTable)
        .where(eq(SessionEpochPrefixTable.session_id, fx.sessionID))
        .all()
        .pipe(Effect.orDie)
      const remindersAfter = yield* fx.db
        .select()
        .from(SessionTurnReminderTable)
        .where(eq(SessionTurnReminderTable.session_id, fx.sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(epochsAfter).toHaveLength(0)
      expect(remindersAfter).toHaveLength(0)

      // Verify blank-only changes produce empty delta and >30KB diffs are deterministically capped at <= 12,288 chars
      expect(SessionContext.computeInstructionDelta("Rule A\nRule B", "Rule A\n\nRule B\n")).toBe("")
      const hugeAfter = Array.from(
        { length: 800 },
        (_, i) => `- Detailed workspace guideline #${i}: ${"x".repeat(48)}`,
      ).join("\n")
      const delta1 = SessionContext.computeInstructionDelta("# Rules\n- Base", `# Rules\n- Base\n${hugeAfter}`)
      const delta2 = SessionContext.computeInstructionDelta("# Rules\n- Base", `# Rules\n- Base\n${hugeAfter}`)
      expect(delta1).toBe(delta2)
      expect(delta1.length).toBeLessThanOrEqual(SessionEpochPrefix.MAX_INSTRUCTION_DELTA_CHARS)
      expect(delta1).toContain("[Workspace instructions updated since session start]")
      expect(delta1).toContain("[instruction delta truncated; run /compact to refresh full baseline]")
    }),
  )
})
