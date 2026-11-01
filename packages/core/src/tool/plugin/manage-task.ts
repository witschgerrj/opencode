export * as ManageTaskTool from "./manage-task.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Shell as ShellSchema } from "@opencode/schema/shell"
import { Effect, Predicate, Schema } from "effect"
import { Permission } from "../../permission.js"
import { NonNegativeInt, optional } from "../../schema.js"
import { Shell } from "../../shell.js"

export const name = "manage_task"

export const Action = Schema.Literals(["list", "status", "timeout", "kill"])
export type Action = typeof Action.Type

export const Input = Schema.Struct({
  action: Action.annotate({
    description:
      "Operation to perform: 'list' background tasks; 'status' inspects task state and recent output; 'timeout' updates duration before auto-kill; 'kill' terminates a task.",
  }).pipe(optional),
  shellID: Schema.String.annotate({
    description: "ID of the target background shell/task (e.g. 'sh_...'). Accepts aliases 'taskId' or 'id'.",
  }).pipe(optional),
  taskId: Schema.String.annotate({
    description: "Alias for shellID.",
  }).pipe(optional),
  id: Schema.String.annotate({
    description: "Alias for shellID.",
  }).pipe(optional),
  timeoutMs: NonNegativeInt.annotate({
    description: "Timeout in milliseconds for action 'timeout' (0 clears timeout).",
  }).pipe(optional),
  maxBytes: NonNegativeInt.annotate({
    description: "Maximum output bytes to read for action 'status' (defaults to 32KB).",
  }).pipe(optional),
  cursor: NonNegativeInt.annotate({
    description: "Byte cursor offset to page output for action 'status'.",
  }).pipe(optional),
})

export const TaskSummary = Schema.Struct({
  id: ShellSchema.ID,
  command: Schema.String,
  cwd: Schema.String,
  status: ShellSchema.Status,
  pid: NonNegativeInt.pipe(optional),
  startedAt: Schema.Number.pipe(optional),
})
export type TaskSummary = typeof TaskSummary.Type

export const TaskDetail = Schema.Struct({
  id: ShellSchema.ID,
  command: Schema.String,
  cwd: Schema.String,
  status: ShellSchema.Status,
  pid: NonNegativeInt.pipe(optional),
  exit: Schema.Finite.pipe(optional),
  signal: Schema.String.pipe(optional),
  startedAt: Schema.Number.pipe(optional),
  completedAt: Schema.Number.pipe(optional),
  output: Schema.String,
  cursor: NonNegativeInt,
  size: NonNegativeInt,
  truncated: Schema.Boolean,
})
export type TaskDetail = typeof TaskDetail.Type

export const Output = Schema.Struct({
  action: Action,
  tasks: Schema.Array(TaskSummary).pipe(optional),
  task: TaskDetail.pipe(optional),
  shellID: Schema.String.pipe(optional),
  timeoutMs: NonNegativeInt.pipe(optional),
})
export type Output = typeof Output.Type

export const description =
  "Inspect, monitor, adjust timeout, or terminate background shell processes and daemons. Use 'list' to discover running background tasks, 'status' to check output and completion state, 'timeout' to configure auto-kill duration, and 'kill' to stop a running background process."

export const Plugin = {
  id: "opencode.tool.manage_task",
  effect: Effect.fn("ManageTaskTool.Plugin")(function* (ctx: Context) {
    const shells = yield* Shell.Service
    const permissions = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const targetID = input.shellID ?? input.taskId ?? input.id
              const action: Action = input.action ?? (targetID ? "status" : "list")

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
                  resources: [targetID ?? action],
                })
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Permission denied for ${name}`, error }),
                  ),
                )

              if (action === "list") {
                const active = yield* shells.list()
                const summaries: TaskSummary[] = active.map((s) => ({
                  id: s.id,
                  command: s.command,
                  cwd: s.cwd,
                  status: s.status,
                  ...(s.pid !== undefined ? { pid: s.pid } : {}),
                  ...(s.time?.started !== undefined ? { startedAt: s.time.started } : {}),
                }))

                const lines = [
                  `Active Background Tasks (${summaries.length}):`,
                  ...(summaries.length === 0
                    ? ["- (no background tasks currently running)"]
                    : summaries.map(
                        (t) =>
                          `- ${t.id} [${t.status}] (pid=${t.pid ?? "unknown"}, cwd=${t.cwd}): ${t.command}`,
                      )),
                ]

                return {
                  content: lines.join("\n"),
                  output: {
                    action: "list" as const,
                    tasks: summaries,
                  },
                  metadata: { count: summaries.length },
                }
              }

              if (!targetID || targetID.trim().length === 0) {
                return yield* new ToolFailure({
                  message: `Action "${action}" requires a target shellID (or taskId/id). Call manage_task with action="list" to discover active tasks.`,
                })
              }
              const shellID = ShellSchema.ID.make(targetID.trim())

              if (action === "status") {
                const info = yield* shells.get(shellID).pipe(
                  Effect.catchTag("Shell.NotFoundError", () =>
                    Effect.fail(new ToolFailure({ message: `Background task not found: ${shellID}` })),
                  ),
                )

                const out = yield* shells
                  .output(shellID, {
                    cursor: input.cursor,
                    limit: input.maxBytes ?? 32_768,
                  })
                  .pipe(
                    Effect.catchTag("Shell.NotFoundError", () =>
                      Effect.fail(new ToolFailure({ message: `Background task not found: ${shellID}` })),
                    ),
                  )

                const detail: TaskDetail = {
                  id: info.id,
                  command: info.command,
                  cwd: info.cwd,
                  status: info.status,
                  ...(info.pid !== undefined ? { pid: info.pid } : {}),
                  ...(info.exit !== undefined ? { exit: info.exit } : {}),
                  ...(info.signal !== undefined ? { signal: info.signal } : {}),
                  ...(info.time?.started !== undefined ? { startedAt: info.time.started } : {}),
                  ...(info.time?.completed !== undefined ? { completedAt: info.time.completed } : {}),
                  output: out.output,
                  cursor: out.cursor,
                  size: out.size,
                  truncated: out.truncated,
                }

                const lines = [
                  `Task: ${detail.id}`,
                  `Status: ${detail.status}${detail.exit !== undefined ? ` (exit code: ${detail.exit})` : ""}${detail.signal ? ` (signal: ${detail.signal})` : ""}`,
                  `PID: ${detail.pid ?? "unknown"} | CWD: ${detail.cwd}`,
                  `Command: ${detail.command}`,
                  `Output (${out.output.length} bytes, cursor: ${out.cursor}/${out.size}${out.truncated ? ", truncated" : ""}):`,
                  "```",
                  out.output.length > 0 ? out.output : "(no output yet)",
                  "```",
                ]

                return {
                  content: lines.join("\n"),
                  output: {
                    action: "status" as const,
                    task: detail,
                  },
                  metadata: {
                    status: detail.status,
                    truncated: out.truncated,
                  },
                }
              }

              if (action === "timeout") {
                const timeoutMs = input.timeoutMs ?? 0
                yield* shells.timeout(shellID, timeoutMs).pipe(
                  Effect.catchTag("Shell.NotFoundError", () =>
                    Effect.fail(new ToolFailure({ message: `Background task not found: ${shellID}` })),
                  ),
                )

                const message =
                  timeoutMs === 0
                    ? `Cleared timeout for background task ${shellID}.`
                    : `Updated timeout for background task ${shellID} to ${timeoutMs}ms.`

                return {
                  content: message,
                  output: {
                    action: "timeout" as const,
                    shellID,
                    timeoutMs,
                  },
                  metadata: { shellID, timeoutMs },
                }
              }

              if (action === "kill") {
                yield* shells.remove(shellID).pipe(
                  Effect.catchTag("Shell.NotFoundError", () =>
                    Effect.fail(new ToolFailure({ message: `Background task not found: ${shellID}` })),
                  ),
                )

                const message = `Terminated background task ${shellID}.`
                return {
                  content: message,
                  output: {
                    action: "kill" as const,
                    shellID,
                  },
                  metadata: { shellID },
                }
              }

              return yield* new ToolFailure({ message: `Unsupported action: ${action}` })
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
        const id = pickString("shellID", "taskId", "task_id", "id")
        if (id !== undefined) {
          raw.shellID = id
        }
        delete raw.taskId
        delete raw.task_id
        delete raw.id
      }),
    )
  }),
}
