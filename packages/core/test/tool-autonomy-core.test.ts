import { describe, expect, test } from "bun:test"
import fsp from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath, RelativePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { Permission } from "@opencode/core/permission"
import { Shell } from "@opencode/core/shell"
import { Shell as ShellSchema, ID as ShellID } from "@opencode/schema/shell"
import { Snapshot } from "@opencode/core/snapshot"
import { ID as SnapshotID } from "@opencode/schema/snapshot"
import { Tool } from "@opencode/core/tool"
import { ManageTaskTool } from "@opencode/core/tool/plugin/manage-task"
import { SnapshotTool } from "@opencode/core/tool/plugin/snapshot-tool"
import { MemoryTool } from "@opencode/core/tool/plugin/memory"
import { ScheduleTool } from "@opencode/core/tool/plugin/schedule"
import { ReadTool, parsePdfPages } from "@opencode/core/tool/plugin/read"
import { ReadToolFileSystem } from "@opencode/core/tool/read-filesystem"
import { FileAccess } from "@opencode/core/file-access"
import { Image } from "@opencode/core/image"
import { SessionInstructions } from "@opencode/core/session/instructions"
import { FSUtil } from "@opencode/util/fs-util"
import { MAX_SUBAGENT_DEPTH, bindChildSubagentModel } from "@opencode/core/tool/plugin/subagent"
import { ConfigAgentPlugin } from "@opencode/core/config/plugin/agent"
import { SessionSlotLease } from "@opencode/core/session/slot-lease"
import { OptimizePlugin, DeepSeekPlugin } from "@opencode/core/plugin/optimize"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { location } from "./fixture/location"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const sessionID = Session.ID.make("ses_autonomy_core_test")

const mockShells: ShellSchema.Info[] = []
let lastRestoredFiles: ReadonlyMap<RelativePath, Snapshot.ID> | undefined
const syntheticDeliveries: Array<{ sessionID: string; text: string; description?: string }> = []

const testShellNode = makeLocationNode({
  service: Shell.Service,
  layer: Layer.succeed(
    Shell.Service,
    Shell.Service.of({
      create: () => Effect.die("unimplemented"),
      list: () => Effect.succeed([...mockShells]),
      get: (id) => {
        const found = mockShells.find((s) => s.id === id)
        return found ? Effect.succeed(found) : Effect.fail(new Shell.NotFoundError({ id }))
      },
      wait: () => Effect.die("unimplemented"),
      result: () => Effect.die("unimplemented"),
      timeout: (id, _duration) => {
        const found = mockShells.find((s) => s.id === id)
        if (!found) return Effect.fail(new Shell.NotFoundError({ id }))
        return Effect.succeed(found)
      },
      output: (id, _input) => {
        const found = mockShells.find((s) => s.id === id)
        if (!found) return Effect.fail(new Shell.NotFoundError({ id }))
        return Effect.succeed({
          output: "Task stdout log: ready",
          cursor: 22,
          size: 22,
          truncated: false,
        })
      },
      remove: (id) => {
        const idx = mockShells.findIndex((s) => s.id === id)
        if (idx === -1) return Effect.fail(new Shell.NotFoundError({ id }))
        mockShells.splice(idx, 1)
        return Effect.void
      },
    }),
  ),
  deps: [],
})

const testSnapshotNode = makeLocationNode({
  service: Snapshot.Service,
  layer: Layer.succeed(
    Snapshot.Service,
    Snapshot.Service.of({
      capture: () => Effect.succeed(SnapshotID.make("sn_tree_cap_123")),
      files: () => Effect.succeed([RelativePath.make("src/index.ts"), RelativePath.make("package.json")]),
      diff: () =>
        Effect.succeed([
          {
            file: "src/index.ts",
            status: "modified",
            additions: 5,
            deletions: 1,
            patch: "@@ -1,1 +1,5 @@\n-old\n+new line 1\n+new line 2",
          },
        ]),
      restore: ({ files }) => {
        lastRestoredFiles = files
        return Effect.void
      },
      transform: () => Effect.succeed({ dispose: Effect.void }),
      reload: () => Effect.void,
    }),
  ),
  deps: [],
})

const activeSessionModel = {
  id: Model.ID.make("deepseek-v4.1-flash"),
  providerID: Provider.ID.make("deepseek"),
}

const testSessionNode = makeGlobalNode({
  service: Session.Service,
  layer: Layer.succeed(
    Session.Service,
    Session.Service.of({
      create: () => Effect.die("unimplemented"),
      get: (id: Session.ID) =>
        Effect.succeed({
          id,
          title: "Test Session",
          model: activeSessionModel,
          location: { directory: AbsolutePath.make("/tmp") } as any,
          time: { created: Date.now(), updated: Date.now() },
        } as any),
      list: () => Effect.succeed({ data: [], cursor: {} }),
      shell: () => Effect.die("unimplemented"),
      skill: () => Effect.die("unimplemented"),
      compact: () => Effect.die("unimplemented"),
      wait: () => Effect.void,
      active: Effect.succeed(new Set()),
      background: () => Effect.void,
      resume: () => Effect.void,
      interrupt: () => Effect.succeed(false),
      synthetic: (input: any) => {
        syntheticDeliveries.push(input)
        return Effect.succeed({ id: SessionMessage.ID.make("msg_synth") } as any)
      },
      revert: { stage: () => Effect.die("unimplemented"), clear: () => Effect.void, commit: () => Effect.void },
    } as any),
  ),
  deps: [],
})

const toolHook = () => Effect.succeed({ dispose: Effect.void })

const manageTaskToolNode = makeLocationNode({
  name: "test/manage-task-tool-node",
  layer: Layer.effectDiscard(registerToolPlugin(ManageTaskTool.Plugin, {}, toolHook)),
  deps: [Tool.node, Permission.node, Shell.node],
})

const snapshotToolNode = makeLocationNode({
  name: "test/snapshot-tool-node",
  layer: Layer.effectDiscard(registerToolPlugin(SnapshotTool.Plugin, {}, toolHook)),
  deps: [Tool.node, Permission.node, Snapshot.node],
})

const memoryToolNode = makeLocationNode({
  name: "test/memory-tool-node",
  layer: Layer.effectDiscard(registerToolPlugin(MemoryTool.Plugin, {}, toolHook)),
  deps: [Tool.node, Permission.node, Global.node],
})

const scheduleToolNode = makeLocationNode({
  name: "test/schedule-tool-node",
  layer: Layer.effectDiscard(registerToolPlugin(ScheduleTool.Plugin, {}, toolHook)),
  deps: [Tool.node, Permission.node, Session.node, Global.node],
})

const readToolNode = makeLocationNode({
  name: "test/read-tool-node",
  layer: Layer.effectDiscard(
    registerToolPlugin(
      ReadTool.Plugin,
      {
        model: {
          list: () =>
            Effect.succeed({
              data: [
                {
                  id: Model.ID.make("deepseek-v4.1-flash"),
                  providerID: Provider.ID.make("deepseek"),
                  name: "DeepSeek Flash",
                  variants: [],
                  capabilities: {
                    tools: true,
                    input: ["text", "image"],
                    output: ["text"],
                  },
                } as any,
              ],
              location: {} as any,
            } as any),
          default: () => Effect.die("unused"),
          transform: () => Effect.die("unused"),
          reload: () => Effect.die("unused"),
        },
      },
      toolHook,
    ),
  ),
  deps: [
    Tool.node,
    ReadToolFileSystem.node,
    FileAccess.node,
    Image.node,
    Permission.node,
    SessionInstructions.node,
    FSUtil.node,
    Location.node,
  ],
})

const permission = permissionLayer({
  assert: () => Effect.void,
  assertNotDenied: () => Effect.void,
})

const withAutonomyWorkspace = <A, E, R>(
  directory: string,
  body: (registry: Tool.Interface) => Effect.Effect<A, E, R>,
) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location(
        { directory: AbsolutePath.make(directory) },
        { projectDirectory: AbsolutePath.make(directory) },
      ),
    ),
  )

  const group = LayerNode.group([
    Tool.node,
    Permission.node,
    Location.node,
    Session.node,
    Shell.node,
    Snapshot.node,
    ReadToolFileSystem.node,
    FileAccess.node,
    Image.node,
    SessionInstructions.node,
    FSUtil.node,
    manageTaskToolNode,
    snapshotToolNode,
    memoryToolNode,
    scheduleToolNode,
    readToolNode,
  ])

  return Effect.gen(function* () {
    const registry = yield* Tool.Service
    return yield* body(registry)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(group, [
        Permission.node.replace(permission),
        Location.node.replace(activeLocation),
        Global.node.replace(tempGlobalLayer),
        Shell.node.replace(testShellNode),
        Snapshot.node.replace(testSnapshotNode),
        Session.node.replace(testSessionNode),
      ]),
    ),
  )
}

describe("Deliverable 1: ManageTaskTool", () => {
  test("lists active background tasks, inspects status, updates timeout, kills task, handles not found", async () => {
    const tmp = await tmpdir()
    mockShells.length = 0
    mockShells.push({
      id: ShellID.make("sh_worker_daemon"),
      status: "running",
      command: "bun run server.ts",
      cwd: tmp.path,
      shell: "/bin/bash",
      file: "/tmp/server.log",
      pid: 24680,
      metadata: {},
      time: { started: 1700000000000 },
    })

    await Effect.runPromise(
      withAutonomyWorkspace(tmp.path, (registry) =>
        Effect.gen(function* () {
          // 1. List
          const listRes = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_task_list",
              name: "manage_task",
              input: { action: "list" },
            },
          })
          expect(listRes.status).toBe("completed")
          expect(listRes.output.tasks).toHaveLength(1)
          expect(listRes.output.tasks[0].id).toBe("sh_worker_daemon")

          // 2. Status (using alias taskId)
          const statusRes = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_task_status",
              name: "manage_task",
              input: { action: "status", taskId: "sh_worker_daemon" },
            },
          })
          expect(statusRes.status).toBe("completed")
          expect(statusRes.output.task.id).toBe("sh_worker_daemon")
          expect(statusRes.output.task.output).toContain("Task stdout log: ready")

          // 3. Timeout
          const timeoutRes = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_task_timeout",
              name: "manage_task",
              input: { action: "timeout", shellID: "sh_worker_daemon", timeoutMs: 45000 },
            },
          })
          expect(timeoutRes.status).toBe("completed")
          expect(timeoutRes.output.timeoutMs).toBe(45000)

          // 4. Kill
          const killRes = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_task_kill",
              name: "manage_task",
              input: { action: "kill", shellID: "sh_worker_daemon" },
            },
          })
          expect(killRes.status).toBe("completed")
          expect(mockShells).toHaveLength(0)

          // 5. NotFoundError
          const notFoundRes = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_task_missing",
              name: "manage_task",
              input: { action: "status", shellID: "sh_missing" },
            },
          })
          expect(notFoundRes.status).toBe("error")
          expect(notFoundRes.error?.message).toContain("Background task not found: sh_missing")
        }),
      ),
    )
  })
})

describe("Deliverable 2: SnapshotTool", () => {
  test("captures snapshots, computes files and diffs, and restores paths", async () => {
    const tmp = await tmpdir()
    lastRestoredFiles = undefined

    await Effect.runPromise(
      withAutonomyWorkspace(tmp.path, (registry) =>
        Effect.gen(function* () {
          // 1. Capture
          const capRes = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_snap_cap",
              name: "snapshot",
              input: { action: "capture" },
            },
          })
          expect(capRes.status).toBe("completed")
          expect(capRes.output.snapshotID).toBe("sn_tree_cap_123")

          // 2. Files
          const filesRes = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_snap_files",
              name: "snapshot",
              input: { action: "files", from: "sn_tree_prev" },
            },
          })
          expect(filesRes.status).toBe("completed")
          expect(filesRes.output.files).toEqual(["src/index.ts", "package.json"])

          // 3. Diff
          const diffRes = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_snap_diff",
              name: "snapshot",
              input: { action: "diff", from: "sn_tree_prev" },
            },
          })
          expect(diffRes.status).toBe("completed")
          expect(diffRes.output.diffs[0].file).toBe("src/index.ts")
          expect(diffRes.output.diffs[0].additions).toBe(5)

          // 4. Restore requires non-empty paths
          const restoreEmpty = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_snap_restore_empty",
              name: "snapshot",
              input: { action: "restore", snapshotID: "sn_tree_prev", paths: [] },
            },
          })
          expect(restoreEmpty.status).toBe("error")
          expect(restoreEmpty.error?.message).toContain("requires explicit non-empty 'paths'")

          // 5. Restore with paths
          const restoreOk = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_snap_restore_ok",
              name: "snapshot",
              input: { action: "restore", snapshotID: "sn_tree_prev", paths: ["src/index.ts"] },
            },
          })
          expect(restoreOk.status).toBe("completed")
          expect(lastRestoredFiles?.get(RelativePath.make("src/index.ts"))).toBe(SnapshotID.make("sn_tree_prev"))
        }),
      ),
    )
  })
})

describe("Deliverable 3: MemoryTool", () => {
  test("upsert, read, BM25 search, list, delete, and 16KB content limit enforcement", async () => {
    const tmp = await tmpdir()

    await Effect.runPromise(
      withAutonomyWorkspace(tmp.path, (registry) =>
        Effect.gen(function* () {
          // 1. Upsert workspace memory
          const upWs = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_mem_ws",
              name: "memory",
              input: {
                action: "upsert",
                title: "PostgreSQL Database Schema",
                content: "All table migrations live under packages/core/src/database/migration. Run drizzle migrations with bun migrate.",
                tags: ["database", "postgresql", "schema"],
                scope: "workspace",
              },
            },
          })
          expect(upWs.status).toBe("completed")
          expect(upWs.output.key).toBe("postgresql-database-schema")

          // 2. Upsert global memory
          const upGlobal = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_mem_global",
              name: "memory",
              input: {
                action: "upsert",
                key: "corp-cloud-security",
                title: "Corporate Cloud Security Policies",
                content: "All cloud API keys must be stored in HashiCorp Vault. Production endpoints require TLS 1.3.",
                tags: ["security", "cloud", "vault"],
                scope: "global",
              },
            },
          })
          expect(upGlobal.status).toBe("completed")

          // 3. Read
          const readWs = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_mem_read",
              name: "memory",
              input: { action: "read", key: "postgresql-database-schema" },
            },
          })
          expect(readWs.status).toBe("completed")
          expect(readWs.output.entry.content).toContain("drizzle migrations")

          // 4. BM25 search across scopes
          const searchRes = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_mem_search",
              name: "memory",
              input: { action: "search", query: "database schema migration" },
            },
          })
          expect(searchRes.status).toBe("completed")
          expect(searchRes.output.entries.length).toBeGreaterThanOrEqual(1)
          expect(searchRes.output.entries[0].key).toBe("postgresql-database-schema")

          // 5. List
          const listRes = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_mem_list",
              name: "memory",
              input: { action: "list", scope: "all" },
            },
          })
          expect(listRes.status).toBe("completed")
          expect(listRes.output.entries.length).toBeGreaterThanOrEqual(2)

          // 6. Delete
          const delRes = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_mem_del",
              name: "memory",
              input: { action: "delete", key: "postgresql-database-schema" },
            },
          })
          expect(delRes.status).toBe("completed")

          // 7. Verify deleted
          const readAfterDel = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_mem_read_del",
              name: "memory",
              input: { action: "read", key: "postgresql-database-schema" },
            },
          })
          expect(readAfterDel.status).toBe("error")
          expect(readAfterDel.error?.message).toContain("not found")

          // 8. Reject content > 16KB
          const oversizeRes = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_mem_oversize",
              name: "memory",
              input: { action: "upsert", key: "too-large", content: "X".repeat(17 * 1024) },
            },
          })
          expect(oversizeRes.status).toBe("error")
          expect(oversizeRes.error?.message).toContain("exceeds maximum size of 16KB")
        }),
      ),
    )
  })
})

describe("Deliverable 4: ScheduleTool", () => {
  test("creates timers and crons, lists active schedules, fires wakeup, and cancels", async () => {
    const tmp = await tmpdir()
    syntheticDeliveries.length = 0

    await Effect.runPromise(
      withAutonomyWorkspace(tmp.path, (registry) =>
        Effect.gen(function* () {
          // 1. Create timer
          const timerRes = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_sch_tm",
              name: "schedule",
              input: {
                action: "create_timer",
                delaySeconds: 1,
                prompt: "Autonomous check: verify background unit tests completed.",
                summary: "Check background tests",
              },
            },
          })
          expect(timerRes.status).toBe("completed")
          const timerID = timerRes.output.schedule.id
          expect(timerID).toMatch(/^sch_tm_/)

          // 2. Create recurring cron
          const cronRes = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_sch_cr",
              name: "schedule",
              input: {
                action: "create_cron",
                intervalSeconds: 30,
                prompt: "Recurring check: monitor active queue depth.",
                summary: "Queue depth monitor",
                maxIterations: 5,
              },
            },
          })
          expect(cronRes.status).toBe("completed")
          const cronID = cronRes.output.schedule.id
          expect(cronID).toMatch(/^sch_cr_/)

          // 3. List
          const listRes = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_sch_list",
              name: "schedule",
              input: { action: "list" },
            },
          })
          expect(listRes.status).toBe("completed")
          expect(listRes.output.schedules.length).toBeGreaterThanOrEqual(2)

          // 4. Cancel recurring cron
          const cancelRes = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_sch_cancel",
              name: "schedule",
              input: { action: "cancel", scheduleID: cronID },
            },
          })
          expect(cancelRes.status).toBe("completed")
          expect(cancelRes.output.schedule.status).toBe("cancelled")

          // 5. Verify timer triggered synthetic message
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1100)))
          const delivered = syntheticDeliveries.find(
            (d) => d.text.includes("<scheduled-wakeup") && d.text.includes("verify background unit tests"),
          )
          expect(delivered).toBeDefined()
        }),
      ),
    )
  })
})

describe("Deliverable 5: ReadTool PDF-to-Vision & Text Bridge", () => {
  test("parsePdfPages parses ranges correctly", () => {
    expect(parsePdfPages("1-4")).toEqual({ first: 1, last: 4 })
    expect(parsePdfPages("2-10")).toEqual({ first: 2, last: 10 })
    expect(parsePdfPages("3,6")).toEqual({ first: 3, last: 6 })
    expect(parsePdfPages("7")).toEqual({ first: 7, last: 7 })
    expect(parsePdfPages(undefined)).toEqual({ first: 1, last: 4 })
  })

  test("ReadTool Input schema includes optional pages field", () => {
    expect(ReadTool.Input.fields.pages).toBeDefined()
  })

  test("ReadTool extracts text and rendered image vision for DeepSeek model without native PDF", async () => {
    const tmp = await tmpdir()
    const pdfPath = path.join(tmp.path, "document.pdf")
    const pdfBytes = Buffer.from(
      `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 44 >> stream
BT /F1 24 Tf 100 700 Td (Hello DeepSeek Vision) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000244 00000 n 
0000000338 00000 n 
trailer << /Size 6 /Root 1 0 R >>
startxref
417
%%EOF
`,
      "utf-8",
    )
    await fsp.writeFile(pdfPath, pdfBytes)

    await Effect.runPromise(
      withAutonomyWorkspace(tmp.path, (registry) =>
        Effect.gen(function* () {
          const res = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call_read_pdf_bridge",
              name: "read",
              input: { path: "document.pdf", pages: "1-1" },
            },
          })

          expect(res.status).toBe("completed")
          const contents = res.content as Array<{ type: string; text?: string; mime?: string; uri?: string }>
          expect(contents.length).toBeGreaterThanOrEqual(1)

          // 1. Text extraction check
          const textItem = contents.find((c) => c.type === "text")
          expect(textItem?.text).toContain("PDF text preview")
          expect(textItem?.text).toContain("Hello DeepSeek Vision")

          // 2. Vision render check
          const imageItem = contents.find((c) => c.type === "file")
          expect(imageItem?.mime).toBe("image/png")
          expect(imageItem?.uri).toMatch(/^data:image\/png;base64,/)
        }),
      ),
    )
  })
})

describe("Deliverable 6: SubagentTool Bounded Depth", () => {
  test("exports MAX_SUBAGENT_DEPTH as 3", () => {
    expect(MAX_SUBAGENT_DEPTH).toBe(3)
  })
})

describe("Deliverable 7: DeepSeek Autonomous Prompt Optimizer", () => {
  test("OptimizePlugin.Plugins contains DeepSeekPlugin with autonomous instructions", () => {
    expect(OptimizePlugin.Plugins.some((p) => p.id === "opencode.prompt.deepseek")).toBe(true)
    expect(DeepSeekPlugin.id).toBe("opencode.prompt.deepseek")
  })
})

describe("Deliverable 8: Portable Agent Frontmatter & ID Normalization", () => {
  test("normalizes nested <dir>/agent.md to directory name and translates tools array", () => {
    const yaml = `---
name: master-animator
description: Master animator agent
model: anthropic/claude-3-7-sonnet
tools:
  - run_command
  - view_file
  - write_file
  - edit_file
inheritCustomizations: true
inheritMcp: false
---
You are the master animator.`

    const doc = Effect.runSync(
      ConfigAgentPlugin.decode(
        {
          directory: "/home/rjwits/.agents/agents",
          filepath: "/home/rjwits/.agents/agents/master-animator/agent.md",
          primary: false,
        },
        yaml,
      ),
    )

    expect(doc).toBeDefined()
    expect(Object.keys(doc!.info.agents ?? {})).toEqual(["master-animator"])
    const agent = doc!.info.agents!["master-animator"]
    expect(agent.description).toBe("Master animator agent")
    expect(agent.permissions).toBeDefined()

    const actions = (agent.permissions ?? []).map((r) => `${r.action}:${r.effect}`)
    expect(actions).toContain("shell:allow")
    expect(actions).toContain("read:allow")
    expect(actions).toContain("write:allow")
    expect(actions).toContain("edit:allow")
    expect(actions).toContain("patch:allow")
    expect(actions).toContain("skill:allow")
    expect(actions).toContain("lsp:allow")
    expect(actions).toContain("memory:allow")
    expect(actions).toContain("headless_browser:allow")
    expect(actions).toContain("render_artifact:allow")
  })

  test("explicitly denies mutating tools when omitted in read-only agents", () => {
    const yaml = `---
description: Read-only reviewer
tools:
  - view_file
  - search_web
---
Inspect code without mutations.`

    const doc = Effect.runSync(
      ConfigAgentPlugin.decode(
        {
          directory: "/workspace/.agents/agents",
          filepath: "/workspace/.agents/agents/reviewer/AGENT.MD",
          primary: false,
        },
        yaml,
      ),
    )

    expect(doc).toBeDefined()
    expect(Object.keys(doc!.info.agents ?? {})).toEqual(["reviewer"])
    const agent = doc!.info.agents!["reviewer"]
    const actions = (agent.permissions ?? []).map((r) => `${r.action}:${r.effect}`)

    expect(actions).toContain("read:allow")
    expect(actions).toContain("websearch:allow")
    expect(actions).toContain("shell:deny")
    expect(actions).toContain("write:deny")
    expect(actions).toContain("edit:deny")
    expect(actions).toContain("patch:deny")
  })
})

describe("Deliverable 9: Subagent DeepSeek Optimizations & Slot Lease Yielding", () => {
  test("bindChildSubagentModel upgrades plain deepseek-local to #subagent-high", () => {
    const catalog = [
      {
        providerID: Provider.ID.make("deepseek-local"),
        id: Model.ID.make("deepseek-chat"),
        name: "DeepSeek Chat",
        variants: [
          { id: Model.VariantID.make("subagent-high") },
          { id: Model.VariantID.make("high") },
          { id: Model.VariantID.make("max") },
        ],
      } as any,
    ]

    const plain = Model.Ref.make({
      providerID: Provider.ID.make("deepseek-local"),
      id: Model.ID.make("deepseek-chat"),
    })

    const upgraded = bindChildSubagentModel(plain, catalog)
    expect(upgraded).toBeDefined()
    expect(String(upgraded!.providerID)).toBe("deepseek-local")
    expect(String(upgraded!.variant)).toBe("subagent-high")
  })

  test("SessionSlotLease yields slot during synchronous wait and re-acquires", () => {
    SessionSlotLease.reset()
    const parentSession = "ses_test_parent"
    const childSession = "ses_test_child"

    const parentSlot = SessionSlotLease.acquire(parentSession, false)
    expect(parentSlot).toBe(0)
    expect(SessionSlotLease.activeCount(0)).toBe(1)

    // Yield slot before jobs.block
    SessionSlotLease.release(parentSession)
    expect(SessionSlotLease.activeCount(0)).toBe(0)

    // Child acquires its subagent slot
    const childSlot = SessionSlotLease.acquire(childSession, true)
    expect(childSlot).toBe(1)
    expect(SessionSlotLease.activeCount(1)).toBe(1)

    // Child finishes
    SessionSlotLease.release(childSession)
    expect(SessionSlotLease.activeCount(1)).toBe(0)

    // Parent re-acquires its sticky slot
    const reacquired = SessionSlotLease.acquire(parentSession, false)
    expect(reacquired).toBe(0)
    expect(SessionSlotLease.activeCount(0)).toBe(1)
    SessionSlotLease.release(parentSession)
  })
})
