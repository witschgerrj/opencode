export * as GodotSandboxTool from "./godot-sandbox.js"

import fs from "node:fs"
import path from "node:path"
import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Permission } from "../../permission.js"
import { SessionSlotLease } from "../../session/slot-lease.js"
import { GpuBrokerClient } from "../../util/gpu-broker-client.js"

export const name = "godot_sandbox"

export const VALID_GODOT_ACTIONS = [
  "capture",
  "sandbox",
  "heartbeat",
  "close_work_session",
  "import",
  "validate",
  "test",
] as const
export type GodotSandboxAction = (typeof VALID_GODOT_ACTIONS)[number]

export const ONE_SHOT_GODOT_ACTIONS = ["capture", "sandbox", "import", "validate", "test"] as const

export const ALLOWED_WORKTREE_PREFIXES = [
  "/var/lib/aquanox-runner",
  "/home/rjwits",
  "/tmp",
  "/var/tmp",
  "/var/folders",
  "/private/var/folders",
  "/private/tmp",
] as const

export const DESCRIPTION = [
  "Execute deterministic Godot 4.7 Vulkan/DisplayServer visual captures, physics sandboxes, or GPU Broker work-session heartbeats/teardowns via the Aquanox GPU Broker.",
  "Supported actions: 'capture' (default), 'sandbox', 'heartbeat', 'close_work_session', 'import', 'validate', 'test'.",
  "While waiting for the GPU sandbox or Broker operation, the caller session's Buddy Slot remains reserved (keep_reserved policy).",
].join(" ")

export const Input = Schema.Struct({
  action: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(Schema.String),
  seed: Schema.optionalKey(Schema.Finite),
  timeout_seconds: Schema.optionalKey(Schema.Finite),
  timeout_s: Schema.optionalKey(Schema.Finite),
  timeout: Schema.optionalKey(Schema.Finite),
  output_dir: Schema.optionalKey(Schema.String),
  output_path: Schema.optionalKey(Schema.String),
  worktree_root: Schema.optionalKey(Schema.String),
  lease_mode: Schema.optionalKey(Schema.String),
  resident: Schema.optionalKey(Schema.Boolean),
})
export type Input = typeof Input.Type

export const Output = Schema.Record(Schema.String, Schema.Unknown)

export interface ValidatedGodotSandboxInput {
  action: GodotSandboxAction
  mode: GodotSandboxAction
  seed?: number
  timeout_seconds: number
  timeout_s: number
  timeout: number
  output_dir: string
  output_path: string
  worktree_root: string
  lease_mode: string
  resident: boolean
}

const STOP_ANCESTOR_DIRS = new Set([
  "/",
  "/home",
  "/home/rjwits",
  "/home/rjwits/work",
  "/home/rjwits/github",
  "/home/rjwits/worktrees",
  "/tmp",
  "/var",
  "/var/tmp",
  "/opt",
])

function findAncestorGodotProjectRoot(startDir: string): string | undefined {
  let curr = path.resolve(startDir)
  while (!STOP_ANCESTOR_DIRS.has(curr)) {
    const isAllowed = ALLOWED_WORKTREE_PREFIXES.some(
      (prefix) => curr === prefix || curr.startsWith(prefix + "/"),
    )
    if (!isAllowed) break
    try {
      if (fs.existsSync(path.join(curr, "project.godot"))) {
        return curr
      }
    } catch {}
    const parent = path.dirname(curr)
    if (parent === curr) break
    curr = parent
  }
  return undefined
}

export function validateGodotSandboxInput(
  input: Input,
  options?: { defaultBaseDir?: string } | string,
): ValidatedGodotSandboxInput {
  const rawAction = input.action
  const rawMode = input.mode
  if (
    rawAction !== undefined &&
    rawMode !== undefined &&
    rawAction !== rawMode &&
    rawAction !== "sandbox" &&
    rawMode !== "sandbox"
  ) {
    throw new Error(
      `ERR_INVALID_ACTION: conflicting godot_sandbox action '${rawAction}' and mode '${rawMode}'`,
    )
  }
  const action = (rawAction ?? rawMode ?? "capture") as GodotSandboxAction
  if (!(VALID_GODOT_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(
      `ERR_INVALID_ACTION: unknown godot_sandbox action '${action}'. Must be one of ${VALID_GODOT_ACTIONS.join(", ")}`,
    )
  }
  const resolvedMode = (
    action === "sandbox"
      ? rawMode && rawMode !== "sandbox"
        ? rawMode
        : "capture"
      : action
  ) as GodotSandboxAction

  const timeoutSeconds = input.timeout_seconds ?? input.timeout_s ?? input.timeout ?? 60
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 600) {
    throw new Error(`ERR_INVALID_TIMEOUT: timeout_seconds (${timeoutSeconds}) must be between 5 and 600`)
  }

  const isOneShot = (ONE_SHOT_GODOT_ACTIONS as readonly string[]).includes(action)
  // One-shot sandbox runs explicitly force resident: false to prevent GPU-025 unmonitored dead workers
  const resident = isOneShot ? false : Boolean(input.resident ?? false)

  const explicitWorktreeRoot =
    typeof input.worktree_root === "string" && input.worktree_root.trim().length > 0
      ? input.worktree_root.trim()
      : undefined

  const defaultBaseDir =
    typeof options === "string" && options.trim().length > 0
      ? options.trim()
      : typeof options === "object" &&
          options !== null &&
          typeof options.defaultBaseDir === "string" &&
          options.defaultBaseDir.trim().length > 0
        ? options.defaultBaseDir.trim()
        : undefined

  const baseDir = path.resolve(explicitWorktreeRoot ?? defaultBaseDir ?? process.cwd())

  const rawOutputDir =
    typeof input.output_dir === "string" && input.output_dir.trim().length > 0
      ? input.output_dir.trim()
      : typeof input.output_path === "string" && input.output_path.trim().length > 0
        ? input.output_path.trim()
        : "artifacts/godot_sandbox"

  let worktree_root: string
  let output_dir: string

  if (explicitWorktreeRoot === undefined && path.isAbsolute(rawOutputDir)) {
    if (rawOutputDir.split(/[/\\]+/).includes("..")) {
      throw new Error(`ERR_OUTPUT_PATH_ESCAPE: output_dir '${rawOutputDir}' contains path traversal`)
    }
    const resolvedOut = path.resolve(rawOutputDir)
    const isAllowed = ALLOWED_WORKTREE_PREFIXES.some(
      (prefix) => resolvedOut === prefix || resolvedOut.startsWith(prefix + "/"),
    )
    if (isAllowed) {
      const ancestorProject = findAncestorGodotProjectRoot(resolvedOut)
      worktree_root = ancestorProject ?? resolvedOut
      output_dir = resolvedOut
    } else {
      throw new Error(
        `ERR_OUTPUT_PATH_ESCAPE: output_dir '${rawOutputDir}' resolves outside allowed worktree prefixes`,
      )
    }
  } else {
    worktree_root = baseDir
    output_dir = path.resolve(worktree_root, rawOutputDir)
  }

  const relPath = path.relative(worktree_root, output_dir)
  if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
    throw new Error(
      `ERR_OUTPUT_PATH_ESCAPE: output_dir '${rawOutputDir}' resolves outside worktree_root '${worktree_root}'`,
    )
  }

  const isAllowedOutputPrefix = ALLOWED_WORKTREE_PREFIXES.some(
    (prefix) => output_dir === prefix || output_dir.startsWith(prefix + "/"),
  )
  if (isAllowedOutputPrefix && action !== "heartbeat" && action !== "close_work_session") {
    if (explicitWorktreeRoot === undefined && !path.isAbsolute(rawOutputDir)) {
      const artifactsDir = path.resolve(worktree_root, "artifacts")
      try {
        fs.mkdirSync(artifactsDir, { recursive: true, mode: 0o775 })
        try {
          fs.chmodSync(artifactsDir, 0o775)
        } catch {}
      } catch {}
    }
    try {
      fs.mkdirSync(output_dir, { recursive: true, mode: 0o775 })
      try {
        fs.chmodSync(output_dir, 0o775)
      } catch {}
    } catch {}
  }

  return {
    action,
    mode: resolvedMode,
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    timeout_seconds: timeoutSeconds,
    timeout_s: timeoutSeconds,
    timeout: timeoutSeconds,
    output_dir,
    output_path: output_dir,
    worktree_root,
    lease_mode: input.lease_mode ?? "shared_worker",
    resident,
  }
}

export function executeGodotSandbox(
  input: Input,
  sessionID: string,
  clientOrOptions?: GpuBrokerClient.Client | { defaultBaseDir?: string } | string,
  options?: { defaultBaseDir?: string } | string,
) {
  const isClient =
    clientOrOptions !== undefined &&
    typeof clientOrOptions === "object" &&
    clientOrOptions !== null &&
    "runGodotSandbox" in clientOrOptions &&
    typeof (clientOrOptions as any).runGodotSandbox === "function"
  const client = isClient ? (clientOrOptions as GpuBrokerClient.Client) : GpuBrokerClient.getDefaultClient()
  const resolvedOptions = isClient
    ? options
    : (clientOrOptions as { defaultBaseDir?: string } | string | undefined) ?? options

  return Effect.gen(function* () {
    const validated = yield* Effect.try({
      try: () => validateGodotSandboxInput(input, resolvedOptions),
      catch: (err) =>
        new ToolFailure({
          message: err instanceof Error ? err.message : String(err),
          error: err,
        }),
    })

    let knownLeaseId: string | undefined
    const result = yield* SessionSlotLease.withGpuToolSlotPolicy(
      sessionID,
      () =>
        Effect.tryPromise({
          try: async (signal) => {
            if (validated.action !== "heartbeat" && validated.action !== "close_work_session") {
              try {
                fs.mkdirSync(validated.worktree_root, { recursive: true, mode: 0o775 })
                fs.mkdirSync(validated.output_dir, { recursive: true, mode: 0o775 })
                try {
                  fs.chmodSync(validated.output_dir, 0o775)
                } catch {}
              } catch {
                // Broker will validate and report if path is invalid
              }
            }
            if (validated.action === "heartbeat") {
              return await client.sendSessionHeartbeat(
                {
                  session_id: sessionID,
                  lease_mode: validated.lease_mode,
                  signal,
                },
                { signal },
              )
            }
            if (validated.action === "close_work_session") {
              return await client.closeWorkSession(
                {
                  session_id: sessionID,
                  signal,
                },
                { signal },
              )
            }
            const res = await client.runGodotSandbox(
              {
                session_id: sessionID,
                action: validated.action,
                mode: validated.mode,
                seed: validated.seed,
                timeout_seconds: validated.timeout_seconds,
                timeout_s: validated.timeout_s,
                timeout: validated.timeout,
                output_dir: validated.output_dir,
                output_path: validated.output_path,
                worktree_root: validated.worktree_root,
                lease_mode: validated.lease_mode,
                resident: validated.resident,
                signal,
              },
              { signal },
            )
            if (typeof (res as any)?.lease_id === "string") {
              knownLeaseId = (res as any).lease_id
            }
            return res
          },
          catch: (err) => {
            const respBody = (err as any)?.responseBody as Record<string, unknown> | undefined
            const failuresArr = Array.isArray(respBody?.failures)
              ? (respBody!.failures as unknown[]).map(String)
              : []
            const stderrTail = typeof respBody?.stderr_tail === "string" ? respBody.stderr_tail : ""
            const baseMsg = err instanceof Error ? err.message : String(err)
            const extraDetail =
              failuresArr.length > 0 && !baseMsg.includes(failuresArr[0]!)
                ? ` | failures: ${failuresArr.join("; ")}`
                : stderrTail && !baseMsg.includes(stderrTail.slice(-200))
                  ? ` | stderr: ${stderrTail.slice(-500)}`
                  : ""
            return new ToolFailure({
              message: `godot_sandbox (${validated.action}) Broker call failed: ${baseMsg}${extraDetail}`,
              error: err,
            })
          },
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              if (knownLeaseId && typeof (client as any).closeWorkSession === "function") {
                void client
                  .closeWorkSession({
                    session_id: sessionID,
                    lease_id: knownLeaseId,
                    reason: "fiber_interrupted",
                  })
                  .catch(() => {})
              }
            }),
          ),
        ),
      { suspendMode: "keep_reserved" },
    )

    const allowTestBackend =
      process.env.AQUANOX_ALLOW_TEST_GODOT_BACKEND === "1" || process.env.AQUANOX_ALLOW_TEST_IMAGE_BACKEND === "1"
    const rawRes = result as Record<string, unknown>

    if (rawRes.ok !== true) {
      const errCode = typeof rawRes.error === "string" ? rawRes.error : "ERR_GODOT_SANDBOX_FAILED"
      const errMsg = typeof rawRes.message === "string" ? rawRes.message : `Broker returned ok=${String(rawRes.ok)}`
      return yield* Effect.fail(
        new ToolFailure({
          message: `${errCode}: ${errMsg}`,
          error: new Error(errCode),
        }),
      )
    }

    if ((rawRes.synthetic_test_data === true || rawRes.is_test_data === true) && !allowTestBackend) {
      return yield* Effect.fail(
        new ToolFailure({
          message: "ERR_SYNTHETIC_TEST_GODOT_REJECTED: Broker returned synthetic test Godot data in production",
          error: new Error("ERR_SYNTHETIC_TEST_GODOT_REJECTED"),
        }),
      )
    }

    if (validated.action === "capture" || validated.action === "sandbox") {
      const artifacts = Array.isArray(rawRes.artifacts)
        ? rawRes.artifacts
        : Array.isArray(rawRes.delivered_files)
          ? rawRes.delivered_files
          : []
      if (validated.worktree_root && artifacts.length === 0) {
        return yield* Effect.fail(
          new ToolFailure({
            message: `ERR_GODOT_ARTIFACT_NOT_DELIVERED: Broker returned empty artifacts/delivered_files for worktree_root '${validated.worktree_root}'`,
            error: new Error("ERR_GODOT_ARTIFACT_NOT_DELIVERED"),
          }),
        )
      }
    }

    const outputDir = typeof rawRes.output_dir === "string" ? rawRes.output_dir : validated.output_dir
    const manifestPath =
      typeof rawRes.manifest_path === "string" && rawRes.manifest_path.trim().length > 0
        ? rawRes.manifest_path
        : path.join(outputDir, "manifest.json")
    let diskManifest: Record<string, unknown> | undefined
    try {
      if (fs.existsSync(manifestPath)) {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
        if (parsed && typeof parsed === "object") {
          diskManifest = parsed as Record<string, unknown>
        }
      }
    } catch {}
    const manifestObj =
      rawRes.manifest && typeof rawRes.manifest === "object"
        ? (rawRes.manifest as Record<string, unknown>)
        : diskManifest
    const resourceAudit =
      manifestObj?.resource_audit && typeof manifestObj.resource_audit === "object"
        ? (manifestObj.resource_audit as Record<string, unknown>)
        : undefined
    const leaseId =
      (typeof rawRes.lease_id === "string" ? rawRes.lease_id : undefined) ??
      (typeof manifestObj?.lease_id === "string" ? manifestObj.lease_id : undefined)
    const exitCode =
      typeof rawRes.exit_code === "number"
        ? rawRes.exit_code
        : typeof manifestObj?.exit_code === "number"
          ? manifestObj.exit_code
          : undefined
    const deliveredFiles = Array.isArray(rawRes.delivered_files) ? (rawRes.delivered_files as string[]) : undefined
    const artifactsList = Array.isArray(rawRes.artifacts) ? (rawRes.artifacts as string[]) : undefined
    const elapsedMs =
      typeof rawRes.elapsed_ms === "number"
        ? rawRes.elapsed_ms
        : typeof manifestObj?.elapsed_ms === "number"
          ? manifestObj.elapsed_ms
          : undefined
    const framesCaptured =
      typeof rawRes.frames_captured === "number"
        ? rawRes.frames_captured
        : typeof manifestObj?.frames_captured === "number"
          ? manifestObj.frames_captured
          : undefined
    const sourceTreeSha256 =
      (typeof rawRes.source_tree_sha256 === "string" ? rawRes.source_tree_sha256 : undefined) ??
      (typeof manifestObj?.source_tree_sha256 === "string" ? manifestObj.source_tree_sha256 : undefined)
    const resolvedSourceRoot =
      (typeof rawRes.resolved_source_root === "string" ? rawRes.resolved_source_root : undefined) ??
      (typeof rawRes.selected_source_root === "string" ? rawRes.selected_source_root : undefined) ??
      (typeof rawRes.source_root === "string" ? rawRes.source_root : undefined) ??
      (typeof manifestObj?.resolved_source_root === "string" ? manifestObj.resolved_source_root : undefined) ??
      (typeof manifestObj?.selected_source_root === "string" ? manifestObj.selected_source_root : undefined) ??
      (typeof manifestObj?.source_root === "string" ? manifestObj.source_root : undefined)
    const argvList = Array.isArray(rawRes.argv)
      ? (rawRes.argv as string[])
      : Array.isArray(manifestObj?.argv)
        ? (manifestObj.argv as string[])
        : undefined
    const engineArgvList = Array.isArray(rawRes.engine_argv)
      ? (rawRes.engine_argv as string[][])
      : Array.isArray(manifestObj?.engine_argv)
        ? (manifestObj.engine_argv as string[][])
        : undefined
    const calibrationValid =
      typeof resourceAudit?.calibration_valid === "boolean"
        ? resourceAudit.calibration_valid
        : typeof manifestObj?.calibration_valid === "boolean"
          ? manifestObj.calibration_valid
          : undefined
    const samplingHz =
      typeof resourceAudit?.sampling_hz === "number"
        ? resourceAudit.sampling_hz
        : typeof manifestObj?.sampling_hz === "number"
          ? manifestObj.sampling_hz
          : undefined
    const computeProcessVramPeakMib =
      typeof resourceAudit?.compute_process_vram_peak_mib === "number"
        ? resourceAudit.compute_process_vram_peak_mib
        : undefined
    const deviceVramPeakMib =
      typeof resourceAudit?.device_vram_peak_mib === "number" ? resourceAudit.device_vram_peak_mib : undefined
    const summaryText = typeof rawRes.summary === "string" ? rawRes.summary : undefined
    const reportObj = rawRes.report !== undefined ? rawRes.report : manifestObj?.report

    const contentLines = [
      `Godot Sandbox [${validated.action}]: status=${(result as any).status ?? ((result as any).ok ? "ok" : "done")}`,
      ...(exitCode !== undefined ? [`Exit code: ${exitCode}`] : []),
      ...(outputDir ? [`Output dir: ${outputDir}`] : []),
      `Manifest path: ${manifestPath}`,
      ...(elapsedMs !== undefined ? [`Elapsed: ${elapsedMs} ms`] : []),
      ...(framesCaptured !== undefined ? [`Frames captured: ${framesCaptured}`] : []),
      ...(leaseId !== undefined ? [`Lease ID: ${leaseId}`] : []),
      ...(sourceTreeSha256 !== undefined ? [`source_tree_sha256: ${sourceTreeSha256}`] : []),
      ...(resolvedSourceRoot !== undefined ? [`resolved_source_root: ${resolvedSourceRoot}`] : []),
      ...(calibrationValid !== undefined ? [`calibration_valid: ${String(calibrationValid)}`] : []),
      ...(samplingHz !== undefined ? [`sampling_hz: ${samplingHz}`] : []),
      ...(computeProcessVramPeakMib !== undefined
        ? [`compute_process_vram_peak_mib: ${computeProcessVramPeakMib}`]
        : []),
      ...(deviceVramPeakMib !== undefined ? [`device_vram_peak_mib: ${deviceVramPeakMib}`] : []),
      ...(deliveredFiles && deliveredFiles.length > 0 ? [`Delivered files: ${deliveredFiles.join(", ")}`] : []),
      ...(artifactsList && artifactsList.length > 0 ? [`Artifacts: ${artifactsList.join(", ")}`] : []),
      ...(summaryText ? [`Summary: ${summaryText}`] : []),
      ...(reportObj !== undefined ? [`Report: ${typeof reportObj === "string" ? reportObj : JSON.stringify(reportObj)}`] : []),
    ]
    const contentText = contentLines.join("\n")

    const fileContentParts: Array<{ type: "file"; uri: string; mime: string; name: string }> = []
    try {
      const candidatePngs = [
        ...(deliveredFiles ?? []),
        ...(artifactsList ?? []),
      ].filter((p) => typeof p === "string" && p.toLowerCase().endsWith(".png"))
      const uniquePngs = Array.from(new Set(candidatePngs)).slice(0, 4)
      for (const rawPngPath of uniquePngs) {
        const pngPath = path.isAbsolute(rawPngPath) ? rawPngPath : path.join(outputDir, rawPngPath)
        if (fs.existsSync(pngPath) && fs.statSync(pngPath).isFile()) {
          const b64 = fs.readFileSync(pngPath).toString("base64")
          fileContentParts.push({
            type: "file",
            uri: `data:image/png;base64,${b64}`,
            mime: "image/png",
            name: path.basename(pngPath),
          })
        }
      }
    } catch {}

    return {
      output: result as Record<string, unknown>,
      content:
        fileContentParts.length > 0
          ? ([{ type: "text" as const, text: contentText }, ...fileContentParts] as any)
          : contentText,
      metadata: {
        action: validated.action,
        mode: (typeof rawRes.mode === "string" ? rawRes.mode : undefined) ?? validated.mode,
        ok: Boolean((result as any).ok ?? true),
        manifest_path: manifestPath,
        ...(leaseId !== undefined ? { lease_id: leaseId } : {}),
        ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
        ...(outputDir ? { output_dir: outputDir } : {}),
        ...(deliveredFiles !== undefined ? { delivered_files: deliveredFiles } : {}),
        ...(artifactsList !== undefined ? { artifacts: artifactsList } : {}),
        ...(elapsedMs !== undefined ? { elapsed_ms: elapsedMs } : {}),
        ...(framesCaptured !== undefined ? { frames_captured: framesCaptured } : {}),
        ...(sourceTreeSha256 !== undefined ? { source_tree_sha256: sourceTreeSha256 } : {}),
        ...(resolvedSourceRoot !== undefined ? { resolved_source_root: resolvedSourceRoot } : {}),
        ...(calibrationValid !== undefined ? { calibration_valid: calibrationValid } : {}),
        ...(samplingHz !== undefined ? { sampling_hz: samplingHz } : {}),
        ...(computeProcessVramPeakMib !== undefined
          ? { compute_process_vram_peak_mib: computeProcessVramPeakMib }
          : {}),
        ...(deviceVramPeakMib !== undefined ? { device_vram_peak_mib: deviceVramPeakMib } : {}),
        ...(argvList !== undefined ? { argv: argvList } : {}),
        ...(engineArgvList !== undefined ? { engine_argv: engineArgvList } : {}),
        ...(summaryText !== undefined ? { summary: summaryText } : {}),
        ...(reportObj !== undefined ? { report: reportObj } : {}),
      },
    }
  })
}

export const Plugin = {
  id: "opencode.tool.godot_sandbox",
  effect: Effect.fn("GodotSandboxTool.Plugin")(function* (ctx: Context) {
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name,
          options: { codemode: false },
          description: DESCRIPTION,
          input: Input,
          output: Output,
          execute: (input, context) => {
            const defaultBaseDir =
              (typeof (context as any)?.directory === "string" && (context as any).directory.trim().length > 0
                ? (context as any).directory.trim()
                : undefined) ??
              (typeof (context as any)?.worktree === "string" && (context as any).worktree.trim().length > 0
                ? (context as any).worktree.trim()
                : undefined) ??
              (typeof (ctx as any)?.directory === "string" && (ctx as any).directory.trim().length > 0
                ? (ctx as any).directory.trim()
                : undefined) ??
              (typeof (ctx as any)?.worktree === "string" && (ctx as any).worktree.trim().length > 0
                ? (ctx as any).worktree.trim()
                : undefined)
            return permission
              .assert({
                action: name,
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              .pipe(
                Effect.mapError((error) => new ToolFailure({ message: "Unable to execute godot_sandbox", error })),
                Effect.flatMap(() =>
                  executeGodotSandbox(input, context.sessionID, undefined, {
                    ...(defaultBaseDir ? { defaultBaseDir } : {}),
                  }),
                ),
              )
          },
        })
      })
      .pipe(Effect.orDie)
  }),
}
