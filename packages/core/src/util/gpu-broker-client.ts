export * as GpuBrokerClient from "./gpu-broker-client.js"

import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import { SessionSlotLease } from "../session/slot-lease.js"

export const DEFAULT_BROKER_SOCKET_PATH = "/run/aquanox-broker/broker.sock"
export const DEFAULT_ENVELOPE_TTL_SECONDS = 300

export interface BrokerIdentityContext {
  conversation_id?: string
  session_id: string
  session_generation?: number
  lease_id?: string
  signal?: AbortSignal
}

export interface BrokerEpochState {
  broker_boot_id: string
  broker_epoch: number
  hmac_key_hex: string
}

export interface BrokerEnvelopeInput {
  conversation_id: string
  session_id: string
  session_generation: number
  lease_id: string
  method: string
  params?: Record<string, unknown>
  params_sha256?: string
  hmac_key_hex: string
  broker_boot_id: string
  broker_epoch: number
  nonce?: string
  expires_at?: number
}

export interface SignedBrokerEnvelope {
  conversation_id: string
  session_id: string
  session_generation: number
  lease_id: string
  method: string
  params_sha256: string
  nonce: string
  expires_at: number
  broker_boot_id: string
  broker_epoch: number
  signature: string
}

export interface BrokerClientOptions {
  unixSocketPath?: string
  baseUrl?: string
  clientId?: string
  timeoutMs?: number
}

export interface GenerateImageBrokerRequest extends BrokerIdentityContext {
  prompt: string
  tier?: string
  width?: number
  height?: number
  steps?: number
  seed?: number
  output_path?: string
  worktree_root?: string
  lease_mode?: string
  caller_hint?: string
  non_commercial_ack?: boolean
  active_leads?: number
  subagent_commitments_mib?: number
}

export interface GenerateImageBrokerResponse {
  ok: boolean
  output_path: string
  width: number
  height: number
  tier: string
  seed: number
  elapsed_ms: number
  vram_peak_mib?: number
  lease_mode?: string
  delivered_files?: string[]
  is_test_data?: boolean
  synthetic_test_data?: boolean
  [key: string]: unknown
}

export interface GodotSandboxBrokerRequest extends BrokerIdentityContext {
  action: "capture" | "sandbox" | "import" | "validate" | "test" | string
  mode?: "capture" | "sandbox" | "import" | "validate" | "test" | string
  seed?: number
  timeout_seconds?: number
  timeout_s?: number
  timeout?: number
  resident?: boolean
  output_dir?: string
  output_path?: string
  worktree_root?: string
  lease_mode?: string
  active_leads?: number
  subagent_commitments_mib?: number
  [key: string]: unknown
}

export interface GodotSandboxBrokerResponse {
  ok: boolean
  action: string
  exit_code: number
  frames_captured?: number
  output_dir?: string
  artifacts?: string[]
  delivered_files?: string[]
  elapsed_ms: number
  lease_mode?: string
  synthetic_test_data?: boolean
  is_test_data?: boolean
  [key: string]: unknown
}

export interface RegisterSubprocBrokerRequest {
  request_id: string
  unit_name: string
  conversation_id?: string
  owner_session_id?: string
  memory_max_mib: number
  cpu_quota_pct?: number
}

export interface RegisterSubprocBrokerResult {
  ok: boolean
  admitted: boolean
  unit_name: string
  reason?: string
  status?: number
  offline?: boolean
  [key: string]: unknown
}

export interface ReleaseSubprocBrokerRequest {
  request_id?: string
  unit_name?: string
  [key: string]: unknown
}

export type ReleaseSubprocInput = ReleaseSubprocBrokerRequest | string

export const activeSubprocUnits = new Set<string>()

export interface EvaluateAdmissionBrokerRequest {
  new_request_mib: number
  active_leads?: number
  subagent_commitments_mib?: number
}

export interface SessionHeartbeatBrokerRequest extends BrokerIdentityContext {
  lease_mode?: string
}

export interface SessionCloseBrokerRequest extends BrokerIdentityContext {
  reason?: string
}

export interface SessionLifecycleBrokerResponse {
  ok: boolean
  status: string
  conversation_id: string
  session_id: string
  lease_released?: boolean
  [key: string]: unknown
}

export class GpuBrokerError extends Error {
  readonly statusCode: number
  readonly errorCode: string
  readonly responseBody: Record<string, unknown>

  constructor(message: string, statusCode: number, errorCode: string, responseBody: Record<string, unknown> = {}) {
    super(message)
    this.name = "GpuBrokerError"
    this.statusCode = statusCode
    this.errorCode = errorCode
    this.responseBody = responseBody
  }
}

/**
 * Recursively sorts object keys and serializes to canonical JSON.
 */
export function canonicalizeParams(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeParams)
  }
  const record = value as Record<string, unknown>
  const sortedKeys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
  const result: Record<string, unknown> = {}
  for (const key of sortedKeys) {
    result[key] = canonicalizeParams(record[key])
  }
  return result
}

export function serializeCanonicalJson(params: Record<string, unknown>): string {
  return JSON.stringify(canonicalizeParams(params))
}

export function computeParamsSha256(params: Record<string, unknown>): string {
  const canonicalJson = serializeCanonicalJson(params)
  return crypto.createHash("sha256").update(canonicalJson, "utf8").digest("hex")
}

export function formatSignaturePayload(tuple: {
  conversation_id: string
  session_id: string
  session_generation: number
  lease_id: string
  method: string
  params_sha256: string
  nonce: string
  expires_at: number
}): string {
  return `${tuple.conversation_id}|${tuple.session_id}|${tuple.session_generation}|${tuple.lease_id}|${tuple.method}|${tuple.params_sha256}|${tuple.nonce}|${tuple.expires_at}`
}

/**
 * Signs the exact v12.0 §2.1 Broker request envelope using HMAC-SHA256:
 * payload = "${conversation_id}|${session_id}|${session_generation}|${lease_id}|${method}|${params_sha256}|${nonce}|${expires_at}"
 */
export function signBrokerRequestEnvelope(input: BrokerEnvelopeInput): SignedBrokerEnvelope {
  const params_sha256 = input.params_sha256 ?? computeParamsSha256(input.params ?? {})
  const nonce = input.nonce ?? crypto.randomBytes(16).toString("hex")
  const expires_at = input.expires_at ?? Math.floor(Date.now() / 1000) + DEFAULT_ENVELOPE_TTL_SECONDS

  const payload = formatSignaturePayload({
    conversation_id: input.conversation_id,
    session_id: input.session_id,
    session_generation: input.session_generation,
    lease_id: input.lease_id,
    method: input.method,
    params_sha256,
    nonce,
    expires_at,
  })

  const keyBuffer = /^[0-9a-fA-F]+$/.test(input.hmac_key_hex) && input.hmac_key_hex.length % 2 === 0
    ? Buffer.from(input.hmac_key_hex, "hex")
    : Buffer.from(input.hmac_key_hex, "utf8")

  const signature = crypto.createHmac("sha256", keyBuffer).update(payload, "utf8").digest("hex")

  return {
    conversation_id: input.conversation_id,
    session_id: input.session_id,
    session_generation: input.session_generation,
    lease_id: input.lease_id,
    method: input.method,
    params_sha256,
    nonce,
    expires_at,
    broker_boot_id: input.broker_boot_id,
    broker_epoch: input.broker_epoch,
    signature,
  }
}

export function verifyBrokerRequestEnvelope(
  envelope: SignedBrokerEnvelope,
  params: Record<string, unknown>,
  hmac_key_hex: string,
): boolean {
  const expectedSha256 = computeParamsSha256(params)
  if (envelope.params_sha256 !== expectedSha256) {
    return false
  }
  const resigned = signBrokerRequestEnvelope({
    conversation_id: envelope.conversation_id,
    session_id: envelope.session_id,
    session_generation: envelope.session_generation,
    lease_id: envelope.lease_id,
    method: envelope.method,
    params_sha256: envelope.params_sha256,
    hmac_key_hex,
    broker_boot_id: envelope.broker_boot_id,
    broker_epoch: envelope.broker_epoch,
    nonce: envelope.nonce,
    expires_at: envelope.expires_at,
  })
  const sigA = Buffer.from(envelope.signature, "utf8")
  const sigB = Buffer.from(resigned.signature, "utf8")
  if (sigA.length !== sigB.length) return false
  return crypto.timingSafeEqual(sigA, sigB)
}

function resolveIdentityTuple(ctx: BrokerIdentityContext): {
  conversation_id: string
  session_id: string
  session_generation: number
  lease_id: string
} {
  const session_id = ctx.session_id
  const snapshot = SessionSlotLease.getResourceSnapshot({
    conversationId: ctx.conversation_id,
    sessionId: session_id,
  })
  const conversation_id =
    ctx.conversation_id ??
    SessionSlotLease.getConversationIdForSession(session_id) ??
    snapshot.thisConversation?.conversationId ??
    `conv_${session_id}`
  const session_generation = ctx.session_generation ?? snapshot.generation
  const lease_id = ctx.lease_id ?? `lease_${conversation_id}_${session_generation}`
  return {
    conversation_id,
    session_id,
    session_generation,
    lease_id,
  }
}

interface RawHttpResult {
  statusCode: number
  body: Record<string, unknown>
}

export class Client {
  private epochState: BrokerEpochState | undefined
  private readonly options: BrokerClientOptions

  constructor(options: BrokerClientOptions = {}) {
    this.options = options
  }

  getCachedEpochState(): BrokerEpochState | undefined {
    return this.epochState ? { ...this.epochState } : undefined
  }

  private resolveTransport(): { socketPath?: string; baseUrl?: string; timeoutMs: number; clientId: string } {
    const baseUrl = this.options.baseUrl ?? process.env.AQUANOX_BROKER_URL
    const socketPath =
      this.options.unixSocketPath ?? process.env.AQUANOX_BROKER_SOCKET ?? DEFAULT_BROKER_SOCKET_PATH
    const timeoutMs = this.options.timeoutMs ?? 300_000
    const clientId = this.options.clientId ?? `opencode-core-${process.pid}`
    return {
      ...(baseUrl ? { baseUrl } : { socketPath }),
      timeoutMs,
      clientId,
    }
  }

  private sendRawPost(
    endpointPath: string,
    payload: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
    customTimeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<RawHttpResult> {
    const transport = this.resolveTransport()
    const bodyString = JSON.stringify(payload)
    const timeoutMs = customTimeoutMs ?? transport.timeoutMs

    return new Promise<RawHttpResult>((resolve, reject) => {
      let settled = false
      let req: http.ClientRequest | undefined

      const cleanup = () => {
        if (signal) {
          signal.removeEventListener("abort", onAbort)
        }
      }

      const settleResolve = (val: RawHttpResult) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(val)
      }

      const settleReject = (err: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(err)
      }

      const makeAbortError = () => {
        const reasonMsg =
          signal?.reason instanceof Error
            ? signal.reason.message
            : typeof signal?.reason === "string" && signal.reason.length > 0
              ? signal.reason
              : "Request aborted by caller"
        const abortErr = new GpuBrokerError(
          `ERR_BROKER_REQUEST_ABORTED: ${reasonMsg}`,
          499,
          "ERR_BROKER_REQUEST_ABORTED",
          {},
        )
        ;(abortErr as any).code = "ERR_BROKER_REQUEST_ABORTED"
        return abortErr
      }

      const onAbort = () => {
        const abortErr = makeAbortError()
        try {
          req?.destroy(abortErr)
        } catch {}
        try {
          req?.socket?.destroy()
        } catch {}
        settleReject(abortErr)
      }

      if (signal?.aborted) {
        settleReject(makeAbortError())
        return
      }

      const headers: Record<string, string | number> = {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyString, "utf8"),
        ...extraHeaders,
      }

      let reqOptions: http.RequestOptions
      if (transport.baseUrl) {
        const parsed = new URL(endpointPath, transport.baseUrl)
        reqOptions = {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          method: "POST",
          headers,
          timeout: timeoutMs,
        }
      } else {
        reqOptions = {
          socketPath: transport.socketPath,
          path: endpointPath,
          method: "POST",
          headers,
          timeout: timeoutMs,
        }
      }

      req = http.request(reqOptions, (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        res.on("end", () => {
          const rawText = Buffer.concat(chunks).toString("utf8")
          let parsedBody: Record<string, unknown> = {}
          if (rawText.trim().length > 0) {
            try {
              parsedBody = JSON.parse(rawText) as Record<string, unknown>
            } catch {
              parsedBody = { raw: rawText }
            }
          }
          settleResolve({
            statusCode: res.statusCode ?? 500,
            body: parsedBody,
          })
        })
        res.on("close", () => {
          cleanup()
        })
      })

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) {
          onAbort()
          return
        }
      }

      req.on("timeout", () => {
        req?.destroy(new Error(`GPU Broker request to ${endpointPath} timed out after ${timeoutMs}ms`))
      })

      req.on("close", () => {
        if (!settled) {
          if (signal?.aborted) {
            settleReject(makeAbortError())
          } else {
            cleanup()
          }
        }
      })

      req.on("error", (err: any) => {
        if (err instanceof GpuBrokerError) {
          settleReject(err)
          return
        }
        if (signal?.aborted) {
          settleReject(makeAbortError())
          return
        }
        const brokerError = new GpuBrokerError(
          `GPU Broker connection error (${endpointPath}): ${err.message}`,
          503,
          err.code ?? "ERR_BROKER_UNAVAILABLE",
          {},
        )
        ;(brokerError as any).cause = err
        settleReject(brokerError)
      })

      req.write(bodyString)
      req.end()
    })
  }

  /**
   * Calls POST /v1/auth/bootstrap_or_rekey to obtain (broker_boot_id, broker_epoch, hmac_key_hex).
   */
  async bootstrapOrRekey(force: boolean = false, signal?: AbortSignal): Promise<BrokerEpochState> {
    if (force) {
      this.epochState = undefined
    }
    const transport = this.resolveTransport()
    const res = await this.sendRawPost(
      "/v1/auth/bootstrap_or_rekey",
      {
        client_id: transport.clientId,
        pid: process.pid,
      },
      {},
      undefined,
      signal,
    )

    if (res.statusCode < 200 || res.statusCode >= 300) {
      const errCode = typeof res.body.error === "string" ? res.body.error : "ERR_BROKER_BOOTSTRAP_FAILED"
      const errMsg =
        typeof res.body.message === "string"
          ? res.body.message
          : `Failed to bootstrap/rekey with GPU Broker (HTTP ${res.statusCode})`
      throw new GpuBrokerError(errMsg, res.statusCode, errCode, res.body)
    }

    const broker_boot_id = String(res.body.broker_boot_id ?? "")
    const broker_epoch = Number(res.body.broker_epoch ?? 0)
    const hmac_key_hex = String(res.body.hmac_key_hex ?? "")

    if (!broker_boot_id || !hmac_key_hex || !Number.isFinite(broker_epoch)) {
      throw new GpuBrokerError(
        "GPU Broker returned incomplete epoch credentials during bootstrap_or_rekey",
        500,
        "ERR_INVALID_BOOTSTRAP_RESPONSE",
        res.body,
      )
    }

    this.epochState = {
      broker_boot_id,
      broker_epoch,
      hmac_key_hex,
    }
    return { ...this.epochState }
  }

  /**
   * Sends a signed request to the GPU Broker and automatically handles 401 ERR_BROKER_EPOCH_MISMATCH
   * by re-running bootstrapOrRekey(), re-signing with a fresh nonce and the new epoch, and retrying once.
   */
  async requestWithAutoRekey<T = Record<string, unknown>>(input: {
    endpointPath: string
    method: string
    identity: BrokerIdentityContext
    params: Record<string, unknown>
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<T> {
    const signal = input.signal ?? input.identity.signal
    if (!this.epochState) {
      await this.bootstrapOrRekey(false, signal)
    }

    const tuple = resolveIdentityTuple(input.identity)

    const attemptSignedPost = async (state: BrokerEpochState): Promise<RawHttpResult> => {
      const envelope = signBrokerRequestEnvelope({
        conversation_id: tuple.conversation_id,
        session_id: tuple.session_id,
        session_generation: tuple.session_generation,
        lease_id: tuple.lease_id,
        method: input.method,
        params: input.params,
        hmac_key_hex: state.hmac_key_hex,
        broker_boot_id: state.broker_boot_id,
        broker_epoch: state.broker_epoch,
      })

      return this.sendRawPost(
        input.endpointPath,
        {
          ...input.params,
          envelope,
          params: input.params,
        },
        {
          "X-Broker-Signature": envelope.signature,
          "X-Broker-Boot-Id": envelope.broker_boot_id,
          "X-Broker-Epoch": String(envelope.broker_epoch),
          "X-Broker-Nonce": envelope.nonce,
        },
        input.timeoutMs,
        signal,
      )
    }

    let res = await attemptSignedPost(this.epochState!)

    if (res.statusCode === 401 && res.body.error === "ERR_BROKER_EPOCH_MISMATCH") {
      const newState = await this.bootstrapOrRekey(false, signal)
      res = await attemptSignedPost(newState)
    }

    if (res.statusCode < 200 || res.statusCode >= 300) {
      const errCode = typeof res.body.error === "string" ? res.body.error : "ERR_BROKER_REQUEST_FAILED"
      const rawMsg = typeof res.body.message === "string" ? res.body.message : ""
      const errMsg = rawMsg
        ? rawMsg.includes(errCode)
          ? rawMsg
          : `${errCode}: ${rawMsg}`
        : `GPU Broker ${input.method} failed with HTTP ${res.statusCode} (${errCode})`
      throw new GpuBrokerError(errMsg, res.statusCode, errCode, res.body)
    }

    return res.body as T
  }

  isBrokerConfiguredOrAvailable(): boolean {
    if (
      Boolean(this.options.baseUrl) ||
      Boolean(this.options.unixSocketPath) ||
      Boolean(process.env.AQUANOX_BROKER_URL) ||
      Boolean(process.env.AQUANOX_BROKER_SOCKET)
    ) {
      return true
    }
    try {
      return fs.existsSync(DEFAULT_BROKER_SOCKET_PATH)
    } catch {
      return false
    }
  }

  async registerSubproc(input: RegisterSubprocBrokerRequest): Promise<RegisterSubprocBrokerResult> {
    if (!this.isBrokerConfiguredOrAvailable()) {
      return {
        ok: true,
        admitted: true,
        unit_name: input.unit_name,
        offline: true,
      }
    }

    try {
      const res = await this.sendRawPost("/v1/subproc/register", {
        request_id: input.request_id,
        unit_name: input.unit_name,
        ...(input.conversation_id !== undefined ? { conversation_id: input.conversation_id } : {}),
        ...(input.owner_session_id !== undefined ? { owner_session_id: input.owner_session_id } : {}),
        memory_max_mib: input.memory_max_mib,
        ...(input.cpu_quota_pct !== undefined ? { cpu_quota_pct: input.cpu_quota_pct } : {}),
      })

      const isAdmissionDenied =
        res.statusCode === 503 ||
        res.body.admitted === false ||
        res.body.error === "ERR_SUBPROC_MEM_FLOOR_VIOLATION" ||
        res.body.error === "ERR_HOST_MEM_FLOOR_VIOLATION"

      if (isAdmissionDenied || res.statusCode < 200 || res.statusCode >= 300) {
        const errCode = typeof res.body.error === "string" ? res.body.error : undefined
        const reason =
          typeof res.body.reason === "string"
            ? res.body.reason
            : typeof res.body.message === "string"
              ? res.body.message
              : errCode ?? `Broker denied subproc admission (HTTP ${res.statusCode})`
        return {
          ok: false,
          admitted: false,
          unit_name: input.unit_name,
          reason,
          status: res.statusCode,
          ...res.body,
        }
      }

      if (res.statusCode >= 200 && res.statusCode < 300 && res.body.admitted !== false) {
        activeSubprocUnits.add(input.request_id)
      }

      return {
        ok: true,
        admitted: res.body.admitted !== false,
        unit_name: typeof res.body.unit_name === "string" ? res.body.unit_name : input.unit_name,
        status: res.statusCode,
        ...res.body,
      }
    } catch (err: any) {
      const msg = String(err?.message ?? "")
      const code = String(err?.errorCode ?? err?.code ?? (err?.cause as any)?.code ?? "")
      const isOffline =
        code === "ENOENT" ||
        code === "ECONNREFUSED" ||
        code === "ERR_BROKER_UNAVAILABLE" ||
        msg.includes("ENOENT") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("ERR_BROKER_UNAVAILABLE")

      if (isOffline) {
        return {
          ok: true,
          admitted: true,
          unit_name: input.unit_name,
          offline: true,
        }
      }

      throw err
    }
  }

  async releaseSubproc(input: ReleaseSubprocInput): Promise<Record<string, unknown>> {
    const requestId = typeof input === "string" ? input : (input.request_id ?? input.unit_name ?? "")
    if (!this.isBrokerConfiguredOrAvailable()) {
      activeSubprocUnits.delete(requestId)
      return { ok: true, released: true, offline: true }
    }

    const payload: Record<string, unknown> = {
      request_id: requestId,
      unit_name: requestId.endsWith(".service") ? requestId : `${requestId}.service`,
      ...(typeof input === "object" ? input : {}),
    }

    const delays = [100, 300]
    let lastError: any

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.sendRawPost("/v1/subproc/release", payload)

        if (res.statusCode === 401 || res.statusCode === 403) {
          try {
            await this.bootstrapOrRekey(true)
          } catch {
            // ignore rekey bootstrap errors during release retry
          }
          if (attempt < 2) {
            const delayMs = delays[attempt] ?? 100
            await new Promise((r) => setTimeout(r, delayMs))
            continue
          }
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          activeSubprocUnits.delete(requestId)
          return res.body
        }

        const errCode = typeof res.body.error === "string" ? res.body.error : "ERR_SUBPROC_RELEASE_FAILED"
        const rawMsg = typeof res.body.message === "string" ? res.body.message : ""
        const errMsg = rawMsg
          ? rawMsg.includes(errCode)
            ? rawMsg
            : `${errCode}: ${rawMsg}`
          : `GPU Broker releaseSubproc failed with HTTP ${res.statusCode} (${errCode})`

        lastError = new GpuBrokerError(errMsg, res.statusCode, errCode, res.body)

        // Retry on 5xx errors if attempts remain
        if (res.statusCode >= 500 && attempt < 2) {
          const delayMs = delays[attempt] ?? 100
          await new Promise((r) => setTimeout(r, delayMs))
          continue
        }

        throw lastError
      } catch (err: any) {
        lastError = err
        const msg = String(err?.message ?? "")
        const code = String(err?.errorCode ?? err?.code ?? (err?.cause as any)?.code ?? "")
        const isTransient =
          err?.statusCode >= 500 ||
          err?.statusCode === 401 ||
          err?.statusCode === 403 ||
          code === "ERR_BROKER_UNAVAILABLE" ||
          code === "ECONNREFUSED" ||
          code === "ENOENT" ||
          code === "ECONNRESET" ||
          code === "ETIMEDOUT" ||
          msg.includes("timed out") ||
          msg.includes("ECONNREFUSED") ||
          msg.includes("ENOENT") ||
          msg.includes("ECONNRESET")

        if (isTransient && attempt < 2) {
          const delayMs = delays[attempt] ?? 100
          await new Promise((r) => setTimeout(r, delayMs))
          continue
        }
        throw lastError
      }
    }
    throw lastError
  }

  async evaluateAdmission(input: EvaluateAdmissionBrokerRequest): Promise<Record<string, unknown>> {
    if (!this.isBrokerConfiguredOrAvailable()) {
      return {
        ok: true,
        admitted: true,
        offline: true,
      }
    }
    const snapshot = SessionSlotLease.getResourceSnapshot()
    try {
      const res = await this.sendRawPost("/v1/admission/evaluate", {
        new_request_mib: input.new_request_mib,
        active_leads: input.active_leads ?? snapshot.active_leads ?? snapshot.activeLeads ?? 0,
        subagent_commitments_mib:
          input.subagent_commitments_mib ?? snapshot.subagent_commitments_mib ?? snapshot.subagentCommitmentsMib ?? 0,
      })
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const errCode = typeof res.body.error === "string" ? res.body.error : "ERR_ADMISSION_EVALUATE_FAILED"
        const errMsg =
          typeof res.body.message === "string"
            ? res.body.message
            : `GPU Broker evaluateAdmission failed with HTTP ${res.statusCode} (${errCode})`
        throw new GpuBrokerError(errMsg, res.statusCode, errCode, res.body)
      }
      return res.body
    } catch (err: any) {
      const msg = String(err?.message ?? "")
      const code = String(err?.errorCode ?? err?.code ?? (err?.cause as any)?.code ?? "")
      const isOffline =
        code === "ENOENT" ||
        code === "ECONNREFUSED" ||
        code === "ERR_BROKER_UNAVAILABLE" ||
        msg.includes("ENOENT") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("ERR_BROKER_UNAVAILABLE")

      if (isOffline) {
        return {
          ok: true,
          admitted: true,
          offline: true,
        }
      }
      throw err
    }
  }

  async generateImage(
    req: GenerateImageBrokerRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<GenerateImageBrokerResponse> {
    const snapshot = SessionSlotLease.getResourceSnapshot({
      conversationId: req.conversation_id,
      sessionId: req.session_id,
    })
    const active_leads = req.active_leads ?? snapshot.active_leads ?? snapshot.activeLeads ?? 0
    const subagent_commitments_mib =
      req.subagent_commitments_mib ?? snapshot.subagent_commitments_mib ?? snapshot.subagentCommitmentsMib ?? 0

    const defaultSteps = process.env.AQUANOX_FAST_IMAGE_STEPS
      ? parseInt(process.env.AQUANOX_FAST_IMAGE_STEPS, 10)
      : 28

    const params: Record<string, unknown> = {
      prompt: req.prompt,
      tier: req.tier ?? "tier1_schnell",
      width: req.width ?? 1024,
      height: req.height ?? 1024,
      steps: req.steps ?? defaultSteps,
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
      ...(req.output_path !== undefined ? { output_path: req.output_path } : {}),
      ...(req.worktree_root !== undefined ? { worktree_root: req.worktree_root } : {}),
      lease_mode: req.lease_mode ?? "shared_worker",
      ...(req.caller_hint !== undefined ? { caller_hint: req.caller_hint } : {}),
      ...(req.non_commercial_ack !== undefined ? { non_commercial_ack: req.non_commercial_ack } : {}),
      active_leads,
      subagent_commitments_mib,
    }

    return this.requestWithAutoRekey<GenerateImageBrokerResponse>({
      endpointPath: "/v1/lease/image",
      method: "lease.image",
      identity: req,
      params,
      timeoutMs: options?.timeoutMs ?? 300_000,
      signal: options?.signal ?? req.signal,
    })
  }

  async leaseImage(
    req: GenerateImageBrokerRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<GenerateImageBrokerResponse> {
    return this.generateImage(req, options)
  }

  async runGodotSandbox(
    req: GodotSandboxBrokerRequest,
    options?: { signal?: AbortSignal },
  ): Promise<GodotSandboxBrokerResponse> {
    const rawTimeout = req.timeout_seconds ?? req.timeout_s ?? req.timeout ?? 60
    if (!Number.isFinite(rawTimeout) || rawTimeout < 5 || rawTimeout > 600) {
      throw new GpuBrokerError(
        `ERR_INVALID_TIMEOUT: timeout_seconds (${rawTimeout}) must be between 5 and 600`,
        400,
        "ERR_INVALID_TIMEOUT",
      )
    }
    const timeoutSeconds = rawTimeout
    const resident = Boolean(req.resident ?? false)

    const snapshot = SessionSlotLease.getResourceSnapshot({
      conversationId: req.conversation_id,
      sessionId: req.session_id,
    })
    const active_leads = req.active_leads ?? snapshot.active_leads ?? snapshot.activeLeads ?? 0
    const subagent_commitments_mib =
      req.subagent_commitments_mib ?? snapshot.subagent_commitments_mib ?? snapshot.subagentCommitmentsMib ?? 0

    const resolvedAction = req.action || (typeof req.mode === "string" ? req.mode : "capture")
    const resolvedMode = typeof req.mode === "string" && req.mode.trim().length > 0 ? req.mode.trim() : resolvedAction

    const params: Record<string, unknown> = {
      action: resolvedAction,
      mode: resolvedMode,
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
      timeout_seconds: timeoutSeconds,
      timeout_s: timeoutSeconds,
      timeout: timeoutSeconds,
      resident,
      ...(req.output_dir !== undefined ? { output_dir: req.output_dir } : {}),
      ...(req.output_path !== undefined ? { output_path: req.output_path } : {}),
      ...(req.worktree_root !== undefined ? { worktree_root: req.worktree_root } : {}),
      lease_mode: req.lease_mode ?? "shared_worker",
      active_leads,
      subagent_commitments_mib,
    }

    const socketTimeoutMs = Math.max((timeoutSeconds + 60) * 1000, 180_000)

    return this.requestWithAutoRekey<GodotSandboxBrokerResponse>({
      endpointPath: "/v1/lease/godot",
      method: "lease.godot",
      identity: req,
      params,
      timeoutMs: socketTimeoutMs,
      signal: options?.signal ?? req.signal,
    })
  }

  async leaseGodot(
    req: GodotSandboxBrokerRequest,
    options?: { signal?: AbortSignal },
  ): Promise<GodotSandboxBrokerResponse> {
    return this.runGodotSandbox(req, options)
  }

  async sendSessionHeartbeat(
    req: SessionHeartbeatBrokerRequest,
    options?: { signal?: AbortSignal },
  ): Promise<SessionLifecycleBrokerResponse> {
    const params: Record<string, unknown> = {
      ...(req.lease_mode !== undefined ? { lease_mode: req.lease_mode } : {}),
    }

    return this.requestWithAutoRekey<SessionLifecycleBrokerResponse>({
      endpointPath: "/v1/session/heartbeat",
      method: "session.heartbeat",
      identity: req,
      params,
      signal: options?.signal ?? req.signal,
    })
  }

  async closeWorkSession(
    req: SessionCloseBrokerRequest,
    options?: { signal?: AbortSignal },
  ): Promise<SessionLifecycleBrokerResponse> {
    const params: Record<string, unknown> = {
      ...(req.reason !== undefined ? { reason: req.reason } : {}),
    }

    return this.requestWithAutoRekey<SessionLifecycleBrokerResponse>({
      endpointPath: "/v1/session/close",
      method: "session.close",
      identity: req,
      params,
      signal: options?.signal ?? req.signal,
    })
  }
}

let defaultClient = new Client()

export function getDefaultClient(): Client {
  return defaultClient
}

export function configureDefaultClient(options: BrokerClientOptions): Client {
  defaultClient = new Client(options)
  return defaultClient
}

export function resetDefaultClient(): void {
  defaultClient = new Client()
}

export function isBrokerConfiguredOrAvailable(): boolean {
  return defaultClient.isBrokerConfiguredOrAvailable()
}

export function registerSubproc(input: RegisterSubprocBrokerRequest): Promise<RegisterSubprocBrokerResult> {
  return defaultClient.registerSubproc(input)
}

export function releaseSubproc(input: ReleaseSubprocInput): Promise<Record<string, unknown>> {
  return defaultClient.releaseSubproc(input)
}

export function evaluateAdmission(input: EvaluateAdmissionBrokerRequest): Promise<Record<string, unknown>> {
  return defaultClient.evaluateAdmission(input)
}
