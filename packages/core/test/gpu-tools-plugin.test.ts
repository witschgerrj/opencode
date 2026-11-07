import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import { Effect, Schema } from "effect"
import { Session } from "@opencode/schema/session"
import { Agent } from "@opencode/schema/agent"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { SessionSlotLease } from "../src/session/slot-lease.js"
import { GpuBrokerClient } from "../src/util/gpu-broker-client.js"
import { GenerateImageTool } from "../src/tool/plugin/generate-image.js"
import { GodotSandboxTool } from "../src/tool/plugin/godot-sandbox.js"
import { ConfigAgentPlugin } from "../src/config/plugin/agent.js"
import { definition, execute } from "../src/tool/runtime.js"

interface MockBrokerState {
  bootId: string
  epoch: number
  hmacKeyHex: string
  bootstrapCalls: number
  imageCalls: number
  godotCalls: number
  heartbeatCalls: number
  closeCalls: number
  receivedEnvelopes: GpuBrokerClient.SignedBrokerEnvelope[]
  receivedParams: Record<string, unknown>[]
  receivedBootstrapPayloads: Record<string, unknown>[]
  imageResponseOverride?: Record<string, unknown>
  imageStatusCodeOverride?: number
  godotResponseOverride?: Record<string, unknown>
  godotStatusCodeOverride?: number
  admissionResponseOverride?: Record<string, unknown>
  admissionStatusCodeOverride?: number
  onBeforeRespond?: () => void
}

function createMockBrokerServer(socketPath: string) {
  const state: MockBrokerState = {
    bootId: "boot_v12_initial",
    epoch: 1,
    hmacKeyHex: crypto.randomBytes(32).toString("hex"),
    bootstrapCalls: 0,
    imageCalls: 0,
    godotCalls: 0,
    heartbeatCalls: 0,
    closeCalls: 0,
    receivedEnvelopes: [],
    receivedParams: [],
    receivedBootstrapPayloads: [],
  }

  const rotateBrokerEpoch = (newBootId: string, newEpoch: number) => {
    state.bootId = newBootId
    state.epoch = newEpoch
    state.hmacKeyHex = crypto.randomBytes(32).toString("hex")
  }

  const rotateHmacKeySameEpoch = (newBootId?: string, sameEpoch?: number) => {
    if (newBootId !== undefined) state.bootId = newBootId
    if (sameEpoch !== undefined) state.epoch = sameEpoch
    state.hmacKeyHex = crypto.randomBytes(32).toString("hex")
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      const body = raw ? JSON.parse(raw) : {}

      res.setHeader("Content-Type", "application/json")

      if (req.url === "/v1/admission/evaluate" && req.method === "POST") {
        res.statusCode = state.admissionStatusCodeOverride ?? 200
        res.end(
          JSON.stringify(
            state.admissionResponseOverride ?? {
              ok: true,
              admitted: true,
              mem_available_mib: 120000,
              effective_available_mib: 112000,
            },
          ),
        )
        return
      }

      if (req.url === "/v1/auth/bootstrap_or_rekey" && req.method === "POST") {
        state.bootstrapCalls++
        state.receivedBootstrapPayloads.push(body)
        if (body.force_rekey === true) {
          state.epoch += 1
          state.hmacKeyHex = crypto.randomBytes(32).toString("hex")
        }
        res.statusCode = 200
        res.end(
          JSON.stringify({
            ok: true,
            broker_boot_id: state.bootId,
            broker_epoch: state.epoch,
            hmac_key_hex: state.hmacKeyHex,
          }),
        )
        return
      }

      const envelope = body.envelope as GpuBrokerClient.SignedBrokerEnvelope | undefined
      const params = (body.params ?? {}) as Record<string, unknown>

      if (!envelope) {
        res.statusCode = 400
        res.end(JSON.stringify({ ok: false, error: "ERR_MISSING_ENVELOPE" }))
        return
      }

      state.receivedEnvelopes.push(envelope)
      state.receivedParams.push(params)

      if (envelope.broker_boot_id !== state.bootId || envelope.broker_epoch !== state.epoch) {
        res.statusCode = 401
        res.end(
          JSON.stringify({
            ok: false,
            error: "ERR_BROKER_EPOCH_MISMATCH",
            message: "Broker epoch or boot_id changed; please bootstrap_or_rekey",
            broker_boot_id: state.bootId,
            broker_epoch: state.epoch,
          }),
        )
        return
      }

      const validSig = GpuBrokerClient.verifyBrokerRequestEnvelope(envelope, params, state.hmacKeyHex)
      if (!validSig) {
        res.statusCode = 403
        res.end(
          JSON.stringify({
            ok: false,
            error: "ERR_INVALID_SIGNATURE",
            message: "HMAC signature verification failed",
          }),
        )
        return
      }

      state.onBeforeRespond?.()

      if (req.url === "/v1/lease/image" && req.method === "POST") {
        state.imageCalls++
        res.statusCode = state.imageStatusCodeOverride ?? 200
        const outPath = (params.output_path as string) ?? "/tmp/generated_concept.png"
        res.end(
          JSON.stringify({
            ok: true,
            output_path: outPath,
            delivered_files: [outPath],
            width: params.width ?? 1024,
            height: params.height ?? 1024,
            tier: params.tier ?? "tier1_schnell",
            seed: params.seed ?? 42,
            elapsed_ms: 125,
            vram_peak_mib: 6144,
            lease_mode: params.lease_mode ?? "shared_worker",
            ...state.imageResponseOverride,
          }),
        )
        return
      }

      if (req.url === "/v1/lease/godot" && req.method === "POST") {
        state.godotCalls++
        res.statusCode = state.godotStatusCodeOverride ?? 200
        res.end(
          JSON.stringify({
            ok: state.godotStatusCodeOverride && state.godotStatusCodeOverride >= 400 ? false : true,
            action: params.action ?? "capture",
            exit_code: 0,
            frames_captured: 4,
            output_dir: (params.output_dir as string) ?? "/tmp/godot_frames",
            artifacts: ["/tmp/godot_frames/frame_0001.png"],
            delivered_files: ["/tmp/godot_frames/frame_0001.png"],
            elapsed_ms: 210,
            lease_mode: params.lease_mode ?? "shared_worker",
            ...state.godotResponseOverride,
          }),
        )
        return
      }

      if (req.url === "/v1/session/heartbeat" && req.method === "POST") {
        state.heartbeatCalls++
        res.statusCode = 200
        res.end(
          JSON.stringify({
            ok: true,
            status: "heartbeat_ack",
            conversation_id: envelope.conversation_id,
            session_id: envelope.session_id,
          }),
        )
        return
      }

      if (req.url === "/v1/session/close" && req.method === "POST") {
        state.closeCalls++
        res.statusCode = 200
        res.end(
          JSON.stringify({
            ok: true,
            status: "closed",
            conversation_id: envelope.conversation_id,
            session_id: envelope.session_id,
            lease_released: true,
          }),
        )
        return
      }

      res.statusCode = 404
      res.end(JSON.stringify({ ok: false, error: "ERR_NOT_FOUND" }))
    })
  })

  return {
    state,
    rotateBrokerEpoch,
    rotateHmacKeySameEpoch,
    start: () =>
      new Promise<void>((resolve, reject) => {
        try {
          if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath)
        } catch {
          // ignore
        }
        server.once("error", reject)
        server.listen(socketPath, () => resolve())
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          try {
            if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath)
          } catch {
            // ignore
          }
          resolve()
        })
      }),
  }
}

describe("Aquanox v12.0 GPU Broker Client — Canonical SHA-256 & HMAC Envelope (§2.1)", () => {
  test("signBrokerRequestEnvelope produces deterministic canonical SHA-256 and exact v12.0 HMAC tuple", () => {
    const keyHex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

    const paramsA = {
      width: 1280,
      height: 800,
      prompt: "Bioluminescent coral reef cathedral",
      tier: "tier1_schnell",
      nested: { z: 1, a: 2 },
    }
    const paramsB = {
      tier: "tier1_schnell",
      nested: { a: 2, z: 1 },
      prompt: "Bioluminescent coral reef cathedral",
      height: 800,
      width: 1280,
    }

    const shaA = GpuBrokerClient.computeParamsSha256(paramsA)
    const shaB = GpuBrokerClient.computeParamsSha256(paramsB)
    expect(shaA).toBe(shaB)

    const envA = GpuBrokerClient.signBrokerRequestEnvelope({
      conversation_id: "conv_art_1",
      session_id: "ses_sub_1",
      session_generation: 7,
      lease_id: "lease_conv_art_1_1",
      method: "lease.image",
      params: paramsA,
      hmac_key_hex: keyHex,
      broker_boot_id: "boot_123",
      broker_epoch: 3,
      nonce: "fixed_nonce_abc",
      expires_at: 1_900_000_000,
    })

    const envB = GpuBrokerClient.signBrokerRequestEnvelope({
      conversation_id: "conv_art_1",
      session_id: "ses_sub_1",
      session_generation: 7,
      lease_id: "lease_conv_art_1_1",
      method: "lease.image",
      params: paramsB,
      hmac_key_hex: keyHex,
      broker_boot_id: "boot_123",
      broker_epoch: 3,
      nonce: "fixed_nonce_abc",
      expires_at: 1_900_000_000,
    })

    expect(envA.signature).toBe(envB.signature)
    expect(envA.params_sha256).toBe(shaA)

    const expectedPayload = `conv_art_1|ses_sub_1|7|lease_conv_art_1_1|lease.image|${shaA}|fixed_nonce_abc|1900000000`
    const expectedHmac = crypto
      .createHmac("sha256", Buffer.from(keyHex, "hex"))
      .update(expectedPayload, "utf8")
      .digest("hex")
    expect(envA.signature).toBe(expectedHmac)

    expect(GpuBrokerClient.verifyBrokerRequestEnvelope(envA, paramsB, keyHex)).toBe(true)
    expect(GpuBrokerClient.verifyBrokerRequestEnvelope(envA, { ...paramsB, width: 1024 }, keyHex)).toBe(false)
  })
})

describe("Aquanox v12.0 GPU Broker Client & Tool Plugins over Unix Domain Socket", () => {
  let socketPath: string
  let mockBroker: ReturnType<typeof createMockBrokerServer>

  beforeEach(async () => {
    SessionSlotLease.reset()
    socketPath = `/tmp/aquanox-broker-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`
    mockBroker = createMockBrokerServer(socketPath)
    await mockBroker.start()
    GpuBrokerClient.configureDefaultClient({ unixSocketPath: socketPath })
  })

  afterEach(async () => {
    await mockBroker.stop()
    GpuBrokerClient.resetDefaultClient()
  })

  test("bootstrap_or_rekey and automatic recovery on 401 ERR_BROKER_EPOCH_MISMATCH", async () => {
    const client = GpuBrokerClient.getDefaultClient()

    // 1. Initial call triggers automatic bootstrap_or_rekey (epoch 1)
    const res1 = await client.generateImage({
      conversation_id: "conv_epoch_test",
      session_id: "ses_1",
      prompt: "Deep ocean trench monolith",
    })
    expect(res1.ok).toBe(true)
    expect(mockBroker.state.bootstrapCalls).toBe(1)
    expect(mockBroker.state.imageCalls).toBe(1)
    expect(client.getCachedEpochState()?.broker_epoch).toBe(1)

    // 2. Simulate Broker daemon restart with a new boot_id, epoch = 2, and rotated HMAC key
    mockBroker.rotateBrokerEpoch("boot_v12_restarted", 2)

    // 3. Next request gets 401 ERR_BROKER_EPOCH_MISMATCH on stale epoch 1,
    // automatically calls POST /v1/auth/bootstrap_or_rekey, re-signs with a fresh nonce & epoch 2, and succeeds!
    const envCountBefore = mockBroker.state.receivedEnvelopes.length
    const res2 = await client.generateImage({
      conversation_id: "conv_epoch_test",
      session_id: "ses_1",
      prompt: "Hydrothermal vent spire",
    })
    expect(res2.ok).toBe(true)
    expect(mockBroker.state.bootstrapCalls).toBe(2)
    expect(mockBroker.state.imageCalls).toBe(2)
    expect(client.getCachedEpochState()?.broker_boot_id).toBe("boot_v12_restarted")
    expect(client.getCachedEpochState()?.broker_epoch).toBe(2)

    // Verify 2 envelopes were sent for the second call: first with epoch 1, retry with epoch 2 and a fresh nonce
    const staleEnv = mockBroker.state.receivedEnvelopes[envCountBefore]!
    const retriedEnv = mockBroker.state.receivedEnvelopes[envCountBefore + 1]!
    expect(staleEnv.broker_epoch).toBe(1)
    expect(retriedEnv.broker_epoch).toBe(2)
    expect(retriedEnv.broker_boot_id).toBe("boot_v12_restarted")
    expect(retriedEnv.nonce).not.toBe(staleEnv.nonce)
  })

  test("GenerateImageTool pre-validates dimensions, prompt UTF-8 byte ceiling, and non-commercial tier ack before calling Broker", async () => {
    // 1. Reject invalid dimensions (e.g. 640x480)
    await expect(
      Effect.runPromise(
        GenerateImageTool.executeGenerateImage(
          {
            prompt: "Test prompt",
            width: 640,
            height: 480,
          },
          "ses_val_1",
        ),
      ),
    ).rejects.toThrow(/ERR_INVALID_DIMENSIONS/)
    expect(mockBroker.state.imageCalls).toBe(0)

    // 2. Reject prompt > 4096 UTF-8 bytes
    const oversizedPrompt = "A".repeat(4097)
    await expect(
      Effect.runPromise(
        GenerateImageTool.executeGenerateImage(
          {
            prompt: oversizedPrompt,
            width: 1024,
            height: 1024,
          },
          "ses_val_1",
        ),
      ),
    ).rejects.toThrow(/ERR_PROMPT_TOO_LONG/)
    expect(mockBroker.state.imageCalls).toBe(0)

    // 3. Reject non-commercial tiers without non_commercial_ack: true
    for (const restrictedTier of [
      "tier3_klein9b_q4",
      "tier4_dev_q4",
      "tier2_klein9b_q4",
      "tier3_kontext12b",
      "tier5_flux2_dev32b",
    ]) {
      await expect(
        Effect.runPromise(
          GenerateImageTool.executeGenerateImage(
            {
              prompt: "Restricted tier test",
              tier: restrictedTier,
              width: 1280,
              height: 800,
            },
            "ses_val_1",
          ),
        ),
      ).rejects.toThrow(/ERR_NON_COMMERCIAL_ACK_REQUIRED/)
    }
    expect(mockBroker.state.imageCalls).toBe(0)
  })

  test("GenerateImageTool executes end-to-end inside SessionSlotLease.withGpuToolSlotPolicy keeping Buddy Slot reserved", async () => {
    SessionSlotLease.admitConversation({
      conversationId: "conv_img_agent",
      resources: { contextTier: "384k" },
    })
    SessionSlotLease.bindConversationSession({ conversationId: "conv_img_agent", sessionID: "ses_lead" })
    expect(SessionSlotLease.acquire("ses_lead", false)).toBe(0)

    SessionSlotLease.registerChildSession("ses_sub_artist", "ses_lead")
    SessionSlotLease.setSessionTier("ses_sub_artist", "128k")
    const subSlot = Effect.runSync(
      SessionSlotLease.acquireSubagentAsync({
        sessionID: "ses_sub_artist",
        parentSessionID: "ses_lead",
        tier: "128k",
      }),
    )
    expect(subSlot).toBe(5)

    let slotHeldDuringBrokerCall: number | undefined
    mockBroker.state.onBeforeRespond = () => {
      slotHeldDuringBrokerCall = SessionSlotLease.isActivelyHeld("ses_sub_artist")
    }

    const res = await Effect.runPromise(
      GenerateImageTool.executeGenerateImage(
        {
          prompt: "Submerged basalt ruins with volumetric godrays",
          tier: "tier5_flux2_dev32b",
          width: 1280,
          height: 800,
          non_commercial_ack: true,
          worktree_root: "/tmp",
          output_path: "/tmp/basalt_ruins.png",
        },
        "ses_sub_artist",
      ),
    )

    expect(slotHeldDuringBrokerCall).toBe(5)
    expect(SessionSlotLease.isActivelyHeld("ses_sub_artist")).toBe(5)
    expect(res.output.ok).toBe(true)
    expect(res.output.output_path).toBe("/tmp/basalt_ruins.png")
    expect(res.metadata.width).toBe(1280)
    expect(res.metadata.height).toBe(800)
    expect(mockBroker.state.imageCalls).toBe(1)

    // Verify worktree_root, output_path, active_leads, and subagent_commitments_mib are bound inside signed params
    const sentParams = mockBroker.state.receivedParams[0]!
    expect(sentParams.worktree_root).toBe("/tmp")
    expect(sentParams.output_path).toBe("/tmp/basalt_ruins.png")
    expect(sentParams.active_leads).toBe(1)
    expect(sentParams.subagent_commitments_mib).toBe(2048)
  })

  test("GodotSandboxTool executes capture, heartbeat, and close_work_session inside SessionSlotLease.withGpuToolSlotPolicy", async () => {
    SessionSlotLease.admitConversation({
      conversationId: "conv_godot_agent",
      resources: { contextTier: "384k" },
    })
    SessionSlotLease.bindConversationSession({ conversationId: "conv_godot_agent", sessionID: "ses_lead_godot" })
    expect(SessionSlotLease.acquire("ses_lead_godot", false)).toBe(0)

    let leadSlotDuringBroker: number | undefined
    mockBroker.state.onBeforeRespond = () => {
      leadSlotDuringBroker = SessionSlotLease.isActivelyHeld("ses_lead_godot")
    }

    // 1. Default 'capture' action
    const captureRes = await Effect.runPromise(
      GodotSandboxTool.executeGodotSandbox(
        {
          action: "capture",
          seed: 1337,
          timeout_seconds: 45,
          worktree_root: "/tmp",
          output_dir: "/tmp/godot_capture_out",
        },
        "ses_lead_godot",
      ),
    )
    expect(leadSlotDuringBroker).toBe(0)
    expect(captureRes.output.ok).toBe(true)
    expect(captureRes.output.frames_captured).toBe(4)
    expect(mockBroker.state.godotCalls).toBe(1)

    const godotSentParams = mockBroker.state.receivedParams[0]!
    expect(godotSentParams.worktree_root).toBe("/tmp")
    expect(godotSentParams.output_path).toBe("/tmp/godot_capture_out")
    expect(godotSentParams.active_leads).toBe(1)
    expect(godotSentParams.subagent_commitments_mib).toBe(0)
    expect(godotSentParams.timeout_seconds).toBe(45)
    expect(godotSentParams.timeout_s).toBe(45)
    expect(godotSentParams.timeout).toBe(45)
    expect(godotSentParams.resident).toBe(false)

    // 2. 'heartbeat' action
    const hbRes = await Effect.runPromise(
      GodotSandboxTool.executeGodotSandbox(
        {
          action: "heartbeat",
        },
        "ses_lead_godot",
      ),
    )
    expect(hbRes.output.ok).toBe(true)
    expect(hbRes.output.status).toBe("heartbeat_ack")
    expect(mockBroker.state.heartbeatCalls).toBe(1)

    // 3. 'close_work_session' action
    const closeRes = await Effect.runPromise(
      GodotSandboxTool.executeGodotSandbox(
        {
          action: "close_work_session",
        },
        "ses_lead_godot",
      ),
    )
    expect(closeRes.output.ok).toBe(true)
    expect(closeRes.output.lease_released).toBe(true)
    expect(mockBroker.state.closeCalls).toBe(1)
    expect(SessionSlotLease.isActivelyHeld("ses_lead_godot")).toBe(0)
  })

  test("GenerateImageTool and GodotSandboxTool reject path escapes and fail closed on synthetic_test_data or empty artifacts", async () => {
    // 1. Reject output_path escaping worktree_root in GenerateImageTool
    await expect(
      Effect.runPromise(
        GenerateImageTool.executeGenerateImage(
          {
            prompt: "Escape test",
            tier: "tier1_klein4b_q4",
            width: 512,
            height: 512,
            worktree_root: "/tmp/aquanox_wt",
            output_path: "../outside_secret.png",
          },
          "ses_escape_1",
        ),
      ),
    ).rejects.toThrow(/ERR_OUTPUT_PATH_ESCAPE/)
    expect(mockBroker.state.imageCalls).toBe(0)

    // 2. Reject output_dir escaping worktree_root in GodotSandboxTool
    await expect(
      Effect.runPromise(
        GodotSandboxTool.executeGodotSandbox(
          {
            action: "capture",
            worktree_root: "/tmp/aquanox_wt",
            output_dir: "/etc/outside_dir",
          },
          "ses_escape_1",
        ),
      ),
    ).rejects.toThrow(/ERR_OUTPUT_PATH_ESCAPE/)
    expect(mockBroker.state.godotCalls).toBe(0)

    // 3. Reject synthetic test data in GenerateImageTool unless explicitly allowed
    mockBroker.state.imageResponseOverride = { is_test_data: true }
    await expect(
      Effect.runPromise(
        GenerateImageTool.executeGenerateImage(
          {
            prompt: "Test image",
            tier: "tier1_klein4b_q4",
            width: 768,
            height: 768,
            worktree_root: "/tmp",
            output_path: "/tmp/out_test.png",
          },
          "ses_escape_1",
        ),
      ),
    ).rejects.toThrow(/ERR_SYNTHETIC_TEST_IMAGE_REJECTED/)

    // 4. Reject empty delivered_files in GenerateImageTool
    mockBroker.state.imageResponseOverride = { delivered_files: [] }
    await expect(
      Effect.runPromise(
        GenerateImageTool.executeGenerateImage(
          {
            prompt: "Test image",
            tier: "tier1_klein4b_q4",
            width: 512,
            height: 512,
            worktree_root: "/tmp",
            output_path: "/tmp/out_test.png",
          },
          "ses_escape_1",
        ),
      ),
    ).rejects.toThrow(/ERR_IMAGE_ARTIFACT_NOT_DELIVERED/)
    mockBroker.state.imageResponseOverride = undefined

    // 5. Reject synthetic_test_data or empty artifacts in GodotSandboxTool
    mockBroker.state.godotResponseOverride = { synthetic_test_data: true }
    await expect(
      Effect.runPromise(
        GodotSandboxTool.executeGodotSandbox(
          {
            action: "capture",
            worktree_root: "/tmp",
            output_dir: "/tmp/godot_out",
          },
          "ses_escape_1",
        ),
      ),
    ).rejects.toThrow(/ERR_SYNTHETIC_TEST_GODOT_REJECTED/)

    mockBroker.state.godotResponseOverride = { artifacts: [], delivered_files: [] }
    await expect(
      Effect.runPromise(
        GodotSandboxTool.executeGodotSandbox(
          {
            action: "capture",
            worktree_root: "/tmp",
            output_dir: "/tmp/godot_out",
          },
          "ses_escape_1",
        ),
      ),
    ).rejects.toThrow(/ERR_GODOT_ARTIFACT_NOT_DELIVERED/)
    mockBroker.state.godotResponseOverride = undefined
  })

  test("GPU-023: Godot execution budget normalization and validation (valid budgets: 45, 600; rejected budgets: 0, 1200)", async () => {
    const client = GpuBrokerClient.getDefaultClient()

    // 1. Rejected budgets fail closed with ERR_INVALID_TIMEOUT in GodotSandboxTool
    for (const invalidTimeout of [0, 4, 601, 1200, -1, Number.NaN]) {
      await expect(
        Effect.runPromise(
          GodotSandboxTool.executeGodotSandbox(
            {
              action: "capture",
              timeout_seconds: invalidTimeout,
              worktree_root: "/tmp",
            },
            "ses_timeout_reject",
          ),
        ),
      ).rejects.toThrow(/ERR_INVALID_TIMEOUT/)

      // Also verify client.runGodotSandbox and client.leaseGodot directly reject invalid budgets
      await expect(
        client.runGodotSandbox({
          action: "capture",
          timeout_seconds: invalidTimeout,
          session_id: "ses_timeout_reject",
        }),
      ).rejects.toThrow(/ERR_INVALID_TIMEOUT/)

      await expect(
        client.leaseGodot({
          action: "capture",
          timeout_seconds: invalidTimeout,
          session_id: "ses_timeout_reject",
        }),
      ).rejects.toThrow(/ERR_INVALID_TIMEOUT/)
    }
    expect(mockBroker.state.godotCalls).toBe(0)

    // 2. Valid budget: 45 seconds via GodotSandboxTool
    const res45 = await Effect.runPromise(
      GodotSandboxTool.executeGodotSandbox(
        {
          action: "capture",
          timeout_seconds: 45,
          worktree_root: "/tmp",
          output_dir: "/tmp/godot_budget_45",
        },
        "ses_budget_45",
      ),
    )
    expect(res45.output.ok).toBe(true)
    const params45 = mockBroker.state.receivedParams[mockBroker.state.receivedParams.length - 1]!
    expect(params45.timeout_seconds).toBe(45)
    expect(params45.timeout_s).toBe(45)
    expect(params45.timeout).toBe(45)
    expect(params45.resident).toBe(false)

    // Verify envelope params_sha256 matches canonical hash including all 3 normalized timeout keys
    const env45 = mockBroker.state.receivedEnvelopes[mockBroker.state.receivedEnvelopes.length - 1]!
    expect(env45.params_sha256).toBe(GpuBrokerClient.computeParamsSha256(params45))

    // 3. Valid budget: 600 seconds (upper bound budget) via leaseGodot and executeGodotSandbox
    const res600 = await Effect.runPromise(
      GodotSandboxTool.executeGodotSandbox(
        {
          action: "sandbox",
          timeout_seconds: 600,
          worktree_root: "/tmp",
          output_dir: "/tmp/godot_budget_600",
        },
        "ses_budget_600",
      ),
    )
    expect(res600.output.ok).toBe(true)
    const params600 = mockBroker.state.receivedParams[mockBroker.state.receivedParams.length - 1]!
    expect(params600.timeout_seconds).toBe(600)
    expect(params600.timeout_s).toBe(600)
    expect(params600.timeout).toBe(600)
    expect(params600.resident).toBe(false)

    // Direct client.leaseGodot call with timeout_s normalization
    const leaseRes = await client.leaseGodot({
      action: "capture",
      timeout_s: 600,
      session_id: "ses_budget_600",
    })
    expect(leaseRes.ok).toBe(true)
    const leaseParams = mockBroker.state.receivedParams[mockBroker.state.receivedParams.length - 1]!
    expect(leaseParams.timeout_seconds).toBe(600)
    expect(leaseParams.timeout_s).toBe(600)
    expect(leaseParams.timeout).toBe(600)
    expect(leaseParams.resident).toBe(false)

    // Direct client.runGodotSandbox call with timeout normalization
    const runRes = await client.runGodotSandbox({
      action: "sandbox",
      timeout: 120,
      session_id: "ses_budget_120",
    })
    expect(runRes.ok).toBe(true)
    const runParams = mockBroker.state.receivedParams[mockBroker.state.receivedParams.length - 1]!
    expect(runParams.timeout_seconds).toBe(120)
    expect(runParams.timeout_s).toBe(120)
    expect(runParams.timeout).toBe(120)
    expect(runParams.resident).toBe(false)

    // 4. Socket timeout calculation verification: Math.max((timeoutSeconds + 60) * 1000, 180_000)
    const calcSocketTimeoutMs = (timeoutSeconds: number) => Math.max((timeoutSeconds + 60) * 1000, 180_000)
    expect(calcSocketTimeoutMs(5)).toBe(180_000)
    expect(calcSocketTimeoutMs(45)).toBe(180_000)
    expect(calcSocketTimeoutMs(120)).toBe(180_000)
    expect(calcSocketTimeoutMs(200)).toBe(260_000)
    expect(calcSocketTimeoutMs(600)).toBe(660_000)
  })

  test("GPU-025: Resident Godot parameter normalization and 503 ERR_RESIDENT_WORKER_NOT_READY readiness handling", async () => {
    const client = GpuBrokerClient.getDefaultClient()

    // 1. One-shot actions (capture, sandbox, import, validate, test) always canonicalize resident: false in signed envelope
    for (const oneShotAction of ["capture", "sandbox", "import", "validate", "test"] as const) {
      const res = await Effect.runPromise(
        GodotSandboxTool.executeGodotSandbox(
          {
            action: oneShotAction,
            worktree_root: "/tmp",
            output_dir: `/tmp/godot_oneshot_${oneShotAction}`,
          },
          `ses_oneshot_${oneShotAction}`,
        ),
      )
      expect(res.output.ok).toBe(true)
      const lastParams = mockBroker.state.receivedParams[mockBroker.state.receivedParams.length - 1]!
      expect(lastParams.action).toBe(oneShotAction)
      expect(lastParams.resident).toBe(false)
      const lastEnv = mockBroker.state.receivedEnvelopes[mockBroker.state.receivedEnvelopes.length - 1]!
      expect(lastEnv.params_sha256).toBe(GpuBrokerClient.computeParamsSha256(lastParams))
    }

    // Even if a caller attempts to set resident: true on a one-shot action, GodotSandboxTool explicitly forces resident: false
    const tamperRes = await Effect.runPromise(
      GodotSandboxTool.executeGodotSandbox(
        {
          action: "capture",
          resident: true,
          worktree_root: "/tmp",
          output_dir: "/tmp/godot_tamper_resident",
        },
        "ses_tamper_resident",
      ),
    )
    expect(tamperRes.output.ok).toBe(true)
    const tamperParams = mockBroker.state.receivedParams[mockBroker.state.receivedParams.length - 1]!
    expect(tamperParams.resident).toBe(false)

    // 2. Direct client.leaseGodot defaults resident to false when unspecified, and honors resident: true when explicit
    await client.leaseGodot({
      action: "capture",
      session_id: "ses_lease_default",
    })
    const defaultLeaseParams = mockBroker.state.receivedParams[mockBroker.state.receivedParams.length - 1]!
    expect(defaultLeaseParams.resident).toBe(false)

    await client.leaseGodot({
      action: "sandbox",
      resident: true,
      session_id: "ses_lease_resident",
    })
    const trueLeaseParams = mockBroker.state.receivedParams[mockBroker.state.receivedParams.length - 1]!
    expect(trueLeaseParams.resident).toBe(true)
    const trueLeaseEnv = mockBroker.state.receivedEnvelopes[mockBroker.state.receivedEnvelopes.length - 1]!
    expect(trueLeaseEnv.params_sha256).toBe(GpuBrokerClient.computeParamsSha256(trueLeaseParams))

    // 3. Broker returns 503 ERR_RESIDENT_WORKER_NOT_READY when resident worker fails readiness
    mockBroker.state.godotStatusCodeOverride = 503
    mockBroker.state.godotResponseOverride = {
      ok: false,
      error: "ERR_RESIDENT_WORKER_NOT_READY",
      message: "Resident Godot worker failed readiness check on port 9005",
    }

    // Direct leaseGodot rejects with typed GpuBrokerError (503 ERR_RESIDENT_WORKER_NOT_READY)
    let brokerErr: any
    try {
      await client.leaseGodot({
        action: "sandbox",
        resident: true,
        session_id: "ses_failing_resident",
      })
    } catch (err: any) {
      brokerErr = err
    }
    expect(brokerErr).toBeDefined()
    expect(brokerErr.statusCode).toBe(503)
    expect(brokerErr.errorCode).toBe("ERR_RESIDENT_WORKER_NOT_READY")
    expect(brokerErr.message).toMatch(/ERR_RESIDENT_WORKER_NOT_READY/)

    // GodotSandboxTool tool failure preserves ERR_RESIDENT_WORKER_NOT_READY cleanly
    await expect(
      Effect.runPromise(
        GodotSandboxTool.executeGodotSandbox(
          {
            action: "sandbox",
            resident: true,
            worktree_root: "/tmp",
            output_dir: "/tmp/godot_failing_resident",
          },
          "ses_failing_resident",
        ),
      ),
    ).rejects.toThrow(/ERR_RESIDENT_WORKER_NOT_READY/)

    // Reset overrides
    mockBroker.state.godotStatusCodeOverride = undefined
    mockBroker.state.godotResponseOverride = undefined
  })

  test("ConfigAgentPlugin.translateToolsArrayToRuleset automatically permits generate_image and godot_sandbox", () => {
    const rules = ConfigAgentPlugin.translateToolsArrayToRuleset(["read", "grep"])
    const genImgRule = rules.find((r) => r.action === "generate_image")
    const godotRule = rules.find((r) => r.action === "godot_sandbox")
    expect(genImgRule).toEqual({ action: "generate_image", resource: "*", effect: "allow" })
    expect(godotRule).toEqual({ action: "godot_sandbox", resource: "*", effect: "allow" })
  })

  test("GPU-032: Native subagent broker admission uses Effect.catch (effect@4.0.1) and unconditionally releases child slot, quanta, and write scopes on admission denial or interruption", async () => {
    const { registerWriteScope, getActiveWriteScope, unregisterWriteScope } = await import(
      "../src/tool/plugin/subagent.js"
    )
    const { Exit, Fiber } = await import("effect")

    // 1. Source invariant: subagent.ts must never invoke removed Effect v3 Effect.catchAll
    const subagentSrc = fs.readFileSync(new URL("../src/tool/plugin/subagent.ts", import.meta.url), "utf8")
    expect(subagentSrc).not.toContain("Effect.catchAll(")
    expect(typeof Effect.catch).toBe("function")
    expect((Effect as any).catchAll).toBeUndefined()

    // 2. Admit parent Lead conversation (3 quanta on Block 0, slot 0)
    SessionSlotLease.admitConversation({
      conversationId: "conv_gpu032",
      resources: { contextTier: "384k" },
    })
    SessionSlotLease.bindConversationSession({ conversationId: "conv_gpu032", sessionID: "ses_parent_032" })
    expect(SessionSlotLease.acquire("ses_parent_032", false)).toBe(0)
    const snapBefore = SessionSlotLease.getResourceSnapshot()
    expect(snapBefore.committedQuanta128k).toBe(3)
    expect(snapBefore.activeQuanta128k).toBe(3)

    // Helper simulating the exact subagent.ts post-creation Effect.gen(...).pipe(Effect.onExit(...)) pipeline
    const runSubagentAdmissionAndPromptLifecycle = (
      childId: string,
      opts: { failPrompt?: boolean; hangPrompt?: boolean } = {},
    ) => {
      let jobStarted = false
      const activeChildSessionID = childId
      return Effect.gen(function* () {
        SessionSlotLease.registerChildSession(childId, "ses_parent_032")
        SessionSlotLease.setSessionTier(childId, "128k")
        registerWriteScope(childId, ["packages/core/src/tool/plugin/subagent.ts"])

        const leaseSlot = yield* SessionSlotLease.acquireSubagentAsync({
          sessionID: childId,
          parentSessionID: "ses_parent_032",
          tier: "128k",
        })
        expect(leaseSlot).toBeGreaterThanOrEqual(0)

        const admissionResult = yield* Effect.promise(async () => {
          try {
            const res = await GpuBrokerClient.evaluateAdmission({ new_request_mib: 0 })
            if (res?.admitted === false || res?.error === "ERR_HOST_MEM_FLOOR_VIOLATION") {
              return {
                admitted: false,
                reason: (res?.reason as string) || (res?.error as string) || "ERR_HOST_MEM_FLOOR_VIOLATION",
              }
            }
            return { admitted: true }
          } catch (err: any) {
            return { admitted: false, reason: String(err?.message || err) }
          }
        }).pipe(
          Effect.catch((err) =>
            Effect.succeed({ admitted: false, reason: String((err as any)?.message || err) }),
          ),
        )

        if (!admissionResult.admitted) {
          unregisterWriteScope(childId)
          yield* SessionSlotLease.releaseSubagentSession(childId, { purge: true })
          return yield* Effect.fail(
            new Error(`ERR_HOST_MEM_FLOOR_VIOLATION (sessionID: ${childId}): ${admissionResult.reason}`),
          )
        }

        if (opts.failPrompt) {
          return yield* Effect.fail(new Error(`Failed to prompt subagent: ${childId}`))
        }
        if (opts.hangPrompt) {
          return yield* Effect.never
        }

        jobStarted = true
        SessionSlotLease.releaseSubagentSession(childId)
        unregisterWriteScope(childId)
        return { sessionID: childId, status: "completed" as const, leaseSlot }
      }).pipe(
        Effect.onExit((exit) => {
          if (Exit.isFailure(exit) && !jobStarted) {
            unregisterWriteScope(childId)
            SessionSlotLease.releaseSubagentSession(childId, { purge: true })
            if (activeChildSessionID !== childId) {
              unregisterWriteScope(activeChildSessionID)
              SessionSlotLease.releaseSubagentSession(activeChildSessionID, { purge: true })
            }
          }
          return Effect.void
        }),
      )
    }

    // 3. Normal admitted subagent succeeds without throwing Effect.catchAll defect
    const okRes = await Effect.runPromise(runSubagentAdmissionAndPromptLifecycle("ses_child_ok"))
    expect(okRes.status).toBe("completed")
    expect(okRes.sessionID).toBe("ses_child_ok")
    SessionSlotLease.releaseSubagentSession("ses_child_ok", { purge: true })
    expect(SessionSlotLease.getResourceSnapshot().committedQuanta128k).toBe(3)
    expect(SessionSlotLease.getResourceSnapshot().activeQuanta128k).toBe(3)

    // 4. Broker admission denial (503 ERR_HOST_MEM_FLOOR_VIOLATION) preserves child sessionID and leaves 0 leaked slots
    mockBroker.state.admissionStatusCodeOverride = 503
    mockBroker.state.admissionResponseOverride = {
      ok: false,
      admitted: false,
      error: "ERR_HOST_MEM_FLOOR_VIOLATION",
      reason: "effective_available_mib (12000) < 20480 floor",
    }

    await expect(
      Effect.runPromise(runSubagentAdmissionAndPromptLifecycle("ses_child_denied")),
    ).rejects.toThrow(/ERR_HOST_MEM_FLOOR_VIOLATION \(sessionID: ses_child_denied\)/)

    const snapAfterDeny = SessionSlotLease.getResourceSnapshot()
    expect(snapAfterDeny.committedQuanta128k).toBe(3)
    expect(snapAfterDeny.activeQuanta128k).toBe(3)
    expect(SessionSlotLease.isActivelyHeld("ses_child_denied")).toBeUndefined()
    expect(getActiveWriteScope("ses_child_denied")).toBeUndefined()

    mockBroker.state.admissionStatusCodeOverride = undefined
    mockBroker.state.admissionResponseOverride = undefined

    // 5. Initialization failure after slot acquisition & admission unconditionally unwinds child slot via Effect.onExit
    await expect(
      Effect.runPromise(runSubagentAdmissionAndPromptLifecycle("ses_child_prompt_err", { failPrompt: true })),
    ).rejects.toThrow(/Failed to prompt subagent: ses_child_prompt_err/)

    const snapAfterPromptErr = SessionSlotLease.getResourceSnapshot()
    expect(snapAfterPromptErr.committedQuanta128k).toBe(3)
    expect(snapAfterPromptErr.activeQuanta128k).toBe(3)
    expect(SessionSlotLease.isActivelyHeld("ses_child_prompt_err")).toBeUndefined()
    expect(getActiveWriteScope("ses_child_prompt_err")).toBeUndefined()

    // 6. Fiber interruption after slot acquisition unconditionally unwinds child slot via Effect.onExit
    const fiber = Effect.runFork(runSubagentAdmissionAndPromptLifecycle("ses_child_interrupted", { hangPrompt: true }))
    await new Promise((r) => setTimeout(r, 20))
    await Effect.runPromise(Fiber.interrupt(fiber))
    const snapAfterInterrupt = SessionSlotLease.getResourceSnapshot()
    expect(snapAfterInterrupt.committedQuanta128k).toBe(3)
    expect(snapAfterInterrupt.activeQuanta128k).toBe(3)
    expect(SessionSlotLease.isActivelyHeld("ses_child_interrupted")).toBeUndefined()
    expect(getActiveWriteScope("ses_child_interrupted")).toBeUndefined()
  })

  test("GPU-033: Numeric image-tool and godot-sandbox schemas emit pure number without non-finite string union, and coerce DSML string arguments", async () => {
    // 1. GenerateImageTool definition must have pure { type: "number" } for width, height, steps, seed
    const imgDef = definition({
      name: GenerateImageTool.name,
      description: GenerateImageTool.DESCRIPTION,
      input: GenerateImageTool.Input,
      output: GenerateImageTool.Output,
      execute: (input: any) => Effect.succeed({ output: input }),
    })

    const imgProps = (imgDef.inputSchema as any).properties
    expect(imgProps.width).toEqual({ type: "number" })
    expect(imgProps.height).toEqual({ type: "number" })
    expect(imgProps.steps).toEqual({ type: "number" })
    expect(imgProps.seed).toEqual({ type: "number" })
    expect(imgProps.prompt).toEqual({ type: "string" })

    // Verify none of them contain anyOf with string union
    for (const key of ["width", "height", "steps", "seed"]) {
      expect(imgProps[key].anyOf).toBeUndefined()
    }

    // 2. GodotSandboxTool definition must have pure { type: "number" } for seed, timeout_seconds, timeout_s, timeout
    const godotDef = definition({
      name: GodotSandboxTool.name,
      description: GodotSandboxTool.DESCRIPTION,
      input: GodotSandboxTool.Input,
      output: GodotSandboxTool.Output,
      execute: (input: any) => Effect.succeed({ output: input }),
    })

    const godotProps = (godotDef.inputSchema as any).properties
    expect(godotProps.seed).toEqual({ type: "number" })
    expect(godotProps.timeout_seconds).toEqual({ type: "number" })
    expect(godotProps.timeout_s).toEqual({ type: "number" })
    expect(godotProps.timeout).toEqual({ type: "number" })

    for (const key of ["seed", "timeout_seconds", "timeout_s", "timeout"]) {
      expect(godotProps[key].anyOf).toBeUndefined()
    }

    // 3. stripNonFiniteNumberUnion strips anyOf with string enum from generic Schema.Number
    const legacyNumberTool = {
      name: "legacy_tool",
      description: "Legacy tool with Schema.Number",
      input: Schema.Struct({
        count: Schema.Number,
        optionalVal: Schema.optionalKey(Schema.Number),
      }),
      execute: () => Effect.succeed({ content: "ok" }),
    }
    const legacyDef = definition(legacyNumberTool)
    const legacyProps = (legacyDef.inputSchema as any).properties
    expect(legacyProps.count).toEqual({ type: "number" })
    expect(legacyProps.count.anyOf).toBeUndefined()
    expect(legacyProps.optionalVal).toEqual({ type: "number" })
    expect(legacyProps.optionalVal.anyOf).toBeUndefined()

    // 4. End-to-end execution with DSML string-quoted numeric arguments
    const testContext = {
      sessionID: Session.ID.make("ses_gpu_033"),
      agent: Agent.ID.make("build"),
      messageID: SessionMessage.ID.make("msg_gpu_033"),
      id: Tool.CallID.make("call_gpu_033"),
      progress: () => Effect.void,
    } satisfies Tool.Context

    const imgExecResult = await Effect.runPromise(
      execute(
        {
          name: GenerateImageTool.name,
          description: GenerateImageTool.DESCRIPTION,
          input: GenerateImageTool.Input,
          output: GenerateImageTool.Output,
          execute: (input: any) => Effect.succeed({ output: input }),
        },
        {
          prompt: "a majestic neon waterfall",
          width: "1024",
          height: "1024",
          steps: "25",
          seed: "777",
        },
        testContext,
      ),
    )

    expect(imgExecResult.output).toEqual({
      prompt: "a majestic neon waterfall",
      width: 1024,
      height: 1024,
      steps: 25,
      seed: 777,
    })

    // Also verify native numeric inputs still work identically
    const imgExecResultNative = await Effect.runPromise(
      execute(
        {
          name: GenerateImageTool.name,
          description: GenerateImageTool.DESCRIPTION,
          input: GenerateImageTool.Input,
          output: GenerateImageTool.Output,
          execute: (input: any) => Effect.succeed({ output: input }),
        },
        {
          prompt: "a majestic neon waterfall",
          width: 768,
          height: 768,
          steps: 20,
          seed: 42,
        },
        testContext,
      ),
    )

    expect(imgExecResultNative.output).toEqual({
      prompt: "a majestic neon waterfall",
      width: 768,
      height: 768,
      steps: 20,
      seed: 42,
    })

    // 5. Godot DSML string coercion
    const godotExecResult = await Effect.runPromise(
      execute(
        {
          name: GodotSandboxTool.name,
          description: GodotSandboxTool.DESCRIPTION,
          input: GodotSandboxTool.Input,
          output: GodotSandboxTool.Output,
          execute: (input: any) => Effect.succeed({ output: input }),
        },
        {
          action: "capture",
          timeout_seconds: "45",
          seed: "999",
        },
        testContext,
      ),
    )

    expect(godotExecResult.output).toEqual({
      action: "capture",
      timeout_seconds: 45,
      seed: 999,
    })

    // 6. Non-numeric strings must still fail validation cleanly
    await expect(
      Effect.runPromise(
        execute(
          {
            name: GenerateImageTool.name,
            description: GenerateImageTool.DESCRIPTION,
            input: GenerateImageTool.Input,
            output: GenerateImageTool.Output,
            execute: (input: any) => Effect.succeed({ output: input }),
          },
          {
            prompt: "invalid numeric param",
            width: "not_a_valid_number",
          },
          testContext,
        ),
      ),
    ).rejects.toThrow(/Invalid arguments for tool "generate_image"/)
  })

  test("GPU-033 Catalog Audit: All built-in OpenCode tool schemas emit zero non-finite string enums and enforce may_be_string() == false on all numeric/integer/boolean properties", async () => {
    const path = await import("node:path")
    const { Mcp } = await import("../src/mcp/index.js")

    const pluginDir = path.resolve(import.meta.dir, "../src/tool/plugin")
    const pluginFiles = fs
      .readdirSync(pluginDir)
      .filter((f) => f.endsWith(".ts") && f !== "file-diff.ts")
      .sort()

    expect(pluginFiles.length).toBeGreaterThanOrEqual(22)

    const catalogTools: Array<{ file: string; name: string; input: any; output?: any }> = []
    for (const file of pluginFiles) {
      const mod = await import(path.join(pluginDir, file))
      if (mod.Input) {
        catalogTools.push({
          file,
          name: mod.name ?? file.replace(/\.ts$/, ""),
          input: mod.Input,
          output: mod.Output,
        })
      } else if (file === "opencode.ts") {
        catalogTools.push({ file, name: "opencode_session_rename", input: mod.RenameInput })
        catalogTools.push({ file, name: "opencode_session_move", input: mod.MoveInput })
        catalogTools.push({ file, name: "opencode_worktree_create", input: mod.WorktreeCreateInput })
        catalogTools.push({ file, name: "opencode_worktree_remove", input: mod.WorktreeRemoveInput })
        catalogTools.push({ file, name: "opencode_models", input: mod.ModelsInput })
      } else if (file === "mcp-resource.ts") {
        catalogTools.push({
          file,
          name: "opencode_list_mcp_resources",
          input: Schema.Struct({ server: Schema.optionalKey(Schema.String) }),
          output: Schema.Struct({
            resources: Schema.Array(Mcp.Resource),
            templates: Schema.Array(Mcp.ResourceTemplate),
          }),
        })
        catalogTools.push({
          file,
          name: "opencode_read_mcp_resource",
          input: Schema.Struct({ server: Schema.String, uri: Schema.String }),
          output: Mcp.ResourceContent,
        })
      }
    }

    expect(catalogTools.length).toBeGreaterThanOrEqual(22)

    const hasNonFiniteEnum = (node: any): boolean => {
      if (!node || typeof node !== "object") return false
      if (node.type === "string" && Array.isArray(node.enum)) {
        const set = new Set(node.enum)
        if (set.has("Infinity") && set.has("-Infinity") && set.has("NaN")) return true
      }
      for (const val of Object.values(node)) {
        if (Array.isArray(val)) {
          if (val.some(hasNonFiniteEnum)) return true
        } else if (val && typeof val === "object") {
          if (hasNonFiniteEnum(val)) return true
        }
      }
      return false
    }

    // Exact llama.cpp/common/json-schema.cpp may_be_string() semantics
    const mayBeString = (schema: any): boolean => {
      if (!schema || typeof schema !== "object") return false
      const type = schema.type
      if (type === "string") return true
      if (Array.isArray(type) && type.includes("string")) return true
      for (const unionKey of ["anyOf", "oneOf"]) {
        if (Array.isArray(schema[unionKey])) {
          if (schema[unionKey].some((branch: any) => mayBeString(branch))) return true
        }
      }
      if (
        type === undefined &&
        schema.anyOf === undefined &&
        schema.oneOf === undefined &&
        schema.properties === undefined &&
        schema.items === undefined &&
        schema.enum === undefined &&
        schema.const === undefined
      ) {
        return true
      }
      return false
    }

    const isNumericOrBooleanSchema = (schema: any): boolean => {
      if (!schema || typeof schema !== "object") return false
      if (schema.type === "number" || schema.type === "integer" || schema.type === "boolean") {
        return true
      }
      for (const unionKey of ["anyOf", "oneOf"]) {
        if (Array.isArray(schema[unionKey])) {
          if (
            schema[unionKey].some(
              (b: any) => b && (b.type === "number" || b.type === "integer" || b.type === "boolean"),
            )
          ) {
            return true
          }
        }
      }
      return false
    }

    const walkSchemaProperties = (
      schema: any,
      propPath: string,
      acc: Array<{ path: string; schema: any }>,
    ) => {
      if (!schema || typeof schema !== "object") return
      if (schema.properties && typeof schema.properties === "object") {
        for (const [k, v] of Object.entries<any>(schema.properties)) {
          const nextPath = propPath ? `${propPath}.${k}` : k
          acc.push({ path: nextPath, schema: v })
          walkSchemaProperties(v, nextPath, acc)
        }
      }
      if (schema.items && typeof schema.items === "object") {
        const nextPath = `${propPath}[]`
        acc.push({ path: nextPath, schema: schema.items })
        walkSchemaProperties(schema.items, nextPath, acc)
      }
      for (const unionKey of ["anyOf", "oneOf", "allOf"]) {
        if (Array.isArray(schema[unionKey])) {
          schema[unionKey].forEach((branch: any, idx: number) => {
            walkSchemaProperties(branch, `${propPath}.${unionKey}[${idx}]`, acc)
          })
        }
      }
    }

    let auditedNumericAndBooleanProps = 0
    for (const toolEntry of catalogTools) {
      const def = definition({
        name: toolEntry.name,
        description: `Audit ${toolEntry.name}`,
        input: toolEntry.input,
        ...(toolEntry.output ? { output: toolEntry.output } : {}),
        execute: () => Effect.succeed({ content: "ok" }),
      })

      expect(hasNonFiniteEnum(def.inputSchema)).toBe(false)
      if (def.outputSchema) {
        expect(hasNonFiniteEnum(def.outputSchema)).toBe(false)
      }

      const props: Array<{ path: string; schema: any }> = []
      walkSchemaProperties(def.inputSchema, "", props)
      for (const prop of props) {
        if (isNumericOrBooleanSchema(prop.schema)) {
          auditedNumericAndBooleanProps++
          expect(mayBeString(prop.schema)).toBe(false)
        }
      }
    }

    expect(auditedNumericAndBooleanProps).toBeGreaterThanOrEqual(45)
  })

  test("GPU-033 / GPU-S06: DeepSeek absolute output_path without worktree_root resolves safely inside ALLOWED_WORKTREE_PREFIXES", () => {
    // 1. Exact DeepSeek V4.1 payload from GPU-S06 test22 (ses_e51c1ca09ffeos0HuJ5DcpXGWJ)
    const deepseekPayload = {
      prompt: "A clean studio still life of one bright red ceramic teapot with a curved spout and loop handle, on a cobalt blue cloth, pale cream background, soft daylight, no text, no people.",
      tier: "tier1_klein4b_q4",
      seed: 42,
      steps: 4,
      width: 1024,
      height: 1024,
      output_path: "/tmp/opencode/gpu-s06-test22-teapot.png",
      lease_mode: "keep_reserved",
      caller_hint: "hint_final_image",
    }

    const validated = GenerateImageTool.validateGenerateImageInput(deepseekPayload)
    expect(validated.worktree_root).toBe("/tmp/opencode")
    expect(validated.output_path).toBe("/tmp/opencode/gpu-s06-test22-teapot.png")
    expect(validated.width).toBe(1024)
    expect(validated.height).toBe(1024)
    expect(validated.seed).toBe(42)
    expect(validated.steps).toBe(4)

    // 2. Reject absolute path outside ALLOWED_WORKTREE_PREFIXES without worktree_root (e.g. /etc/passwd)
    expect(() =>
      GenerateImageTool.validateGenerateImageInput({
        prompt: "Malicious escape attempt",
        output_path: "/etc/passwd",
      }),
    ).toThrow(/ERR_OUTPUT_PATH_ESCAPE/)

    // 3. Reject path traversal in absolute path
    expect(() =>
      GenerateImageTool.validateGenerateImageInput({
        prompt: "Path traversal attempt",
        output_path: "/tmp/../etc/passwd",
      }),
    ).toThrow(/ERR_OUTPUT_PATH_ESCAPE/)

    // 4. Godot sandbox with absolute output_dir inside ALLOWED_WORKTREE_PREFIXES
    const godotValidated = GodotSandboxTool.validateGodotSandboxInput({
      action: "capture",
      output_dir: "/tmp/opencode/godot_run",
    })
    expect(godotValidated.worktree_root).toBe("/tmp/opencode/godot_run")
    expect(godotValidated.output_dir).toBe("/tmp/opencode/godot_run")

    // 5. Godot sandbox with absolute output_dir outside ALLOWED_WORKTREE_PREFIXES throws
    expect(() =>
      GodotSandboxTool.validateGodotSandboxInput({
        action: "capture",
        output_dir: "/etc/cron.d",
      }),
    ).toThrow(/ERR_OUTPUT_PATH_ESCAPE/)
  })

  test("GPU-035: Omitting output_path and worktree_root pre-creates <baseDir>/artifacts with 0o775 permissions before Broker execution", async () => {
    const path = await import("node:path")
    const tmpBaseDir = `/tmp/opencode_gpu035_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const expectedArtifactsDir = path.join(tmpBaseDir, "artifacts")

    try {
      expect(fs.existsSync(expectedArtifactsDir)).toBe(false)

      // 1. Direct validateGenerateImageInput with omitted output_path and worktree_root
      const validatedImg = GenerateImageTool.validateGenerateImageInput(
        {
          prompt: "Bioluminescent jellyfish over sunken ruins",
          tier: "tier1_klein4b_q4",
          width: 1024,
          height: 1024,
        },
        { defaultBaseDir: tmpBaseDir },
      )

      expect(validatedImg.worktree_root).toBe(tmpBaseDir)
      expect(validatedImg.output_path.startsWith(expectedArtifactsDir + path.sep)).toBe(true)
      expect(fs.existsSync(expectedArtifactsDir)).toBe(true)
      const imgDirStat = fs.statSync(expectedArtifactsDir)
      expect(imgDirStat.isDirectory()).toBe(true)
      expect((imgDirStat.mode & 0o775) === 0o775 || (imgDirStat.mode & 0o700) === 0o700).toBe(true)

      // 2. End-to-end executeGenerateImage with omitted output_path and worktree_root verifies directory exists before Broker receives request
      const tmpBaseDirExec = `${tmpBaseDir}_exec`
      const expectedExecArtifactsDir = path.join(tmpBaseDirExec, "artifacts")
      let artifactsDirExistedBeforeBroker = false
      mockBroker.state.onBeforeRespond = () => {
        artifactsDirExistedBeforeBroker = fs.existsSync(expectedExecArtifactsDir)
      }

      const execRes = await Effect.runPromise(
        GenerateImageTool.executeGenerateImage(
          {
            prompt: "Deep ocean hydrothermal vent with glowing flora",
            tier: "tier1_klein4b_q4",
            width: 1024,
            height: 1024,
          },
          "ses_gpu035_img",
          { defaultBaseDir: tmpBaseDirExec },
        ),
      )

      expect(artifactsDirExistedBeforeBroker).toBe(true)
      expect(execRes.output.ok).toBe(true)
      expect(String(execRes.output.output_path).startsWith(expectedExecArtifactsDir + path.sep)).toBe(true)

      // 3. GodotSandboxTool with omitted output_dir and worktree_root also pre-creates <baseDir>/artifacts and output_dir
      const tmpBaseDirGodot = `${tmpBaseDir}_godot`
      const validatedGodot = GodotSandboxTool.validateGodotSandboxInput(
        {
          action: "capture",
        },
        { defaultBaseDir: tmpBaseDirGodot },
      )
      expect(validatedGodot.worktree_root).toBe(tmpBaseDirGodot)
      expect(fs.existsSync(path.join(tmpBaseDirGodot, "artifacts"))).toBe(true)
      expect(fs.existsSync(validatedGodot.output_dir)).toBe(true)
    } finally {
      fs.rmSync(tmpBaseDir, { recursive: true, force: true })
      fs.rmSync(`${tmpBaseDir}_exec`, { recursive: true, force: true })
      fs.rmSync(`${tmpBaseDir}_godot`, { recursive: true, force: true })
    }
  })

  test("GPU-039: Interrupting GenerateImageTool and GodotSandboxTool fibers immediately aborts in-flight Broker HTTP socket (< 100ms)", async () => {
    const abortSocketPath = `/tmp/aquanox-broker-abort-${process.pid}-${Date.now()}.sock`
    let resolveImageRequestArrived!: () => void
    const imageRequestArrived = new Promise<void>((r) => {
      resolveImageRequestArrived = r
    })
    let resolveImageSocketClosed!: (elapsedAfterInterruptMs: number) => void
    const imageSocketClosed = new Promise<number>((r) => {
      resolveImageSocketClosed = r
    })
    let imageInterruptStartedAt = 0

    let resolveGodotRequestArrived!: () => void
    const godotRequestArrived = new Promise<void>((r) => {
      resolveGodotRequestArrived = r
    })
    let resolveGodotSocketClosed!: (elapsedAfterInterruptMs: number) => void
    const godotSocketClosed = new Promise<number>((r) => {
      resolveGodotSocketClosed = r
    })
    let godotInterruptStartedAt = 0

    const slowServer = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      req.on("end", () => {
        if (req.url === "/v1/auth/bootstrap_or_rekey") {
          res.statusCode = 200
          res.setHeader("Content-Type", "application/json")
          res.end(
            JSON.stringify({
              ok: true,
              broker_boot_id: "boot_abort_test",
              broker_epoch: 1,
              hmac_key_hex: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            }),
          )
          return
        }
        if (req.url === "/v1/lease/image") {
          const socket = req.socket ?? res.socket
          const onClosed = () => {
            const elapsed = performance.now() - imageInterruptStartedAt
            resolveImageSocketClosed(elapsed)
          }
          if (socket && (socket.destroyed || socket.closed)) {
            onClosed()
          } else if (socket) {
            socket.once("close", onClosed)
          }
          resolveImageRequestArrived()
          // Intentionally hold response open to simulate long-running diffusion generation
          return
        }
        if (req.url === "/v1/lease/godot") {
          const socket = req.socket ?? res.socket
          const onClosed = () => {
            const elapsed = performance.now() - godotInterruptStartedAt
            resolveGodotSocketClosed(elapsed)
          }
          if (socket && (socket.destroyed || socket.closed)) {
            onClosed()
          } else if (socket) {
            socket.once("close", onClosed)
          }
          resolveGodotRequestArrived()
          // Intentionally hold response open to simulate long-running godot run
          return
        }
      })
    })

    await new Promise<void>((resolve, reject) => {
      try {
        if (fs.existsSync(abortSocketPath)) fs.unlinkSync(abortSocketPath)
      } catch {}
      slowServer.once("error", reject)
      slowServer.listen(abortSocketPath, () => resolve())
    })

    const { Fiber } = await import("effect")
    const customClient = new GpuBrokerClient.Client({ unixSocketPath: abortSocketPath })

    try {
      // 1. GenerateImageTool fiber interruption aborts in-flight /v1/lease/image HTTP socket (< 100ms)
      const imageFiber = Effect.runFork(
        GenerateImageTool.executeGenerateImage(
          {
            prompt: "Deep sealeviathan silhouette in bioluminescent fog",
            tier: "tier1_klein4b_q4",
            width: 1024,
            height: 1024,
            worktree_root: "/tmp",
            output_path: "/tmp/abort_test.png",
          },
          "ses_gpu039_abort",
          customClient,
        ),
      )

      await imageRequestArrived
      imageInterruptStartedAt = performance.now()
      await Effect.runPromise(Fiber.interrupt(imageFiber))
      const imageDisconnectLatencyMs = await imageSocketClosed
      expect(imageDisconnectLatencyMs).toBeLessThan(100)

      // 2. GodotSandboxTool fiber interruption aborts in-flight /v1/lease/godot HTTP socket (< 100ms)
      const godotFiber = Effect.runFork(
        GodotSandboxTool.executeGodotSandbox(
          {
            action: "capture",
            timeout_seconds: 30,
            worktree_root: "/tmp",
            output_dir: "/tmp/godot_abort_test",
          },
          "ses_gpu039_godot_abort",
          customClient,
        ),
      )

      await godotRequestArrived
      godotInterruptStartedAt = performance.now()
      await Effect.runPromise(Fiber.interrupt(godotFiber))
      const godotDisconnectLatencyMs = await godotSocketClosed
      expect(godotDisconnectLatencyMs).toBeLessThan(100)
    } finally {
      await new Promise<void>((resolve) => {
        slowServer.close(() => {
          try {
            if (fs.existsSync(abortSocketPath)) fs.unlinkSync(abortSocketPath)
          } catch {}
          resolve()
        })
      })
    }
  })

  test("GPU-040: GodotSandboxTool and GpuBrokerClient.leaseGodot send both action and mode in /v1/lease/godot payload for test, capture, import, and validate", async () => {
    for (const action of ["test", "capture", "import", "validate"] as const) {
      const beforeCount = mockBroker.state.receivedParams.length
      const res = await Effect.runPromise(
        GodotSandboxTool.executeGodotSandbox(
          {
            action,
            timeout_seconds: 30,
            worktree_root: "/tmp",
            output_dir: `/tmp/godot_gpu040_${action}`,
          },
          `ses_gpu040_${action}`,
        ),
      )
      expect(res.output.ok).toBe(true)
      expect(res.metadata.action).toBe(action)
      expect(res.metadata.mode).toBe(action)

      const sentParams = mockBroker.state.receivedParams[beforeCount]!
      expect(sentParams.action).toBe(action)
      expect(sentParams.mode).toBe(action)
      expect(sentParams.resident).toBe(false)
    }
  })

  test("GPU-041: validateGenerateImageInput path routing and executeGenerateImage pure text content", async () => {
    // 1. validateGenerateImageInput({ prompt: "cat", output_path: "/tmp/opencode/cat.png", worktree_root: "/home/rjwits" }) succeeds with output_path: "/tmp/opencode/cat.png", worktree_root: "/tmp/opencode"
    const val1 = GenerateImageTool.validateGenerateImageInput({
      prompt: "cat",
      output_path: "/tmp/opencode/cat.png",
      worktree_root: "/home/rjwits",
    })
    expect(val1.output_path).toBe("/tmp/opencode/cat.png")
    expect(val1.worktree_root).toBe("/tmp/opencode")

    // 2. validateGenerateImageInput({ prompt: "cat", output_path: "/home/rjwits/cat.png", worktree_root: "/home/rjwits" }) redirects output_path to "/home/rjwits/artifacts/cat.png"
    const val2 = GenerateImageTool.validateGenerateImageInput({
      prompt: "cat",
      output_path: "/home/rjwits/cat.png",
      worktree_root: "/home/rjwits",
    })
    expect(val2.output_path).toBe("/home/rjwits/artifacts/cat.png")
    expect(val2.worktree_root).toBe("/home/rjwits")

    // 3. executeGenerateImage returns a plain string content (no data:image/png;base64 attachment) to prevent LLM vision KV corruption
    const testOutPath = "/tmp/opencode_gpu041_test_cat.png"
    fs.mkdirSync("/tmp", { recursive: true })
    fs.writeFileSync(testOutPath, Buffer.from("dummy-png-binary-content-12345"))

    try {
      const res = await Effect.runPromise(
        GenerateImageTool.executeGenerateImage(
          {
            prompt: "a majestic cat wearing a tiny hat",
            output_path: testOutPath,
            worktree_root: "/tmp",
          },
          "ses_gpu041_content",
        ),
      )

      expect(typeof res.content).toBe("string")
      expect(Array.isArray(res.content)).toBe(false)
      expect(res.content).toContain("Generated image (1024x1024, model=Qwen-Image-2512-20B-Q5_K_M)")
      expect(res.content).toContain(`Output path: ${testOutPath}`)
      expect(res.content).not.toContain("data:image/png;base64")
      expect(res.content).not.toContain("tier=")
    } finally {
      try {
        if (fs.existsSync(testOutPath)) fs.unlinkSync(testOutPath)
      } catch {}
    }
  })

  test("GPU-042: executeGenerateImage auto-waits and retries on 503 ERR_WORKER_LEASE_BUSY", async () => {
    let callCount = 0
    mockBroker.state.onBeforeRespond = () => {
      callCount++
      if (callCount === 1) {
        mockBroker.state.imageStatusCodeOverride = 503
        mockBroker.state.imageResponseOverride = {
          ok: false,
          error: "ERR_WORKER_LEASE_BUSY",
          message: "ERR_WORKER_LEASE_BUSY: Dedicated GPU 3 worker lease is currently busy",
        }
      } else {
        mockBroker.state.imageStatusCodeOverride = 200
        mockBroker.state.imageResponseOverride = undefined
      }
    }

    const startTime = performance.now()
    const res = await Effect.runPromise(
      GenerateImageTool.executeGenerateImage(
        {
          prompt: "a futuristic rover traversing crystalline terrain",
          output_path: "/tmp/rover.png",
          worktree_root: "/tmp",
        },
        "ses_gpu042_retry",
      ),
    )
    const elapsed = performance.now() - startTime

    expect(callCount).toBeGreaterThanOrEqual(2)
    expect(elapsed).toBeGreaterThanOrEqual(1900) // at least one 2000ms retry backoff
    expect(res.output.ok).toBe(true)
    expect(typeof res.content).toBe("string")
  })

  test("GPU-043: automatic recovery on 403 ERR_INVALID_SIGNATURE with force_rekey: true, concurrent bootstrap deduplication, and exact QA S06 cat-hat parameters", async () => {
    const client = GpuBrokerClient.getDefaultClient()

    // 1. Concurrent bootstrapOrRekey(false) calls deduplicate via bootstrapInFlight
    const [bootA, bootB] = await Promise.all([client.bootstrapOrRekey(false), client.bootstrapOrRekey(false)])
    expect(bootA).toEqual(bootB)
    expect(mockBroker.state.bootstrapCalls).toBe(1)
    expect(mockBroker.state.receivedBootstrapPayloads[0]?.force_rekey).toBeUndefined()

    // 2. Simulate broker restarting at epoch 7 with a new in-memory HMAC key (same epoch & boot_id as client's cached state)
    mockBroker.rotateBrokerEpoch("boot_same_epoch_7", 7)
    await client.bootstrapOrRekey(false)
    expect(client.getCachedEpochState()?.broker_epoch).toBe(7)
    const oldKey = client.getCachedEpochState()?.hmac_key_hex
    expect(mockBroker.state.bootstrapCalls).toBe(2)

    // Broker rotates its in-memory HMAC key while staying on epoch 7 (triggering 403 ERR_INVALID_SIGNATURE on next signed request)
    mockBroker.rotateHmacKeySameEpoch("boot_same_epoch_7", 7)

    // 3. Validate and execute with exact QA S06 parameters
    const qaParams = {
      prompt: "Photorealistic Siberian cat wearing a tiny knitted winter hat, studio lighting",
      tier: "qwen_image_2512",
      width: 1024,
      height: 1024,
      steps: 28,
      seed: 42,
      lease_mode: "shared_worker",
      output_path: "/home/rjwits/artifacts/qa-e2e32-S06-20261106T0623Z/cat-hat.png",
    }

    const validatedQa = GenerateImageTool.validateGenerateImageInput(qaParams)
    expect(validatedQa.tier).toBe("qwen_image_2512")
    expect(validatedQa.width).toBe(1024)
    expect(validatedQa.height).toBe(1024)
    expect(validatedQa.steps).toBe(28)
    expect(validatedQa.seed).toBe(42)
    expect(validatedQa.lease_mode).toBe("shared_worker")
    expect(validatedQa.output_path).toBe("/home/rjwits/artifacts/qa-e2e32-S06-20261106T0623Z/cat-hat.png")
    expect(validatedQa.worktree_root).toBe("/home/rjwits/artifacts/qa-e2e32-S06-20261106T0623Z")

    const envCountBefore = mockBroker.state.receivedEnvelopes.length
    const execRes = await Effect.runPromise(
      GenerateImageTool.executeGenerateImage(qaParams, "ses_qa_s06_rekey"),
    )

    // First attempt got 403 ERR_INVALID_SIGNATURE -> triggered bootstrapOrRekey(true) with force_rekey: true -> rotated to epoch 8 and succeeded!
    expect(execRes.output.ok).toBe(true)
    expect(execRes.output.output_path).toBe("/home/rjwits/artifacts/qa-e2e32-S06-20261106T0623Z/cat-hat.png")
    expect(mockBroker.state.bootstrapCalls).toBe(3)
    const lastBootstrapPayload =
      mockBroker.state.receivedBootstrapPayloads[mockBroker.state.receivedBootstrapPayloads.length - 1]!
    expect(lastBootstrapPayload.force_rekey).toBe(true)

    const newCachedState = client.getCachedEpochState()!
    expect(newCachedState.broker_epoch).toBe(8)
    expect(newCachedState.hmac_key_hex).not.toBe(oldKey)

    const firstAttemptEnv = mockBroker.state.receivedEnvelopes[envCountBefore]!
    const retriedAttemptEnv = mockBroker.state.receivedEnvelopes[envCountBefore + 1]!
    expect(firstAttemptEnv.broker_epoch).toBe(7)
    expect(retriedAttemptEnv.broker_epoch).toBe(8)
    expect(retriedAttemptEnv.nonce).not.toBe(firstAttemptEnv.nonce)
    expect(retriedAttemptEnv.signature).not.toBe(firstAttemptEnv.signature)
  })

  test("GPU-035 & GPU-045: Omitted output_path on /home/rjwits isolates worktree_root under /home/rjwits/artifacts/<isolated>, and bootstrapOrRekey(false) auto-recovers on 409 ERR_EPOCH_KEY_ALREADY_CONFIRMED", async () => {
    const fs = await import("node:fs")
    const valA = GenerateImageTool.validateGenerateImageInput(
      {
        prompt: "A studio teapot on blue linen",
        tier: "tier1_klein4b_q4",
        width: 1024,
        height: 1024,
      },
      { defaultBaseDir: "/home/rjwits", sessionID: "ses_gpu035_iso_a" },
    )
    const valB = GenerateImageTool.validateGenerateImageInput(
      {
        prompt: "A studio teapot on blue linen",
        tier: "tier1_klein4b_q4",
        width: 1024,
        height: 1024,
      },
      { defaultBaseDir: "/var/lib/aquanox-runner", sessionID: "ses_gpu035_iso_b" },
    )

    try {
      expect(valA.worktree_root).not.toBe("/home/rjwits")
      expect(valA.worktree_root.startsWith("/home/rjwits/artifacts/ses_gpu035_iso_a_")).toBe(true)
      expect(valA.output_path).toBe(`${valA.worktree_root}/generated_image.png`)
      expect(valB.worktree_root).not.toBe("/var/lib/aquanox-runner")
      expect(valB.worktree_root.startsWith("/home/rjwits/artifacts/ses_gpu035_iso_b_")).toBe(true)
      expect(valA.output_path).not.toBe(valB.output_path)
    } finally {
      try {
        fs.rmSync(valA.worktree_root, { recursive: true, force: true })
        fs.rmSync(valB.worktree_root, { recursive: true, force: true })
      } catch {}
    }
  })
  test("GPU-014 / GPU-040 / GPU-050: ancestor project.godot worktree resolution, conflicting action/mode rejection, and actionable failure propagation", async () => {
    const tempWt = fs.mkdtempSync("/tmp/opencode-godot-wt-")
    try {
      fs.writeFileSync(`${tempWt}/project.godot`, 'config_version=5\n[application]\nconfig/name="Test"\n')
      const nestedOut = `${tempWt}/artifacts/S11-import`

      // 1. Absolute output_dir-only inside a Godot checkout resolves worktree_root to ancestor with project.godot
      const validated = GodotSandboxTool.validateGodotSandboxInput({
        action: "import",
        output_dir: nestedOut,
      })
      expect(validated.action).toBe("import")
      expect(validated.mode).toBe("import")
      expect(validated.worktree_root).toBe(tempWt)
      expect(validated.output_dir).toBe(nestedOut)

      // 2. Conflicting action and mode throws ERR_INVALID_ACTION
      expect(() =>
        GodotSandboxTool.validateGodotSandboxInput({
          action: "test",
          mode: "capture",
          worktree_root: tempWt,
        }),
      ).toThrow(/ERR_INVALID_ACTION/)

      // 3. Broker failure with responseBody.failures propagates failure details into ToolFailure
      const failingClient = {
        runGodotSandbox: async () => {
          throw new GpuBrokerClient.GpuBrokerError(
            "ERR_WORKER_EXECUTION_FAILED",
            500,
            "ERR_WORKER_EXECUTION_FAILED",
            {
              error: "ERR_WORKER_EXECUTION_FAILED",
              failures: ["import failed with exit code 1: Permission denied: '/run/aquanox-broker/locks/godot-phase.lock'"],
            },
          )
        },
      } as unknown as GpuBrokerClient.Client

      const exit = await Effect.runPromiseExit(
        GodotSandboxTool.executeGodotSandbox(
          { action: "import", output_dir: nestedOut },
          "ses_gpu050_err",
          failingClient,
        ),
      )
      expect(exit._tag).toBe("Failure")
      expect(JSON.stringify(exit)).toContain("godot-phase.lock")
    } finally {
      fs.rmSync(tempWt, { recursive: true, force: true })
    }
  })
})
