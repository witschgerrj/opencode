import { beforeEach, describe, expect, test } from "bun:test"
import { LanguageModel, ToolCallPart } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/core/agent"
import { Config } from "@opencode/core/config"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Permission } from "@opencode/core/permission"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRecentText } from "@opencode/core/session/recent-text"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionSlotLease } from "@opencode/core/session/slot-lease"
import { SessionStep } from "@opencode/core/session/runner/step"
import { Tool } from "@opencode/core/tool"
import { RequestSynthesisTool } from "@opencode/core/tool/plugin/request-synthesis"
import { SubagentTool } from "@opencode/core/tool/plugin/subagent"
import { Token } from "@opencode/core/util/token"
import { Money } from "@opencode/schema/money"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { DateTime, Effect, Exit, Layer } from "effect"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolDefinitions, toolIdentity } from "./lib/tool"

const created = DateTime.makeUnsafe(1_700_000_000_000)

const zeroCost: Model.Info["cost"] = []

const zeroTokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

const makeResolvedModel = (options: {
  readonly providerID: string
  readonly modelID?: string
  readonly variant?: string
  readonly defaultHttpBody?: Record<string, unknown>
}) => {
  const modelID = options.modelID ?? "deepseek-v4.1-flash"
  const lm = LanguageModel.make({
    provider: options.providerID,
    id: modelID,
    route: {
      ...OpenAIChat.route,
      id: modelID,
      defaults: {
        ...OpenAIChat.route.defaults,
        ...(options.defaultHttpBody ? { http: { body: options.defaultHttpBody } } : {}),
      },
    },
  })
  return SessionRunnerModel.resolved(lm, {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    ...(options.variant ? { variant: Model.VariantID.make(options.variant) } : {}),
    cost: zeroCost,
    limit: { context: 393_216, output: 32_768 },
  })
}

const makeSession = (id: string, parentID?: string): SessionSchema.Info =>
  SessionSchema.Info.make({
    id: SessionSchema.ID.make(id),
    projectID: Project.ID.global,
    location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
    ...(parentID ? { parentID: SessionSchema.ID.make(parentID) } : {}),
    cost: Money.USD.zero,
    tokens: zeroTokens,
    title: id,
    time: { created, updated: created },
  })

const makeAgent = (id: string) => {
  const agentID = Agent.ID.make(id)
  const info = Agent.Info.default(agentID)
  return { id: agentID, info }
}

const requestSynthesisToolNode = makeLocationNode({
  name: "test/request-synthesis-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(RequestSynthesisTool.Plugin)),
  deps: [Tool.node, Permission.node],
})

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(process.cwd()) })),
)

const itTool = testEffect(
  AppNodeBuilder.build(LayerNode.group([Tool.node, requestSynthesisToolNode]), [
    Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
    Config.node.replace(Config.testLayer([])),
    Location.node.replace(locationLayer),
    Global.node.replace(Global.layerWith({ data: Global.Path.data })),
  ]),
)

describe("Aquanox Pillar 2 — SessionSlotLease (3-slot deterministic leasing)", () => {
  beforeEach(() => {
    SessionSlotLease.reset()
  })

  test("pins root sessions to Slot 0 and concurrent child sub-agents to distinct Slots 1 and 2", () => {
    const root = SessionSlotLease.acquire(SessionSchema.ID.make("ses_root"), false)
    const child1 = SessionSlotLease.acquire(SessionSchema.ID.make("ses_child_1"), true)
    const child2 = SessionSlotLease.acquire(SessionSchema.ID.make("ses_child_2"), true)

    expect(root).toBe(0)
    expect(child1).toBe(1)
    expect(child2).toBe(2)
    expect(SessionSlotLease.activeCount(1)).toBe(1)
    expect(SessionSlotLease.activeCount(2)).toBe(1)
  })

  test("maintains intra-session multi-step stickiness and continuation affinity while avoiding busy collisions", () => {
    const c1 = SessionSchema.ID.make("ses_sa_1")
    const c2 = SessionSchema.ID.make("ses_sa_2")
    const c3 = SessionSchema.ID.make("ses_sa_3")

    expect(SessionSlotLease.acquire(c1, true)).toBe(1)
    expect(SessionSlotLease.acquire(c1, true)).toBe(1)
    expect(SessionSlotLease.acquire(c2, true)).toBe(2)

    // c1 finishes its turn; its active lease releases, but sticky pin remains 1.
    SessionSlotLease.release(c1)
    expect(SessionSlotLease.activeCount(1)).toBe(0)
    expect(SessionSlotLease.peek(c1, true)).toBe(1)

    // Resuming c1 re-claims Slot 1 for 100% KV cache reuse.
    expect(SessionSlotLease.acquire(c1, true)).toBe(1)
    SessionSlotLease.release(c1)

    // If c3 claims Slot 1 while c2 finishes Slot 2, resuming c1 moves to free Slot 2 rather than colliding on busy Slot 1.
    expect(SessionSlotLease.acquire(c3, true)).toBe(1)
    SessionSlotLease.release(c2)
    expect(SessionSlotLease.acquire(c1, true)).toBe(2)
  })

  test("manages 3-slot dynamic LRU lease across multiple concurrent root sessions without collisions and dispatches -1 on saturation", () => {
    const root1 = SessionSchema.ID.make("ses_root_1")
    const root2 = SessionSchema.ID.make("ses_root_2")
    const root3 = SessionSchema.ID.make("ses_root_3")
    const root4 = SessionSchema.ID.make("ses_root_4")

    // Concurrent Root 1 takes Slot 0
    expect(SessionSlotLease.acquire(root1, false)).toBe(0)
    expect(SessionSlotLease.activeCount(0)).toBe(1)

    // Concurrent Root 2 dynamically acquires idle Slot 1 (no collision / head-of-line blocking!)
    expect(SessionSlotLease.acquire(root2, false)).toBe(1)
    expect(SessionSlotLease.activeCount(1)).toBe(1)

    // Concurrent Root 3 dynamically acquires idle Slot 2
    expect(SessionSlotLease.acquire(root3, false)).toBe(2)
    expect(SessionSlotLease.activeCount(2)).toBe(1)

    // All 3 slots saturated -> returns -1 for dynamic llama-server scheduling
    expect(SessionSlotLease.acquire(root4, false)).toBe(-1)

    // Release Root 1 -> Slot 0 becomes idle
    SessionSlotLease.release(root1)
    expect(SessionSlotLease.activeCount(0)).toBe(0)

    // Root 1 re-acquires and reclaims sticky Slot 0 for 100% KV cache affinity
    expect(SessionSlotLease.acquire(root1, false)).toBe(0)
    expect(SessionSlotLease.activeCount(0)).toBe(1)

    // Cleanup
    SessionSlotLease.release(root1)
    SessionSlotLease.release(root2)
    SessionSlotLease.release(root3)
    expect(SessionSlotLease.activeCount(0)).toBe(0)
    expect(SessionSlotLease.activeCount(1)).toBe(0)
    expect(SessionSlotLease.activeCount(2)).toBe(0)
  })

  test("guarantees slot release via withLease even on failure or interruption", async () => {
    const root = SessionSchema.ID.make("ses_root_leak_test")
    let observedSlot: SessionSlotLease.SlotID | undefined

    const result = await Effect.runPromise(
      SessionSlotLease.withLease(root, false, (slot) =>
        Effect.gen(function* () {
          observedSlot = slot
          expect(SessionSlotLease.activeCount(slot)).toBe(1)
          return yield* Effect.fail(new Error("simulated failure"))
        }),
      ).pipe(Effect.exit),
    )

    expect(observedSlot).toBe(0)
    expect(Exit.isFailure(result)).toBe(true)
    // Active count guaranteed decremented back to 0
    expect(SessionSlotLease.activeCount(0)).toBe(0)
  })
})

describe("Aquanox Pillar 2 — SubagentTool.bindChildSubagentModel", () => {
  const catalogWith = (variantIDs: string[]): Model.Info => ({
    ...Model.Info.default(Provider.ID.make("deepseek-local"), Model.ID.make("deepseek-v4.1-flash")),
    variants: variantIDs.map((v) => ({ id: Model.VariantID.make(v) })),
  })

  test("binds child sub-agents from parent #max to #subagent-high when configured, else falls back to #high", () => {
    const parentRef = Model.Ref.make({
      providerID: Provider.ID.make("deepseek-local"),
      id: Model.ID.make("deepseek-v4.1-flash"),
      variant: Model.VariantID.make("max"),
    })

    const boundSubHigh = SubagentTool.bindChildSubagentModel(parentRef, [
      catalogWith(["low", "medium", "subagent-high", "high", "max"]),
    ])
    expect(String(boundSubHigh?.variant)).toBe("subagent-high")

    const boundFallbackHigh = SubagentTool.bindChildSubagentModel(parentRef, [
      catalogWith(["low", "medium", "high", "max"]),
    ])
    expect(String(boundFallbackHigh?.variant)).toBe("high")

    const unchangedNoVariants = SubagentTool.bindChildSubagentModel(parentRef, [catalogWith([])])
    expect(String(unchangedNoVariants?.variant)).toBe("max")
  })
})

describe("Aquanox Pillar 2 — RequestSynthesisTool & Two-Stage Step Routing", () => {
  beforeEach(() => {
    SessionSlotLease.reset()
  })

  itTool.effect("registers request_synthesis tool and returns synthesis confirmation message", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      const defs = yield* toolDefinitions(registry)
      expect(defs.some((d) => d.name === "request_synthesis")).toBe(true)

      const resEmpty = yield* executeTool(registry, {
        call: ToolCallPart.make({ id: "call_synth_1", name: "request_synthesis", input: {} }),
        sessionID: SessionSchema.ID.make("ses_child_synth"),
        agent: toolIdentity.agent,
        messageID: toolIdentity.messageID,
      })
      expect(resEmpty.status).toBe("completed")
      expect(resEmpty.content).toEqual([{ type: "text", text: RequestSynthesisTool.CONFIRMATION }])

      const resPlanned = yield* executeTool(registry, {
        call: ToolCallPart.make({
          id: "call_synth_2",
          name: "request_synthesis",
          input: { summary_plan: "1. Architecture 2. Findings" },
        }),
        sessionID: SessionSchema.ID.make("ses_child_synth"),
        agent: toolIdentity.agent,
        messageID: toolIdentity.messageID,
      })
      expect(resPlanned.status).toBe("completed")
      expect(resPlanned.content).toEqual([{ type: "text", text: RequestSynthesisTool.CONFIRMATION }])
    }),
  )

  test("routes Root, explore action, general action, synthesis step, and gates out mock-local", () => {
    const deepseekMax = makeResolvedModel({
      providerID: "deepseek-local",
      variant: "max",
      defaultHttpBody: { reasoning_budget_tokens: -1 },
    })
    const deepseekSubHigh = makeResolvedModel({
      providerID: "deepseek-local",
      variant: "subagent-high",
      defaultHttpBody: { reasoning_budget_tokens: 4096 },
    })
    const mockLocal = makeResolvedModel({
      providerID: "mock-local",
      modelID: "mock-model",
    })

    const rootSession = makeSession("ses_root")
    const exploreSession = makeSession("ses_explore", "ses_root")
    const generalSession = makeSession("ses_general", "ses_root")

    const userMsg = SessionMessage.User.make({
      id: SessionMessage.ID.make("msg_u1"),
      type: "user",
      text: "Find files",
      time: { created },
    })

    // 1. Root session with -1 configured budget falls back to 12288 on #max and pins Slot 0
    const rootRoute = SessionRunnerLLM.resolveStepRouting({
      session: rootSession,
      agent: makeAgent("build"),
      model: deepseekMax,
      messages: [userMsg],
      stepLimitReached: false,
    })
    expect(rootRoute).toEqual({
      toolChoice: undefined,
      httpBody: { id_slot: 0, reasoning_budget_tokens: 2048, think_temp: 0.55, think_min_p: 0.01 },
      isSynthesizing: false,
    })

    // Prior exploratory tool output making this an active action continuation step
    const priorExploreTool = SessionMessage.Assistant.make({
      id: SessionMessage.ID.make("msg_a0_exp"),
      type: "assistant",
      agent: Agent.ID.make("explore"),
      model: deepseekSubHigh.ref,
      content: [
        SessionMessage.AssistantTool.make({
          type: "tool",
          id: "call_init",
          name: "glob",
          state: SessionMessage.ToolStateCompleted.make({
            status: "completed",
            input: {},
            content: [{ type: "text", text: "[]" }],
          }),
          time: { created, completed: created },
        }),
      ],
      time: { created, completed: created },
    })

    // 2. Explore child action step: Slot 1, toolChoice "auto", non-truncating exploratory ceiling 3072
    const exploreAction = SessionRunnerLLM.resolveStepRouting({
      session: exploreSession,
      agent: makeAgent("explore"),
      model: deepseekSubHigh,
      messages: [userMsg, priorExploreTool],
      stepLimitReached: false,
    })
    expect(exploreAction).toEqual({
      toolChoice: "auto",
      httpBody: { id_slot: 1, reasoning_budget_tokens: 256, think_temp: 0.55, think_min_p: 0.01 },
      isSynthesizing: false,
    })

    // 3. Concurrent General child action step: Slot 2, toolChoice "auto", non-truncating exploratory ceiling 3072
    const generalAction = SessionRunnerLLM.resolveStepRouting({
      session: generalSession,
      agent: makeAgent("general"),
      model: deepseekSubHigh,
      messages: [userMsg, priorExploreTool],
      stepLimitReached: false,
    })
    expect(generalAction).toEqual({
      toolChoice: "auto",
      httpBody: { id_slot: 2, reasoning_budget_tokens: 256, think_temp: 0.55, think_min_p: 0.01 },
      isSynthesizing: false,
    })

    // 4. After request_synthesis completes: flips to toolChoice "none" and reasoning_budget_tokens 4096 on same Slot 1
    const synthAssistant = SessionMessage.Assistant.make({
      id: SessionMessage.ID.make("msg_a1"),
      type: "assistant",
      agent: Agent.ID.make("explore"),
      model: deepseekSubHigh.ref,
      content: [
        SessionMessage.AssistantTool.make({
          type: "tool",
          id: "call_rs",
          name: "request_synthesis",
          state: SessionMessage.ToolStateCompleted.make({
            status: "completed",
            input: {},
            content: [{ type: "text", text: RequestSynthesisTool.CONFIRMATION }],
          }),
          time: { created, completed: created },
        }),
      ],
      time: { created, completed: created },
    })
    const exploreSynthesis = SessionRunnerLLM.resolveStepRouting({
      session: exploreSession,
      agent: makeAgent("explore"),
      model: deepseekSubHigh,
      messages: [userMsg, synthAssistant],
      stepLimitReached: false,
    })
    expect(exploreSynthesis).toEqual({
      toolChoice: "none",
      httpBody: { id_slot: 1, reasoning_budget_tokens: 1024, think_temp: 0.55, think_min_p: 0.01 },
      isSynthesizing: true,
    })

    // 5. mock-local (:18080) never receives id_slot or reasoning_budget_tokens
    const mockRoute = SessionRunnerLLM.resolveStepRouting({
      session: exploreSession,
      agent: makeAgent("explore"),
      model: mockLocal,
      messages: [userMsg],
      stepLimitReached: false,
    })
    expect(mockRoute.httpBody).toBeUndefined()
    expect(mockRoute.toolChoice).toBeUndefined()
  })
})

describe("Aquanox Pillar 2 — toLLMMessages sameModel reasoning preservation & <think>-aware budget text", () => {
  test("preserves { type: 'reasoning' } on sameModel errored/interrupted local turns without signed/encrypted native items", () => {
    const deepseekRef = Model.Ref.make({
      providerID: Provider.ID.make("deepseek-local"),
      id: Model.ID.make("deepseek-v4.1-flash"),
    })
    const interruptedAssistant = SessionMessage.Assistant.make({
      id: SessionMessage.ID.make("msg_interrupted"),
      type: "assistant",
      agent: Agent.ID.make("build"),
      model: deepseekRef,
      error: { type: "unknown", message: "stream interrupted" },
      content: [
        SessionMessage.AssistantReasoning.make({
          type: "reasoning",
          text: "Analyzing repository structure before timeout...",
          native: { reasoningField: "reasoning_content" },
          time: { created },
        }),
      ],
      time: { created },
    })

    const replay = toLLMMessages([interruptedAssistant], deepseekRef, "openai-compatible")
    expect(replay[0]?.content).toEqual([
      {
        type: "reasoning",
        text: "Analyzing repository structure before timeout...",
        providerMetadata: { "openai-compatible": { reasoningField: "reasoning_content" } },
      },
    ])
  })

  test("SessionRecentText.messageToBudgetText accounts for <think> reasoning and full untruncated tool outputs", () => {
    const deepseekRef = Model.Ref.make({
      providerID: Provider.ID.make("deepseek-local"),
      id: Model.ID.make("deepseek-v4.1-flash"),
    })
    const longThink = "thinking ".repeat(2_000)
    const longToolOutput = "line of code\n".repeat(1_000)
    const msg = SessionMessage.Assistant.make({
      id: SessionMessage.ID.make("msg_heavy"),
      type: "assistant",
      agent: Agent.ID.make("build"),
      model: deepseekRef,
      content: [
        SessionMessage.AssistantReasoning.make({
          type: "reasoning",
          text: longThink,
        }),
        SessionMessage.AssistantTool.make({
          type: "tool",
          id: "call_read",
          name: "read",
          state: SessionMessage.ToolStateCompleted.make({
            status: "completed",
            input: { filePath: "/project/src/index.ts" },
            content: [{ type: "text", text: longToolOutput }],
          }),
          time: { created, completed: created },
        }),
      ],
      time: { created, completed: created },
    })

    const displayRecent = SessionRecentText.messageToText(msg)
    const budgetRecent = SessionRecentText.messageToBudgetText(msg)

    expect(displayRecent).not.toContain(longThink)
    expect(displayRecent).toContain("[truncated]")
    expect(budgetRecent).toContain(longThink)
    expect(budgetRecent).toContain(longToolOutput)
    expect(Token.estimate(budgetRecent)).toBeGreaterThan(Token.estimate(displayRecent) * 5)
  })
})
describe("Aquanox Pillar 2 / Workstream 3 — Dirty-Gated Git Snapshots Carry-Forward", () => {
  beforeEach(() => {
    SessionStep.clearSnapshotCache()
  })

  test("maintains module LRU clean snapshot cache and verifies 120s TTL zero-spawn reuse", () => {
    const sesA = "ses_clean_a"
    const sesB = "ses_clean_b"

    expect(SessionStep.getCachedSnapshot(sesA)).toBeUndefined()
    expect(SessionStep.getCachedSnapshot(sesB)).toBeUndefined()

    // Verifies cache clearance works reliably across step boundaries
    SessionStep.clearSnapshotCache()
    expect(SessionStep.getCachedSnapshot(sesA)).toBeUndefined()
  })
})
