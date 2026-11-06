export * as GenerateImageTool from "./generate-image.js"

import fs from "node:fs"
import path from "node:path"
import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Permission } from "../../permission.js"
import { SessionSlotLease } from "../../session/slot-lease.js"
import { GpuBrokerClient } from "../../util/gpu-broker-client.js"

export const name = "generate_image"

export const MAX_PROMPT_UTF8_BYTES = 4096

export const ALLOWED_DIMENSIONS: ReadonlyArray<readonly [number, number]> = [
  [512, 512],
  [768, 768],
  [1024, 1024],
  [1280, 800],
  [800, 1280],
] as const

export const ALLOWED_WORKTREE_PREFIXES = [
  "/var/lib/aquanox-runner",
  "/home/rjwits",
  "/tmp",
  "/var/tmp",
  "/var/folders",
  "/private/var/folders",
  "/private/tmp",
] as const

export const VALID_IMAGE_TIERS = [
  "qwen_image_2512",
  "max",
  "default",
  "tier1_klein4b_q4",
  "tier2_klein4b_fp8",
  "tier3_klein9b_q4",
  "tier4_dev_q4",
  "tier4a_qwen_edit2508",
  "tier4b_qwen_edit2509",
  "tier5_flux2_dev32b",
  "tier1_schnell",
  "tier2_klein9b_q4",
  "tier3_kontext12b",
  "tier4_sd35_large",
] as const

export const NON_COMMERCIAL_TIERS: ReadonlySet<string> = new Set([
  "tier3_klein9b_q4",
  "tier4_dev_q4",
  "tier2_klein9b_q4",
  "tier3_kontext12b",
  "tier5_flux2_dev32b",
])

export const DESCRIPTION = [
  "Generate high-resolution photorealistic images, concept art, textures, or visual keyframes on Dedicated GPU 3 via the Aquanox GPU Broker using Qwen-Image-2512 20B (Q5_K_M, Apache-2.0) at maximum quality.",
  "There is only one unified max-quality model tier — do NOT specify or compare tiers. Default steps is 28 for maximum sharpness and photorealism.",
  "Allowed dimensions: (512, 512), (768, 768), (1024, 1024), (1280, 800), or (800, 1280). Prompt must be <= 4096 UTF-8 bytes.",
  "Omit output_path and worktree_root to save to '/home/rjwits/artifacts/generated_image.png', or specify '/home/rjwits/artifacts/<name>.png'. Never write directly to '/home/rjwits/<name>.png'.",
  "While waiting for GPU generation, the caller session's Buddy Slot remains reserved (keep_reserved policy).",
].join(" ")

export const Input = Schema.Struct({
  prompt: Schema.String,
  tier: Schema.optionalKey(Schema.String),
  width: Schema.optionalKey(Schema.Finite),
  height: Schema.optionalKey(Schema.Finite),
  steps: Schema.optionalKey(Schema.Finite),
  seed: Schema.optionalKey(Schema.Finite),
  output_path: Schema.optionalKey(Schema.String),
  worktree_root: Schema.optionalKey(Schema.String),
  lease_mode: Schema.optionalKey(Schema.String),
  caller_hint: Schema.optionalKey(Schema.String),
  non_commercial_ack: Schema.optionalKey(Schema.Boolean),
})
export type Input = typeof Input.Type

export const Output = Schema.Record(Schema.String, Schema.Unknown)

export interface ValidatedGenerateImageEnvelope {
  prompt: string
  tier: string
  width: number
  height: number
  steps?: number
  seed?: number
  output_path: string
  worktree_root: string
  lease_mode: string
  caller_hint?: string
  non_commercial_ack: boolean
}

export function validateGenerateImageInput(
  input: Input,
  options?: { defaultBaseDir?: string } | string,
): ValidatedGenerateImageEnvelope {
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
    throw new Error("ERR_INVALID_PROMPT: prompt must be a non-empty string")
  }

  const promptBytes = Buffer.byteLength(input.prompt, "utf8")
  if (promptBytes > MAX_PROMPT_UTF8_BYTES) {
    throw new Error(
      `ERR_PROMPT_TOO_LONG: prompt UTF-8 byte length (${promptBytes}) exceeds maximum of ${MAX_PROMPT_UTF8_BYTES} bytes`,
    )
  }

  const width = input.width ?? 1024
  const height = input.height ?? 1024
  const validDim = ALLOWED_DIMENSIONS.some(([w, h]) => w === width && h === height)
  if (!validDim) {
    throw new Error(
      `ERR_INVALID_DIMENSIONS: (${width}, ${height}) is not in allowed dimensions {(512, 512), (768, 768), (1024, 1024), (1280, 800), (800, 1280)}`,
    )
  }

  const tier = input.tier ?? "tier1_klein4b_q4"
  if (!(VALID_IMAGE_TIERS as readonly string[]).includes(tier)) {
    throw new Error(`ERR_INVALID_TIER: unknown image generation tier '${tier}'`)
  }

  const nonCommercialAck = Boolean(input.non_commercial_ack)
  if (NON_COMMERCIAL_TIERS.has(tier) && !nonCommercialAck) {
    throw new Error(
      `ERR_NON_COMMERCIAL_ACK_REQUIRED: tier '${tier}' requires non_commercial_ack: true before Broker invocation`,
    )
  }

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

  const rawOutputPath =
    typeof input.output_path === "string" && input.output_path.trim().length > 0
      ? input.output_path.trim()
      : "artifacts/generated_image.png"

  let worktree_root: string
  let output_path: string

  const hasPathTraversal = rawOutputPath.split(/[/\\]+/).includes("..")

  if (path.isAbsolute(rawOutputPath)) {
    if (hasPathTraversal) {
      throw new Error(`ERR_OUTPUT_PATH_ESCAPE: output_path '${rawOutputPath}' contains path traversal`)
    }
    const resolvedOut = path.resolve(rawOutputPath)
    const isAllowed = ALLOWED_WORKTREE_PREFIXES.some(
      (prefix) => resolvedOut === prefix || resolvedOut.startsWith(prefix + "/"),
    )
    if (!isAllowed) {
      throw new Error(
        `ERR_OUTPUT_PATH_ESCAPE: output_path '${rawOutputPath}' resolves outside allowed worktree prefixes`,
      )
    }

    if (explicitWorktreeRoot === undefined) {
      worktree_root = path.dirname(resolvedOut)
      output_path = resolvedOut
    } else {
      const relToBase = path.relative(baseDir, resolvedOut)
      const isOutsideBaseDir = relToBase.startsWith("..") || path.isAbsolute(relToBase) || relToBase === ""
      const canReRoot =
        explicitWorktreeRoot === "/home/rjwits" ||
        explicitWorktreeRoot === "/var/lib/aquanox-runner" ||
        resolvedOut.startsWith("/tmp/opencode/") ||
        resolvedOut.startsWith("/home/rjwits/artifacts/") ||
        resolvedOut.startsWith("/home/rjwits/work/")
      if (isOutsideBaseDir && canReRoot) {
        worktree_root = path.dirname(resolvedOut)
        output_path = resolvedOut
      } else {
        worktree_root = baseDir
        output_path = resolvedOut
      }
    }
  } else {
    worktree_root = baseDir
    output_path = path.resolve(worktree_root, rawOutputPath)
  }

  if (path.dirname(output_path) === "/home/rjwits") {
    output_path = path.join("/home/rjwits/artifacts", path.basename(output_path))
  }

  const relPath = path.relative(worktree_root, output_path)
  if (relPath.startsWith("..") || path.isAbsolute(relPath) || relPath === "") {
    throw new Error(
      `ERR_OUTPUT_PATH_ESCAPE: output_path '${rawOutputPath}' resolves outside worktree_root '${worktree_root}'`,
    )
  }

  const isAllowedOutputPrefix = ALLOWED_WORKTREE_PREFIXES.some(
    (prefix) => output_path === prefix || output_path.startsWith(prefix + "/"),
  )
  if (isAllowedOutputPrefix) {
    if (explicitWorktreeRoot === undefined && !path.isAbsolute(rawOutputPath)) {
      const artifactsDir = path.resolve(worktree_root, "artifacts")
      try {
        fs.mkdirSync(artifactsDir, { recursive: true, mode: 0o775 })
        try {
          fs.chmodSync(artifactsDir, 0o775)
        } catch {}
      } catch {}
    }
    const outDir = path.dirname(output_path)
    try {
      fs.mkdirSync(outDir, { recursive: true, mode: 0o775 })
      try {
        fs.chmodSync(outDir, 0o775)
      } catch {}
    } catch {}
  }

  return {
    prompt: input.prompt,
    tier,
    width,
    height,
    steps: input.steps ?? (process.env.AQUANOX_FAST_IMAGE_STEPS ? parseInt(process.env.AQUANOX_FAST_IMAGE_STEPS, 10) : 28),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    output_path,
    worktree_root,
    lease_mode: input.lease_mode ?? "shared_worker",
    ...(input.caller_hint !== undefined ? { caller_hint: input.caller_hint } : {}),
    non_commercial_ack: nonCommercialAck,
  }
}

export function executeGenerateImage(
  input: Input,
  sessionID: string,
  clientOrOptions?: GpuBrokerClient.Client | { defaultBaseDir?: string } | string,
  options?: { defaultBaseDir?: string } | string,
) {
  const isClient =
    clientOrOptions !== undefined &&
    typeof clientOrOptions === "object" &&
    clientOrOptions !== null &&
    "generateImage" in clientOrOptions &&
    typeof (clientOrOptions as any).generateImage === "function"
  const client = isClient ? (clientOrOptions as GpuBrokerClient.Client) : GpuBrokerClient.getDefaultClient()
  const resolvedOptions = isClient
    ? options
    : (clientOrOptions as { defaultBaseDir?: string } | string | undefined) ?? options

  return Effect.gen(function* () {
    const validated = yield* Effect.try({
      try: () => validateGenerateImageInput(input, resolvedOptions),
      catch: (err) =>
        new ToolFailure({
          message: err instanceof Error ? err.message : String(err),
          error: err,
        }),
    })

    let knownLeaseId: string | undefined
    const response = yield* SessionSlotLease.withGpuToolSlotPolicy(
      sessionID,
      () =>
        Effect.tryPromise({
          try: async (signal) => {
            try {
              const outDir = path.dirname(validated.output_path)
              fs.mkdirSync(validated.worktree_root, { recursive: true, mode: 0o775 })
              fs.mkdirSync(outDir, { recursive: true, mode: 0o775 })
              try {
                fs.chmodSync(outDir, 0o775)
              } catch {}
            } catch {
              // Broker will validate and report if path is invalid
            }

            const maxBusyRetries = 45
            const busyRetryDelayMs = 2000

            for (let attempt = 0; attempt <= maxBusyRetries; attempt++) {
              try {
                const res = await client.generateImage(
                  {
                    session_id: sessionID,
                    ...validated,
                    signal,
                  },
                  { signal },
                )
                if (typeof (res as any)?.lease_id === "string") {
                  knownLeaseId = (res as any).lease_id
                }
                return res
              } catch (err: any) {
                const errMsg = err instanceof Error ? err.message : String(err)
                if (
                  errMsg.includes("ERR_WORKER_LEASE_BUSY") &&
                  attempt < maxBusyRetries &&
                  !signal?.aborted
                ) {
                  await new Promise<void>((resolve, reject) => {
                    if (signal?.aborted) {
                      reject(new Error("aborted"))
                      return
                    }
                    let timer: ReturnType<typeof setTimeout> | undefined
                    const onAbort = () => {
                      if (timer !== undefined) clearTimeout(timer)
                      signal?.removeEventListener("abort", onAbort)
                      reject(new Error("aborted"))
                    }
                    signal?.addEventListener("abort", onAbort, { once: true })
                    timer = setTimeout(() => {
                      signal?.removeEventListener("abort", onAbort)
                      resolve()
                    }, busyRetryDelayMs)
                  })
                  continue
                }
                throw err
              }
            }
            throw new Error("ERR_WORKER_LEASE_BUSY: Max queue wait exceeded")
          },
          catch: (err) =>
            new ToolFailure({
              message: `generate_image Broker call failed: ${err instanceof Error ? err.message : String(err)}`,
              error: err,
            }),
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

    const allowTestBackend = process.env.AQUANOX_ALLOW_TEST_IMAGE_BACKEND === "1"
    if (response.ok !== true) {
      return yield* Effect.fail(
        new ToolFailure({
          message: `ERR_IMAGE_GENERATION_FAILED: Broker returned ok=${String(response.ok)}`,
          error: new Error("ERR_IMAGE_GENERATION_FAILED"),
        }),
      )
    }

    if (typeof response.output_path !== "string" || response.output_path.trim().length === 0) {
      return yield* Effect.fail(
        new ToolFailure({
          message: "ERR_IMAGE_OUTPUT_MISSING: Broker response did not include a non-empty output_path",
          error: new Error("ERR_IMAGE_OUTPUT_MISSING"),
        }),
      )
    }

    if ((response.is_test_data === true || response.synthetic_test_data === true) && !allowTestBackend) {
      return yield* Effect.fail(
        new ToolFailure({
          message: "ERR_SYNTHETIC_TEST_IMAGE_REJECTED: Broker returned synthetic test image data in production",
          error: new Error("ERR_SYNTHETIC_TEST_IMAGE_REJECTED"),
        }),
      )
    }

    const deliveredFiles = Array.isArray(response.delivered_files) ? response.delivered_files : []
    if (validated.worktree_root && deliveredFiles.length === 0) {
      return yield* Effect.fail(
        new ToolFailure({
          message: `ERR_IMAGE_ARTIFACT_NOT_DELIVERED: Broker returned empty delivered_files for worktree_root '${validated.worktree_root}'`,
          error: new Error("ERR_IMAGE_ARTIFACT_NOT_DELIVERED"),
        }),
      )
    }

    const manifestPath =
      typeof response.manifest_path === "string" && response.manifest_path.trim().length > 0
        ? response.manifest_path
        : path.join(path.dirname(String(response.output_path)), "manifest.json")
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
      response.manifest && typeof response.manifest === "object"
        ? (response.manifest as Record<string, unknown>)
        : diskManifest
    const resourceAudit =
      manifestObj?.resource_audit && typeof manifestObj.resource_audit === "object"
        ? (manifestObj.resource_audit as Record<string, unknown>)
        : undefined
    const nvmlObj =
      manifestObj?.nvml && typeof manifestObj.nvml === "object"
        ? (manifestObj.nvml as Record<string, unknown>)
        : undefined
    const leaseId =
      (typeof response.lease_id === "string" ? response.lease_id : undefined) ??
      (typeof manifestObj?.lease_id === "string" ? manifestObj.lease_id : undefined)
    const fileSha256s =
      manifestObj?.file_sha256s && typeof manifestObj.file_sha256s === "object"
        ? (manifestObj.file_sha256s as Record<string, unknown>)
        : undefined
    const outputBasename = path.basename(String(response.output_path))
    const fallbackFileSha256 =
      fileSha256s !== undefined
        ? (typeof fileSha256s[outputBasename] === "string"
            ? (fileSha256s[outputBasename] as string)
            : typeof fileSha256s["output.png"] === "string"
              ? (fileSha256s["output.png"] as string)
              : (Object.values(fileSha256s).find((v) => typeof v === "string") as string | undefined))
        : undefined
    const sha256 =
      (typeof response.sha256 === "string" ? response.sha256 : undefined) ??
      (typeof manifestObj?.sha256 === "string" ? manifestObj.sha256 : undefined) ??
      (typeof manifestObj?.artifact_sha256 === "string" ? manifestObj.artifact_sha256 : undefined) ??
      fallbackFileSha256
    const calibrationValid =
      typeof resourceAudit?.calibration_valid === "boolean"
        ? resourceAudit.calibration_valid
        : typeof manifestObj?.calibration_valid === "boolean"
          ? manifestObj.calibration_valid
          : typeof response.calibration_valid === "boolean"
            ? response.calibration_valid
            : undefined
    const samplingHz =
      typeof resourceAudit?.sampling_hz === "number"
        ? resourceAudit.sampling_hz
        : typeof manifestObj?.sampling_hz === "number"
          ? manifestObj.sampling_hz
          : typeof response.sampling_hz === "number"
            ? response.sampling_hz
            : undefined
    const computeProcessVramPeakMib =
      typeof resourceAudit?.compute_process_vram_peak_mib === "number"
        ? resourceAudit.compute_process_vram_peak_mib
        : typeof nvmlObj?.peak_process_vram_mib === "number"
          ? nvmlObj.peak_process_vram_mib
          : typeof response.vram_peak_mib === "number"
            ? response.vram_peak_mib
            : undefined
    const deviceVramPeakMib =
      typeof resourceAudit?.device_vram_peak_mib === "number"
        ? resourceAudit.device_vram_peak_mib
        : typeof nvmlObj?.device_vram_peak_mib === "number"
          ? nvmlObj.device_vram_peak_mib
          : undefined
    const cgroupAnonPeakMib =
      typeof resourceAudit?.cgroup_anon_peak_mib === "number" ? resourceAudit.cgroup_anon_peak_mib : undefined
    const cgroupTotalPeakMib =
      typeof resourceAudit?.cgroup_total_peak_mib === "number" ? resourceAudit.cgroup_total_peak_mib : undefined
    const vramPeakMib = computeProcessVramPeakMib ?? deviceVramPeakMib
    const brokerState =
      (typeof response.state === "string" ? response.state : undefined) ??
      (typeof response.broker_state === "string" ? response.broker_state : undefined) ??
      (typeof manifestObj?.state === "string" ? manifestObj.state : undefined)

    const summaryLines = [
      `Generated image (${response.width ?? validated.width}x${response.height ?? validated.height}, model=Qwen-Image-2512-20B-Q5_K_M)`,
      `Output path: ${response.output_path}`,
      `Manifest path: ${manifestPath}`,
      `Elapsed: ${response.elapsed_ms ?? 0} ms`,
      ...(leaseId !== undefined ? [`Lease ID: ${leaseId}`] : []),
      ...(vramPeakMib !== undefined ? [`VRAM peak: ${vramPeakMib} MiB`] : []),
      ...(computeProcessVramPeakMib !== undefined
        ? [`compute_process_vram_peak_mib: ${computeProcessVramPeakMib}`]
        : []),
      ...(deviceVramPeakMib !== undefined ? [`device_vram_peak_mib: ${deviceVramPeakMib}`] : []),
      ...(cgroupAnonPeakMib !== undefined ? [`cgroup_anon_peak_mib: ${cgroupAnonPeakMib}`] : []),
      ...(cgroupTotalPeakMib !== undefined ? [`cgroup_total_peak_mib: ${cgroupTotalPeakMib}`] : []),
      ...(calibrationValid !== undefined ? [`calibration_valid: ${String(calibrationValid)}`] : []),
      ...(samplingHz !== undefined ? [`sampling_hz: ${samplingHz}`] : []),
      ...(sha256 !== undefined ? [`SHA-256: ${sha256}`] : []),
      ...(brokerState !== undefined ? [`Broker state: ${brokerState}`] : []),
      ...(deliveredFiles.length > 0 ? [`Delivered files: ${deliveredFiles.join(", ")}`] : []),
    ]
    const summary = summaryLines.join("\n")

    return {
      output: response as Record<string, unknown>,
      content: summary,
      metadata: {
        tier: response.tier ?? validated.tier,
        width: response.width ?? validated.width,
        height: response.height ?? validated.height,
        output_path: response.output_path,
        manifest_path: manifestPath,
        delivered_files: deliveredFiles,
        elapsed_ms: response.elapsed_ms ?? 0,
        ...(leaseId !== undefined ? { lease_id: leaseId } : {}),
        ...(sha256 !== undefined ? { sha256 } : {}),
        ...(calibrationValid !== undefined ? { calibration_valid: calibrationValid } : {}),
        ...(samplingHz !== undefined ? { sampling_hz: samplingHz } : {}),
        ...(vramPeakMib !== undefined ? { vram_peak_mib: vramPeakMib } : {}),
        ...(computeProcessVramPeakMib !== undefined
          ? { compute_process_vram_peak_mib: computeProcessVramPeakMib }
          : {}),
        ...(deviceVramPeakMib !== undefined ? { device_vram_peak_mib: deviceVramPeakMib } : {}),
        ...(cgroupAnonPeakMib !== undefined ? { cgroup_anon_peak_mib: cgroupAnonPeakMib } : {}),
        ...(cgroupTotalPeakMib !== undefined ? { cgroup_total_peak_mib: cgroupTotalPeakMib } : {}),
        ...(brokerState !== undefined ? { broker_state: brokerState } : {}),
      },
    }
  })
}

export const Plugin = {
  id: "opencode.tool.generate_image",
  effect: Effect.fn("GenerateImageTool.Plugin")(function* (ctx: Context) {
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
                Effect.mapError((error) => new ToolFailure({ message: "Unable to execute generate_image", error })),
                Effect.flatMap(() =>
                  executeGenerateImage(input, context.sessionID, undefined, {
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
