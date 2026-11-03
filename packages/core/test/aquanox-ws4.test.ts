import { beforeEach, describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import path from "path"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Environment } from "@opencode/core/environment/index"
import { FileMutation } from "@opencode/core/file-mutation"
import { Formatter } from "@opencode/core/formatter"
import { Location } from "@opencode/core/location"
import { FileAccess } from "@opencode/core/file-access"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { Tool } from "@opencode/core/tool"
import { EditTool } from "@opencode/core/tool/plugin/edit"
import { GrepTool } from "@opencode/core/tool/plugin/grep"
import { sessionReadDedupCache, toModelContent as readToModelContent } from "@opencode/core/tool/plugin/read"
import { transformEnvironmentFiles } from "./fixture/environment"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const created = DateTime.makeUnsafe(1_700_000_000_000)

const makeUserMessage = (text: string): SessionMessage.Info => ({
  id: SessionMessage.ID.create(),
  type: "user",
  text,
  time: { created },
})

const makeCompactionMessage = (): SessionMessage.Info =>
  ({
    id: SessionMessage.ID.create(),
    type: "compaction",
    reason: "auto",
    summary: "Checkpoint summary",
    status: "completed",
    time: { created },
  }) as unknown as SessionMessage.Info

const makeAssistantTool = (
  name: string,
  rawState:
    | { status: "completed"; content: ReadonlyArray<{ type: "text"; text: string }> }
    | { status: "error"; error: { type: string; message: string } }
    | SessionMessage.AssistantTool["state"],
): SessionMessage.AssistantTool => {
  const state =
    rawState.status === "completed" && !("input" in rawState)
      ? ({
          status: "completed",
          input: {},
          metadata: {},
          content: rawState.content,
        } as unknown as SessionMessage.AssistantTool["state"])
      : rawState.status === "error" && !("input" in rawState)
        ? ({
            status: "error",
            input: {},
            error: rawState.error,
          } as unknown as SessionMessage.AssistantTool["state"])
        : (rawState as SessionMessage.AssistantTool["state"])
  return {
    type: "tool",
    id: "call_" + Math.random().toString(36).slice(2),
    name,
    state,
    time: { created },
  }
}

const makeAssistantMessage = (tools: SessionMessage.AssistantTool[]): SessionMessage.Info =>
  ({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: "general",
    content: tools,
    model: { providerID: "deepseek-local", id: "deepseek-v4.1-flash", variant: "max" },
    time: { created },
  }) as unknown as SessionMessage.Info

describe("Workstream 4 — Causal reasoning_budget_tokens Scheduler (llm.ts)", () => {
  test("Tier 1: Turn Entry & Error Recovery Tier (1024..2048 tokens)", () => {
    // User message entry on variant max -> 2048
    const budgetMax = SessionRunnerLLM.computeCausalReasoningBudget({
      messages: [makeUserMessage("Plan the architecture")],
      variant: "max",
      isSubagent: false,
      isExplore: false,
      isSynthesizing: false,
      stepLimitReached: false,
    })
    expect(budgetMax).toBe(2048)

    // User message entry on variant high -> 2048
    const budgetHigh = SessionRunnerLLM.computeCausalReasoningBudget({
      messages: [makeUserMessage("Plan the architecture")],
      variant: "high",
      isSubagent: false,
      isExplore: false,
      isSynthesizing: false,
      stepLimitReached: false,
    })
    expect(budgetHigh).toBe(2048)

    // Subagent wakeup/inbox turn entry -> 2048
    const budgetSubagent = SessionRunnerLLM.computeCausalReasoningBudget({
      messages: [makeUserMessage("Subagent task starting")],
      variant: "high",
      isSubagent: true,
      isExplore: false,
      isSynthesizing: false,
      stepLimitReached: false,
    })
    expect(budgetSubagent).toBe(2048)

    // First step after compaction -> 2048
    const budgetAfterCompact = SessionRunnerLLM.computeCausalReasoningBudget({
      messages: [makeCompactionMessage()],
      variant: "high",
      isSubagent: false,
      isExplore: false,
      isSynthesizing: false,
      stepLimitReached: false,
    })
    expect(budgetAfterCompact).toBe(2048)
  })

  test("Tier 2: Genuine Error Diagnosis vs Exploratory & Fan-In Continuations", () => {
    // 1. Tool execution error -> 2048
    const errTool = makeAssistantTool("shell", {
      status: "error",
      error: { type: "tool.execution", message: "Command failed" },
    })
    const budgetError = SessionRunnerLLM.computeCausalReasoningBudget({
      messages: [makeUserMessage("Run tests"), makeAssistantMessage([errTool])],
      variant: "max",
      isSubagent: false,
      isExplore: false,
      isSynthesizing: false,
      stepLimitReached: false,
    })
    expect(budgetError).toBe(2048)

    // 2. Failure diagnostic regex patterns on shell output without exit=0 -> 2048
    for (const failureText of [
      "not ok 1 - test failed",
      "TEST SUITE FAILED",
      "npm ERR_TEST_FAILURE",
      "AssertionError: expected true to be false",
      "SyntaxError: Unexpected token",
      "TypeError: cannot read property of undefined",
      "ReferenceError: x is not defined",
      "error TS2345: Argument of type",
      "Process exited with exit code 1",
      "Traceback (most recent call last):",
    ]) {
      const diagTool = makeAssistantTool("shell", {
        status: "completed",
        content: [{ type: "text", text: failureText }],
      })
      const budgetDiag = SessionRunnerLLM.computeCausalReasoningBudget({
        messages: [makeUserMessage("Run tests"), makeAssistantMessage([diagTool])],
        variant: "max",
        isSubagent: false,
        isExplore: false,
        isSynthesizing: false,
        stepLimitReached: false,
      })
      expect(budgetDiag).toBe(2048)
    }

    // 2b. False-positive immunity: read, grep, skill, and exit=0 shell NEVER trigger hasErrorOrDiagnostic!
    const readWithErrorText = makeAssistantTool("read", {
      status: "completed",
      content: [{ type: "text", text: "throw new TypeError(\"AssertionError FAIL not ok error TS2345\")" }],
    })
    expect(SessionRunnerLLM.analyzeCausalStep([makeUserMessage("Read file"), makeAssistantMessage([readWithErrorText])]).hasErrorOrDiagnostic).toBe(false)

    const shellExitZeroWithErrorText = makeAssistantTool("shell", {
      status: "completed",
      input: { command: "npm test" },
      metadata: { exit: 0, truncated: false },
      content: [{ type: "text", text: "ok 1 - handles AssertionError and TypeError without FAIL" }],
    } as any)
    expect(SessionRunnerLLM.analyzeCausalStep([makeUserMessage("Run tests"), makeAssistantMessage([shellExitZeroWithErrorText])]).hasErrorOrDiagnostic).toBe(false)

    // 3. Multi-tool fan-in (>= 3 clean exploratory tool calls) -> compact 512 tokens (no 8192 escalation)
    const t1 = makeAssistantTool("read", { status: "completed", content: [{ type: "text", text: "ok 1" }] })
    const t2 = makeAssistantTool("read", { status: "completed", content: [{ type: "text", text: "ok 2" }] })
    const t3 = makeAssistantTool("read", { status: "completed", content: [{ type: "text", text: "ok 3" }] })
    const budgetFanIn = SessionRunnerLLM.computeCausalReasoningBudget({
      messages: [makeUserMessage("Read 3 files"), makeAssistantMessage([t1, t2, t3])],
      variant: "max",
      isSubagent: false,
      isExplore: false,
      isSynthesizing: false,
      stepLimitReached: false,
    })
    expect(budgetFanIn).toBe(512)

    // 4. Cumulative exploratory steps >= 2 without error -> compact 512 tokens (no 8192 escalation)
    const readStep1 = makeAssistantMessage([
      makeAssistantTool("read", { status: "completed", content: [{ type: "text", text: "content 1" }] }),
    ])
    const readStep2 = makeAssistantMessage([
      makeAssistantTool("grep", { status: "completed", content: [{ type: "text", text: "content 2" }] }),
    ])
    const budgetExploratorySynthesis = SessionRunnerLLM.computeCausalReasoningBudget({
      messages: [makeUserMessage("Investigate codebase"), readStep1, readStep2],
      variant: "max",
      isSubagent: false,
      isExplore: false,
      isSynthesizing: false,
      stepLimitReached: false,
    })
    expect(budgetExploratorySynthesis).toBe(512)
  })

  test("Tier 3: Clean Verification / Incremental Edit Continuation Tier (1024 tokens)", () => {
    // 1 clean mutating edit tool
    const cleanEdit = makeAssistantTool("edit", {
      status: "completed",
      content: [{ type: "text", text: "Edited file.ts (1 replacement)" }],
    })
    const budgetEdit = SessionRunnerLLM.computeCausalReasoningBudget({
      messages: [makeUserMessage("Fix bug"), makeAssistantMessage([cleanEdit])],
      variant: "max",
      isSubagent: false,
      isExplore: false,
      isSynthesizing: false,
      stepLimitReached: false,
    })
    expect(budgetEdit).toBe(1024)

    // 2 clean mutating shell/write tools
    const cleanWrite = makeAssistantTool("write", { status: "completed", content: [{ type: "text", text: "ok" }] })
    const cleanShell = makeAssistantTool("shell", { status: "completed", content: [{ type: "text", text: "clean output" }] })
    const budgetMutating2 = SessionRunnerLLM.computeCausalReasoningBudget({
      messages: [makeUserMessage("Apply changes"), makeAssistantMessage([cleanWrite, cleanShell])],
      variant: "max",
      isSubagent: false,
      isExplore: false,
      isSynthesizing: false,
      stepLimitReached: false,
    })
    expect(budgetMutating2).toBe(1024)
  })

  test("Tier 4: Single-File Exploratory Continuation Tier (256 tokens)", () => {
    // 1 clean read step
    const cleanRead = makeAssistantTool("read", {
      status: "completed",
      content: [{ type: "text", text: "Read file main.ts, lines 1-20\nconst x = 1;" }],
    })
    const budgetSingleRead = SessionRunnerLLM.computeCausalReasoningBudget({
      messages: [makeUserMessage("Inspect main.ts"), makeAssistantMessage([cleanRead])],
      variant: "max",
      isSubagent: false,
      isExplore: false,
      isSynthesizing: false,
      stepLimitReached: false,
    })
    expect(budgetSingleRead).toBe(256)
  })
})

describe("Workstream 4 — Compaction Ceiling & Precompute Guard (compaction.ts)", () => {
  test("deepseek-local ceiling clamps to >= 0.85 * contextLimit (~334K)", () => {
    const contextLimit = 393_216
    const buffer = 65_536

    // deepseek-local: even with buffer 65536, ceiling is clamped to Math.floor(0.85 * 393216) = 334233
    const localCeiling = SessionCompaction.calculateCeiling(
      { context: contextLimit, output: 32768 },
      buffer,
      "deepseek-local",
    )
    expect(localCeiling).toBe(Math.floor(0.85 * contextLimit))
    expect(localCeiling).toBeGreaterThanOrEqual(334_000)

    // Other providers: ceiling is window - buffer = 393216 - 65536 = 327680
    const otherCeiling = SessionCompaction.calculateCeiling(
      { context: contextLimit, output: 32768 },
      buffer,
      "anthropic",
    )
    expect(otherCeiling).toBe(contextLimit - buffer)
    expect(otherCeiling).toBe(327_680)
  })
})

describe("Workstream 4 — Verbatim-Safe read.ts Hygiene (read.ts)", () => {
  beforeEach(() => {
    sessionReadDedupCache.clear()
  })

  test("Rule B: Deduplicates identical >4KB and >80-line slice within session", () => {
    const testLines = Array.from({ length: 90 }, (_, i) => `line ${i + 1}: ${"x".repeat(50)}`)
    const largeContent = testLines.join("\n")
    expect(largeContent.length).toBeGreaterThan(4096)
    expect(testLines.length).toBeGreaterThan(80)

    const sessionID = "ses_dedup_test_1"
    const filePath = "/workspace/large-file.ts"
    const fileOutput = {
      type: "file" as const,
      name: "large-file.ts",
      uri: "file:///workspace/large-file.ts",
      content: largeContent,
      encoding: "utf8" as const,
      mime: "text/plain",
    }

    // First read: returns full verbatim text
    const firstRead = readToModelContent(filePath, undefined, fileOutput, {
      sessionID,
      resolvedPath: filePath,
    })
    expect(typeof firstRead).toBe("string")
    expect(firstRead).toContain("Read file /workspace/large-file.ts, lines 1-90")
    expect(firstRead).toContain("line 1:")

    // Second identical read in same session: returns concise pointer
    const secondRead = readToModelContent(filePath, undefined, fileOutput, {
      sessionID,
      resolvedPath: filePath,
    })
    expect(typeof secondRead).toBe("string")
    expect(secondRead).toContain("Unchanged since earlier read in this session (sha256:")
    expect(secondRead).toContain("90 lines")

    // Third read with force: true bypasses dedup cache
    const forcedRead = readToModelContent(filePath, undefined, fileOutput, {
      sessionID,
      resolvedPath: filePath,
      force: true,
    })
    expect(forcedRead).toContain("line 1:")
    expect(forcedRead).not.toContain("Unchanged since earlier read")
  })

  test("Rule C: Large unbounded code file (>350 lines) returns 200-line head + symbol directory", () => {
    const lines: string[] = []
    for (let i = 1; i <= 400; i++) {
      if (i === 220) {
        lines.push("export function computeMetrics(input: number): number {")
      } else if (i === 280) {
        lines.push("export class SessionPoolManager {")
      } else if (i === 350) {
        lines.push("export interface SlotConfig {")
      } else {
        lines.push(`const v_${i} = ${i};`)
      }
    }
    const codeContent = lines.join("\n")
    const codeOutput = {
      type: "file" as const,
      name: "engine.ts",
      uri: "file:///workspace/engine.ts",
      content: codeContent,
      encoding: "utf8" as const,
      mime: "text/typescript",
    }

    // Unbounded read (limit undefined, offset undefined)
    const result = readToModelContent("engine.ts", undefined, codeOutput, {})
    expect(typeof result).toBe("string")
    expect(result).toContain("Read file engine.ts, lines 1-200 of 400")
    expect(result).toContain("Showing lines 1-200 of 400 lines")
    expect(result).toContain("Symbol Directory (lines 201-400):")
    expect(result).toContain("L220: export function computeMetrics")
    expect(result).toContain("L280: export class SessionPoolManager")
    expect(result).toContain("L350: export interface SlotConfig")
    expect(result).toContain("[Use offset and limit to view specific line ranges.]")
  })
})

describe("Workstream 4 — grep.ts Multi-Query & File Grouping (grep.ts)", () => {
  test("toModelContent switches to compact ## <relativePath> grouping when formatted output exceeds 6,144 bytes", () => {
    // Generate matches whose standard format exceeds 6,144 bytes
    const matches: any[] = []
    for (let i = 1; i <= 60; i++) {
      matches.push({
        entry: { path: "/long/path/to/project/packages/core/src/subsystem/module.ts" },
        line: i * 10,
        text: `export const constant_${i} = "${"x".repeat(120)}";`,
      })
    }

    const output = GrepTool.toModelContent(matches, false, "/long/path/to/project")
    expect(Buffer.byteLength(output, "utf8")).toBeGreaterThan(6144)
    expect(output).toContain("## packages/core/src/subsystem/module.ts")
    expect(output).toContain("  L10: export const constant_1")
    expect(output).toContain("  L20: export const constant_2")
  })
})

const editToolNode = makeLocationNode({
  name: "test/ws4-edit-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(EditTool.Plugin)),
  deps: [
    Tool.node,
    FileAccess.node,
    FileMutation.node,
    Environment.node,
    Formatter.node,
    Location.node,
    Permission.node,
  ],
})

const makeEditFixture = () => {
  const fixture = {
    assertions: [] as Permission.AssertInput[],
    writes: [] as string[],
    formatFile: () => Effect.succeed(false),
  }

  const permission = permissionLayer({
    assert: (input) => Effect.sync(() => fixture.assertions.push(input)),
  })

  const formatter = Layer.mock(Formatter.Service, {
    file: (target) => fixture.formatFile(),
  })

  return Object.assign(fixture, { permission, formatter })
}

const withTool = <A, E, R>(
  directory: string,
  fixture: ReturnType<typeof makeEditFixture>,
  body: (registry: Tool.Interface) => Effect.Effect<A, E, R>,
) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    const registry = yield* Tool.Service
    return yield* body(registry)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([Tool.node, FileAccess.node, FileMutation.node, editToolNode]), [
        Environment.node.replace(transformEnvironmentFiles((files) => files)),
        Location.node.replace(activeLocation),
        Permission.node.replace(fixture.permission),
        Formatter.node.replace(fixture.formatter),
      ]),
    ),
  )
}

describe("Workstream 4 — edit.ts Transactional Multi-Hunk edits[] Support (edit.ts)", () => {
  test("applies multiple sequential hunks in a single transactional write", async () => {
    const tmp = await tmpdir()
    const filePath = path.join(tmp.path, "code.ts")
    await Bun.write(filePath, "const a = 1;\nconst b = 2;\nconst c = 3;\n")

    const fixture = makeEditFixture()
    const program = withTool(tmp.path, fixture, (registry) =>
      Effect.gen(function* () {
        const result = yield* executeTool(registry, {
          sessionID: Session.ID.make("ses_ws4_edit"),
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-edit-multi",
            name: "edit",
            input: {
              path: "code.ts",
              edits: [
                { oldString: "const a = 1;", newString: "const a = 10;" },
                { oldString: "const c = 3;", newString: "const c = 30;" },
              ],
            },
          },
        })
        expect(result).toMatchObject({
          status: "completed",
          output: { replacements: 2 },
        })
      }),
    )

    await Effect.runPromise(program)
    const contentOnDisk = await Bun.file(filePath).text()
    expect(contentOnDisk).toBe("const a = 10;\nconst b = 2;\nconst c = 30;\n")
  })

  test("transactionally rejects and leaves disk unmodified if any hunk fails to match", async () => {
    const tmp = await tmpdir()
    const filePath = path.join(tmp.path, "code.ts")
    const initialContent = "const a = 1;\nconst b = 2;\nconst c = 3;\n"
    await Bun.write(filePath, initialContent)

    const fixture = makeEditFixture()
    const program = withTool(tmp.path, fixture, (registry) =>
      Effect.gen(function* () {
        const result = yield* executeTool(registry, {
          sessionID: Session.ID.make("ses_ws4_edit_fail"),
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-edit-multi-fail",
            name: "edit",
            input: {
              path: "code.ts",
              edits: [
                { oldString: "const a = 1;", newString: "const a = 10;" },
                { oldString: "const NONEXISTENT = 999;", newString: "const c = 30;" },
              ],
            },
          },
        })
        expect(result.status).toBe("error")
      }),
    )

    await Effect.runPromise(program)
    const contentOnDisk = await Bun.file(filePath).text()
    // First edit was NOT committed to disk!
    expect(contentOnDisk).toBe(initialContent)
  })
})
