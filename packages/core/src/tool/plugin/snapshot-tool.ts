export * as SnapshotTool from "./snapshot-tool.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { ID as SnapshotID } from "@opencode/schema/snapshot"
import { Effect, Predicate, Schema } from "effect"
import { Permission } from "../../permission.js"
import { NonNegativeInt, RelativePath, optional } from "../../schema.js"
import { Snapshot } from "../../snapshot.js"

export const name = "snapshot"

export const Action = Schema.Literals(["capture", "files", "diff", "restore"])
export type Action = typeof Action.Type

export const Input = Schema.Struct({
  action: Action.annotate({
    description:
      "Operation to perform: 'capture' saves the current project tree state; 'files' lists changed paths between two snapshots (or between a snapshot and current state); 'diff' produces unified diffs; 'restore' reverts explicit files to a snapshot state.",
  }).pipe(optional),
  snapshotID: Schema.String.annotate({
    description: "Snapshot tree ID. Alias for 'from' or for restore target.",
  }).pipe(optional),
  from: Schema.String.annotate({
    description:
      "Starting snapshot tree ID for 'files' or 'diff' comparisons, or snapshot to restore from.",
  }).pipe(optional),
  to: Schema.String.annotate({
    description:
      "Ending snapshot tree ID for 'files' or 'diff' comparisons. If omitted, captures the current tree state automatically.",
  }).pipe(optional),
  paths: Schema.Array(Schema.String).annotate({
    description:
      "Target project-relative file paths to filter diffs or explicitly restore (e.g. ['src/index.ts']). Required for 'restore'.",
  }).pipe(optional),
  context: NonNegativeInt.annotate({
    description: "Lines of unchanged context around diff hunks (defaults to 3).",
  }).pipe(optional),
})

export const DiffSummary = Schema.Struct({
  file: Schema.String,
  status: Schema.Literals(["added", "deleted", "modified"]),
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  patch: Schema.String.pipe(optional),
})
export type DiffSummary = typeof DiffSummary.Type

export const Output = Schema.Struct({
  action: Action,
  snapshotID: Schema.String.pipe(optional),
  available: Schema.Boolean.pipe(optional),
  from: Schema.String.pipe(optional),
  to: Schema.String.pipe(optional),
  files: Schema.Array(Schema.String).pipe(optional),
  diffs: Schema.Array(DiffSummary).pipe(optional),
  restored: Schema.Array(Schema.String).pipe(optional),
})
export type Output = typeof Output.Type

export const description =
  "Capture, compare, diff, or restore project-relative filesystem snapshot trees. Use 'capture' to checkpoint current work before major changes, 'files' to see modified paths, 'diff' for per-file unified diffs, and 'restore' to revert specific files safely to a previous snapshot."

export const Plugin = {
  id: "opencode.tool.snapshot",
  effect: Effect.fn("SnapshotTool.Plugin")(function* (ctx: Context) {
    const snapshots = yield* Snapshot.Service
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
              const action: Action = input.action ?? "capture"

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
                  resources: [action],
                })
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Permission denied for ${name}`, error }),
                  ),
                )

              if (action === "capture") {
                const id = yield* snapshots.capture()
                if (id === undefined) {
                  return {
                    content:
                      "Snapshots are unavailable or disabled in this directory (e.g. outside a git repository or disabled by configuration).",
                    output: {
                      action: "capture" as const,
                      available: false,
                    },
                    metadata: { available: false },
                  }
                }
                return {
                  content: `Captured snapshot tree: ${id}`,
                  output: {
                    action: "capture" as const,
                    snapshotID: id,
                    available: true,
                  },
                  metadata: { snapshotID: id, available: true },
                }
              }

              if (action === "files") {
                const fromID = input.from ?? input.snapshotID
                if (!fromID || fromID.trim().length === 0) {
                  return yield* new ToolFailure({
                    message: "Action 'files' requires 'from' snapshot ID (or 'snapshotID').",
                  })
                }
                let toID = input.to
                if (!toID || toID.trim().length === 0) {
                  const current = yield* snapshots.capture()
                  if (!current) {
                    return yield* new ToolFailure({
                      message:
                        "Cannot compare against current state: snapshots are unavailable in this directory.",
                    })
                  }
                  toID = current
                }

                const from = SnapshotID.make(fromID.trim())
                const to = SnapshotID.make(toID.trim())

                const changed = yield* snapshots.files({ from, to }).pipe(
                  Effect.catchTag("Snapshot.Error", (err) =>
                    Effect.fail(
                      new ToolFailure({
                        message: `Failed to compare snapshot files: ${err.message}`,
                        error: err,
                      }),
                    ),
                  ),
                )

                const changedPaths = changed.map(String)
                const lines = [
                  `Changed Files (${changedPaths.length}) between snapshot ${from} and ${to}:`,
                  ...(changedPaths.length === 0
                    ? ["- (no changed files)"]
                    : changedPaths.map((f) => `- ${f}`)),
                ]

                return {
                  content: lines.join("\n"),
                  output: {
                    action: "files" as const,
                    from,
                    to,
                    files: changedPaths,
                  },
                  metadata: { count: changedPaths.length },
                }
              }

              if (action === "diff") {
                const fromID = input.from ?? input.snapshotID
                if (!fromID || fromID.trim().length === 0) {
                  return yield* new ToolFailure({
                    message: "Action 'diff' requires 'from' snapshot ID (or 'snapshotID').",
                  })
                }
                let toID = input.to
                if (!toID || toID.trim().length === 0) {
                  const current = yield* snapshots.capture()
                  if (!current) {
                    return yield* new ToolFailure({
                      message:
                        "Cannot diff against current state: snapshots are unavailable in this directory.",
                    })
                  }
                  toID = current
                }

                const from = SnapshotID.make(fromID.trim())
                const to = SnapshotID.make(toID.trim())
                const paths = input.paths?.map((p) => RelativePath.make(p.trim()))

                const rawDiffs = yield* snapshots
                  .diff({
                    from,
                    to,
                    context: input.context,
                    paths,
                  })
                  .pipe(
                    Effect.catchTag("Snapshot.Error", (err) =>
                      Effect.fail(
                        new ToolFailure({
                          message: `Failed to compute snapshot diff: ${err.message}`,
                          error: err,
                        }),
                      ),
                    ),
                  )

                const summaries: DiffSummary[] = rawDiffs.map((d) => ({
                  file: d.file,
                  status: d.status,
                  additions: d.additions,
                  deletions: d.deletions,
                  patch: d.patch,
                }))

                const totalAdds = summaries.reduce((acc, s) => acc + s.additions, 0)
                const totalDels = summaries.reduce((acc, s) => acc + s.deletions, 0)

                const lines = [
                  `Snapshot Diff (${summaries.length} files, +${totalAdds} -${totalDels}) from ${from} to ${to}:`,
                  "",
                  ...summaries.flatMap((s) => [
                    `--- ${s.file} [${s.status}] (+${s.additions} -${s.deletions})`,
                    s.patch ?? "",
                  ]),
                ]

                return {
                  content: lines.join("\n"),
                  output: {
                    action: "diff" as const,
                    from,
                    to,
                    diffs: summaries,
                  },
                  metadata: {
                    filesChanged: summaries.length,
                    additions: totalAdds,
                    deletions: totalDels,
                  },
                }
              }

              if (action === "restore") {
                const targetSnapshotID = input.snapshotID ?? input.from
                if (!targetSnapshotID || targetSnapshotID.trim().length === 0) {
                  return yield* new ToolFailure({
                    message: "Action 'restore' requires 'snapshotID' (or 'from').",
                  })
                }
                if (!input.paths || input.paths.length === 0) {
                  return yield* new ToolFailure({
                    message:
                      "Action 'restore' requires explicit non-empty 'paths' array to prevent accidental full-tree overwrites.",
                  })
                }

                const cleanedPaths = input.paths.map((p) => p.trim()).filter((p) => p.length > 0)
                if (cleanedPaths.length === 0) {
                  return yield* new ToolFailure({
                    message: "Action 'restore' requires at least one non-empty relative file path.",
                  })
                }

                yield* permissions
                  .assert({
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: {
                      type: "tool",
                      messageID: context.messageID,
                      id: context.id,
                    },
                    action: "edit",
                    resources: cleanedPaths,
                  })
                  .pipe(
                    Effect.mapError(
                      (error) =>
                        new ToolFailure({ message: "Permission denied to restore files", error }),
                    ),
                  )

                const snapshotID = SnapshotID.make(targetSnapshotID.trim())
                const fileMap = new Map<RelativePath, SnapshotID>()
                for (const p of cleanedPaths) {
                  fileMap.set(RelativePath.make(p), snapshotID)
                }

                yield* snapshots.restore({ files: fileMap }).pipe(
                  Effect.catchTag("Snapshot.Error", (err) =>
                    Effect.fail(
                      new ToolFailure({
                        message: `Failed to restore files from snapshot: ${err.message}`,
                        error: err,
                      }),
                    ),
                  ),
                )

                const message = `Restored ${cleanedPaths.length} file(s) from snapshot ${snapshotID}:\n${cleanedPaths.map((p) => `- ${p}`).join("\n")}`
                return {
                  content: message,
                  output: {
                    action: "restore" as const,
                    snapshotID,
                    restored: cleanedPaths,
                  },
                  metadata: { count: cleanedPaths.length },
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
        if (raw.id && typeof raw.id === "string" && !raw.snapshotID) {
          raw.snapshotID = raw.id.trim()
          delete raw.id
        }
      }),
    )
  }),
}
