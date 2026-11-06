export * as SessionSlotLease from "./slot-lease.js"

import * as fs from "node:fs"
import { Effect } from "effect"

export type SlotID = -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
export type PhysicalSlotID = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
export type ChildSlotID = 1 | 2 | 4 | 5 | 7 | 8
export type LeaseTier = "128k" | "256k" | "384k"

export const SLOTS: ReadonlyArray<PhysicalSlotID> = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const
export const BUDDY_BLOCKS: ReadonlyArray<0 | 1 | 2> = [0, 1, 2] as const
export const MAX_CONCURRENT_SUBAGENTS_PER_CONVERSATION = 3
export const MAX_SUBAGENT_QUANTA_PER_CONVERSATION = 3
export const SUBAGENT_SLOT_PREFERENCE: ReadonlyArray<PhysicalSlotID> = [2, 5, 8, 1, 4, 7, 0, 3, 6] as const
export const DEFAULT_STRIDE_ALIGNED_COMPUTE_STREAMS = 3
export const MAX_ACTIVE_COMPUTE_STREAMS = 4
export const COMPUTE_STARVATION_THRESHOLD_MS = 15_000
export const COMPUTE_STARVATION_MAX_BYPASSED_WAVES = 2
export const aquanox_slot_lease_v12_0 = "aquanox_slot_lease_v12_0"

const MAX_PINNED_SESSIONS = 256

export interface ConversationAdmissionInput {
  conversationId: string
  agentId?: string
  rootSessionId?: string
  reservedSubagentQuanta?: number
  maxConcurrentSubagents?: number
  resources?: {
    contextTier?: "128k" | "256k" | "384k"
    reservedSubagents?: {
      count: number
      contextTier?: "128k" | "256k" | "384k"
    }
    maxConcurrentSubagents?: number
  }
}

export interface ConversationAdmissionResult {
  admitted: boolean
  leaseId?: string
  generation: number
  leadBlockId?: 0 | 1 | 2
  leadSlotId?: number
  reservedQuanta: number
  availableUnreservedQuanta: number
  deficitQuanta: number
  reason?: string
}

export interface AdmittedConversation {
  conversationId: string
  agentId?: string
  rootSessionId?: string
  leadBlockId: 0 | 1 | 2
  leadSlotId: PhysicalSlotID
  reservedSubagentQuanta: number
  activeSubagentQuanta: number
  activeSubagentCount: number
  maxConcurrentSubagents?: number
  leaseId: string
}

export interface SystemResourceSnapshot {
  protocolVersion?: string
  generation: number
  totalQuanta128k: number
  totalTokens: number
  committedQuanta128k: number
  activeQuanta128k: number
  unreservedFreeQuanta128k: number
  unreservedFreeTokens: number
  freeFullBlocks384k: number
  canAdmitNewLeadConversation: boolean
  activeLeads: number
  subagentCommitmentsMib: number
  active_leads: number
  subagent_commitments_mib: number
  backendReconciled?: boolean
  backendLeadBlockTokens?: number
  backendQuantumTokens?: number
  configuredContextTokens?: number
  capacityMismatch?: boolean
  deferredReleaseSessions?: number
  deferredReleaseSessionIds?: string[]
  quarantinedConversations?: number
  blocks: Array<{
    blockId: 0 | 1 | 2
    mode: "idle" | "384k_locked" | "128k_split"
    ownerConversationId?: string
    slots: number[]
  }>
  slots: Array<{
    slotId: number
    capacityTokens: number
    busy: boolean
    lockedBy384k: boolean
    activeSessionIds: string[]
    pinnedSessionId?: string
  }>
  conversations: Array<{
    conversationId: string
    agentId?: string
    rootSessionId?: string
    leadSlotId: number
    reservedSubagentQuanta: number
    activeSubagentQuanta: number
    activeSubagentCount: number
    maxConcurrentSubagents?: number
  }>
  thisConversation?: {
    conversationId: string
    leadContextTier: "384k"
    leadContextTokens?: number
    subagentQuantumTokens?: number
    leadSlotId: number
    reservedSubagents128k: number
    activeSubagents: number
    activeSubagentQuanta128k: number
    guaranteedAvailable128k: number
    opportunisticAvailable128k: number
    maxSpawnableNow128k: number
    maxSpawnableNow384k: number
    queuedSubagentWaiters: number
  }
}

interface SubagentWaiter {
  readonly id: string
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly tier: "128k" | "256k" | "384k"
  readonly conversationId?: string
  readonly resume: (effect: Effect.Effect<SlotID>) => void
}

interface ComputeWaiter {
  readonly id: string
  readonly sessionID: string
  readonly slot: number
  readonly tier: LeaseTier
  readonly enqueuedAtMs: number
  bypassedWaves: number
  readonly grant: () => void
}

export interface ComputeTurnstileTelemetry {
  activeComputeStreamsCount: number
  queuedComputeWaitersCount: number
  maxComputeStreams: number
  deferredReleaseSessions: number
  deferredReleaseSessionIds: string[]
  quarantinedConversations: number
  activeComputeSlots: Array<{ sessionID: string; slot: number }>
  queuedComputeWaiters: Array<{
    sessionID: string
    slot: number
    tier: LeaseTier
    enqueuedAtMs: number
    bypassedWaves: number
  }>
}

const activeSessionsBySlot: Record<PhysicalSlotID, Set<string>> = {
  0: new Set<string>(),
  1: new Set<string>(),
  2: new Set<string>(),
  3: new Set<string>(),
  4: new Set<string>(),
  5: new Set<string>(),
  6: new Set<string>(),
  7: new Set<string>(),
  8: new Set<string>(),
}

const blockMode: Record<0 | 1 | 2, "idle" | "384k_locked" | "128k_split"> = {
  0: "idle",
  1: "idle",
  2: "idle",
}

const blockOwner: Record<0 | 1 | 2, string | undefined> = {
  0: undefined,
  1: undefined,
  2: undefined,
}

const sessionSlotMap = new Map<string, PhysicalSlotID>()
const sessionTierMap = new Map<string, "128k" | "256k" | "384k">()
const sessionConversationMap = new Map<string, string>()
const childParentMap = new Map<string, string>()
const conversations = new Map<string, AdmittedConversation>()
const conversationBlockMap = new Map<string, 0 | 1 | 2>()
const waiterQueue: SubagentWaiter[] = []
const activeComputeSlotBySession = new Map<string, number>()
export const activeComputeBySession = new Map<string, { count: number; slot: number; startedAt: number }>()
const pendingDeferredReleaseSessions = new Map<string, { purge: boolean }>()
const quarantinedConversations = new Map<string, { purgeSessionID?: string }>()
const computeWaiters: ComputeWaiter[] = []

const lastUsedAtPerSlot: Record<PhysicalSlotID, number> = {
  0: 0,
  1: 0,
  2: 0,
  3: 0,
  4: 0,
  5: 0,
  6: 0,
  7: 0,
  8: 0,
}

let leaseClock = 0
let generation = 1

export const DEFAULT_LEAD_BLOCK_TOKENS = 393_216
export const DEFAULT_QUANTUM_TOKENS = 131_072

let backendLeadBlockTokens = DEFAULT_LEAD_BLOCK_TOKENS
let backendQuantumTokens = DEFAULT_QUANTUM_TOKENS
let backendSlotCapacities: Partial<Record<PhysicalSlotID, number>> = {}
let backendReconciled = false
let configuredModelContextTokens: number | undefined

function isTestRuntime(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    Boolean(process.env.BUN_TEST) ||
    Boolean(process.env.VITEST) ||
    process.argv.some((arg) => arg.includes(".test.") || arg === "test")
  )
}

function readSystemBackendCtxConfig(): { ctxSize?: number; configuredContextTokens?: number } {
  const envCtx = process.env.AQUANOX_BACKEND_CTX_SIZE
  if (envCtx !== undefined && envCtx.trim() !== "") {
    const parsed = Number.parseInt(envCtx.trim(), 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return { ctxSize: parsed }
    }
  }
  if (isTestRuntime()) {
    return {}
  }
  let ctxSize: number | undefined
  let configuredContextTokens: number | undefined
  try {
    const envFile = "/etc/default/deepseek-flash"
    if (fs.existsSync(envFile)) {
      const raw = fs.readFileSync(envFile, "utf8")
      const match = /^CTX_SIZE=(\d+)/m.exec(raw)
      if (match?.[1]) {
        const parsed = Number.parseInt(match[1], 10)
        if (Number.isFinite(parsed) && parsed > 0) {
          ctxSize = parsed
        }
      }
    }
  } catch {
    // ignore
  }
  try {
    const configPath =
      process.env.OPENCODE_CONFIG_PATH ||
      (process.env.HOME
        ? `${process.env.HOME}/.config/opencode/opencode.json`
        : "/home/rjwits/.config/opencode/opencode.json")
    if (fs.existsSync(configPath)) {
      const parsedJson = JSON.parse(fs.readFileSync(configPath, "utf8")) as any
      const cfgCtx = parsedJson?.providers?.["deepseek-local"]?.models?.["deepseek-v4.1-flash"]?.limit?.context
      if (typeof cfgCtx === "number" && cfgCtx > 0) {
        configuredContextTokens = cfgCtx
      }
    }
  } catch {
    // ignore
  }
  return { ctxSize, configuredContextTokens }
}

export function setBackendSlotCapacities(input: {
  slots?: ReadonlyArray<{ id?: number; slot_id?: number; n_ctx: number }>
  defaultNCtx?: number
  configuredContextTokens?: number
}): void {
  if (input.configuredContextTokens !== undefined && input.configuredContextTokens > 0) {
    configuredModelContextTokens = input.configuredContextTokens
  }
  if (input.slots && input.slots.length > 0) {
    const explicitById = new Map<number, number>()
    for (let i = 0; i < input.slots.length; i++) {
      const item = input.slots[i]!
      const id = typeof item.id === "number" ? item.id : typeof item.slot_id === "number" ? item.slot_id : i
      if (typeof item.n_ctx === "number" && item.n_ctx > 0) {
        explicitById.set(id, item.n_ctx)
      }
    }
    const leadNCtx =
      explicitById.get(0) ??
      explicitById.get(3) ??
      explicitById.get(6) ??
      input.defaultNCtx ??
      Math.max(...Array.from(explicitById.values()), 0)
    if (leadNCtx > 0) {
      backendLeadBlockTokens = leadNCtx
      const tailQuantum = explicitById.get(2) ?? explicitById.get(5) ?? explicitById.get(8)
      backendQuantumTokens =
        tailQuantum !== undefined && tailQuantum > 0
          ? tailQuantum
          : Math.max(1024, Math.floor(leadNCtx / 3))
      const nextCapacities: Partial<Record<PhysicalSlotID, number>> = {}
      for (const s of SLOTS) {
        const direct = explicitById.get(s) ?? explicitById.get(s % 3)
        if (direct !== undefined && direct > 0) {
          nextCapacities[s] = direct
        } else {
          nextCapacities[s] =
            s % 3 === 0
              ? backendLeadBlockTokens
              : s % 3 === 1
                ? backendQuantumTokens * 2
                : backendQuantumTokens
        }
      }
      backendSlotCapacities = nextCapacities
      backendReconciled = true
      generation++
      return
    }
  }
  if (input.defaultNCtx !== undefined && input.defaultNCtx > 0) {
    backendLeadBlockTokens = input.defaultNCtx
    backendQuantumTokens = Math.max(1024, Math.floor(input.defaultNCtx / 3))
    const nextCapacities: Partial<Record<PhysicalSlotID, number>> = {}
    for (const s of SLOTS) {
      nextCapacities[s] =
        s % 3 === 0
          ? backendLeadBlockTokens
          : s % 3 === 1
            ? backendQuantumTokens * 2
            : backendQuantumTokens
    }
    backendSlotCapacities = nextCapacities
    backendReconciled = true
    generation++
  }
}

export async function reconcileBackendSlotCapacities(
  baseUrl?: string,
  options?: { configuredContextTokens?: number; timeoutMs?: number },
): Promise<boolean> {
  if (options?.configuredContextTokens !== undefined && options.configuredContextTokens > 0) {
    configuredModelContextTokens = options.configuredContextTokens
  }
  const rawBase = baseUrl || process.env.AQUANOX_LLAMA_SERVER_URL || "http://127.0.0.1:8080"
  const normalizedBase = rawBase.replace(/\/v1\/?$/, "").replace(/\/+$/, "")
  const timeoutMs = options?.timeoutMs ?? 1500
  try {
    const res = await fetch(`${normalizedBase}/slots`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return false
    const data = (await res.json()) as unknown
    const slotArray = Array.isArray(data)
      ? data
      : data && typeof data === "object" && Array.isArray((data as any).slots)
        ? (data as any).slots
        : undefined
    if (!slotArray || slotArray.length === 0) return false
    const parsedSlots: Array<{ id: number; n_ctx: number }> = []
    for (let i = 0; i < slotArray.length; i++) {
      const item = slotArray[i]
      if (item && typeof item === "object") {
        const id = typeof item.id === "number" ? item.id : typeof item.slot_id === "number" ? item.slot_id : i
        const n_ctx = typeof item.n_ctx === "number" ? item.n_ctx : undefined
        if (n_ctx !== undefined && n_ctx > 0) {
          parsedSlots.push({ id, n_ctx })
        }
      }
    }
    if (parsedSlots.length === 0) return false
    setBackendSlotCapacities({
      slots: parsedSlots,
      configuredContextTokens: options?.configuredContextTokens,
    })
    return true
  } catch {
    return false
  }
}

export function isBackendReconciled(): boolean {
  return backendReconciled
}

export function getBackendLeadBlockTokens(): number {
  return backendLeadBlockTokens
}

export function getBackendQuantumTokens(): number {
  return backendQuantumTokens
}

export function getEffectiveSlotContextLimit(
  slotId?: number,
  tier?: LeaseTier,
  configuredContext?: number,
): number {
  if (configuredContext !== undefined && configuredContext > 0 && configuredModelContextTokens === undefined) {
    configuredModelContextTokens = configuredContext
  }
  let slotLimit: number
  if (slotId !== undefined && slotId >= 0 && slotId <= 8) {
    const s = slotId as PhysicalSlotID
    const b = Math.floor(s / 3) as 0 | 1 | 2
    const isChildOrSplit = s % 3 !== 0 || tier === "128k" || blockMode[b] === "128k_split"
    if (isChildOrSplit) {
      slotLimit = Math.min(backendQuantumTokens, backendSlotCapacities[s] ?? backendQuantumTokens)
    } else {
      slotLimit = Math.min(backendLeadBlockTokens, backendSlotCapacities[s] ?? backendLeadBlockTokens)
    }
  } else if (tier === "128k") {
    slotLimit = backendQuantumTokens
  } else if (tier === "256k") {
    slotLimit = backendReconciled ? Math.min(backendLeadBlockTokens, 262_144) : 262_144
  } else {
    slotLimit = backendLeadBlockTokens
  }
  if (configuredContext !== undefined && configuredContext > 0) {
    return Math.min(configuredContext, slotLimit)
  }
  return slotLimit
}

function applyInitialBackendCapacities(): void {
  const sysCfg = readSystemBackendCtxConfig()
  if (sysCfg.ctxSize !== undefined && sysCfg.ctxSize > 0) {
    setBackendSlotCapacities({
      defaultNCtx: sysCfg.ctxSize,
      configuredContextTokens: sysCfg.configuredContextTokens,
    })
  } else {
    backendLeadBlockTokens = DEFAULT_LEAD_BLOCK_TOKENS
    backendQuantumTokens = DEFAULT_QUANTUM_TOKENS
    backendSlotCapacities = {}
    backendReconciled = false
    configuredModelContextTokens = sysCfg.configuredContextTokens
  }
}

applyInitialBackendCapacities()
if (!isTestRuntime()) {
  void reconcileBackendSlotCapacities().catch(() => false)
}

function recordPin(sessionID: string, slot: PhysicalSlotID): void {
  sessionSlotMap.delete(sessionID)
  sessionSlotMap.set(sessionID, slot)
  if (sessionSlotMap.size > MAX_PINNED_SESSIONS) {
    for (const candidate of sessionSlotMap.keys()) {
      let candidateActive = false
      for (const s of SLOTS) {
        if (activeSessionsBySlot[s].has(candidate)) {
          candidateActive = true
          break
        }
      }
      if (!candidateActive) {
        sessionSlotMap.delete(candidate)
        if (sessionSlotMap.size <= MAX_PINNED_SESSIONS) break
      }
    }
  }
}

function pickBestIdleSlot(
  candidateSlots: ReadonlyArray<PhysicalSlotID>,
  pinnedSlots: ReadonlySet<PhysicalSlotID>,
): PhysicalSlotID {
  const unassigned = candidateSlots.find((s) => !pinnedSlots.has(s) || lastUsedAtPerSlot[s] === 0)
  if (unassigned !== undefined) return unassigned
  return candidateSlots.reduce((oldest, s) =>
    lastUsedAtPerSlot[s] < lastUsedAtPerSlot[oldest] ? s : oldest,
  )
}

export function registerChildSession(childID: string, parentID: string): void {
  childParentMap.set(childID, parentID)
}

export function setSessionTier(sessionID: string, tier: "128k" | "256k" | "384k"): void {
  sessionTierMap.set(sessionID, tier)
}

export function getSessionTier(sessionID: string): "128k" | "256k" | "384k" | undefined {
  return sessionTierMap.get(sessionID)
}

export function getConversationIdForSession(sessionID: string): string | undefined {
  let curr: string | undefined = sessionID
  const visited = new Set<string>()
  while (curr && !visited.has(curr)) {
    visited.add(curr)
    const convId = sessionConversationMap.get(curr)
    if (convId) return convId
    curr = childParentMap.get(curr)
  }
  return undefined
}

function computeCommittedQuanta(): number {
  let committed = 0
  for (const conv of conversations.values()) {
    committed += 3 + Math.max(conv.reservedSubagentQuanta, conv.activeSubagentQuanta)
  }
  for (const [sessId, slot] of sessionSlotMap.entries()) {
    if (activeSessionsBySlot[slot].has(sessId) && !sessionConversationMap.has(sessId)) {
      const tier = sessionTierMap.get(sessId) ?? (slot % 3 === 0 ? "384k" : "128k")
      committed += tier === "384k" ? 3 : 1
    }
  }
  return committed
}

function isBlockFree(b: 0 | 1 | 2): boolean {
  if (blockOwner[b] !== undefined || blockMode[b] === "384k_locked") return false
  return (
    activeSessionsBySlot[(b * 3) as PhysicalSlotID].size === 0 &&
    activeSessionsBySlot[(b * 3 + 1) as PhysicalSlotID].size === 0 &&
    activeSessionsBySlot[(b * 3 + 2) as PhysicalSlotID].size === 0
  )
}

function countFreeFullBlocks(): number {
  let count = 0
  for (const b of BUDDY_BLOCKS) {
    if (isBlockFree(b)) count++
  }
  return count
}

export function admitConversation(input: ConversationAdmissionInput): ConversationAdmissionResult {
  const existing = conversations.get(input.conversationId)
  if (existing) {
    const requiredEnvelope = 3 + existing.reservedSubagentQuanta
    const totalCommitted = computeCommittedQuanta()
    return {
      admitted: true,
      leaseId: existing.leaseId,
      generation,
      leadBlockId: existing.leadBlockId,
      leadSlotId: existing.leadSlotId,
      reservedQuanta: requiredEnvelope,
      availableUnreservedQuanta: Math.max(0, 9 - totalCommitted),
      deficitQuanta: 0,
    }
  }

  const rawReserved =
    input.reservedSubagentQuanta ??
    (input.resources?.reservedSubagents
      ? input.resources.reservedSubagents.contextTier === "384k"
        ? input.resources.reservedSubagents.count * 3
        : input.resources.reservedSubagents.count
      : 0)
  const reservedSubagentQuanta = Math.min(rawReserved, MAX_SUBAGENT_QUANTA_PER_CONVERSATION)

  const rawMax = input.maxConcurrentSubagents ?? input.resources?.maxConcurrentSubagents
  const maxConcurrentSubagents = Math.min(
    rawMax ?? MAX_CONCURRENT_SUBAGENTS_PER_CONVERSATION,
    MAX_CONCURRENT_SUBAGENTS_PER_CONVERSATION,
  )

  const requiredEnvelope = 3 + reservedSubagentQuanta
  const totalCommitted = computeCommittedQuanta()

  if (totalCommitted + requiredEnvelope > 9) {
    const deficitQuanta = totalCommitted + requiredEnvelope - 9
    return {
      admitted: false,
      generation,
      reservedQuanta: 0,
      availableUnreservedQuanta: Math.max(0, 9 - totalCommitted),
      deficitQuanta,
      reason: "Insufficient quanta envelope: required " + requiredEnvelope + ", committed " + totalCommitted + ", deficit " + deficitQuanta,
    }
  }

  const stickySessionID =
    input.rootSessionId ?? (input.conversationId.startsWith("conv_") ? input.conversationId.slice(5) : undefined)
  const stickySlot = stickySessionID ? sessionSlotMap.get(stickySessionID) : undefined
  const preferredBlock =
    stickySlot !== undefined
      ? (Math.floor(stickySlot / 3) as 0 | 1 | 2)
      : conversationBlockMap.get(input.conversationId)

  let freeBlock: (0 | 1 | 2) | undefined
  if (preferredBlock !== undefined && isBlockFree(preferredBlock)) {
    freeBlock = preferredBlock
  } else {
    const freeBlocks = BUDDY_BLOCKS.filter(isBlockFree)
    if (freeBlocks.length > 0) {
      const pinnedSlots = new Set(sessionSlotMap.values())
      const unpinned = freeBlocks.find((b) => {
        const leadSlot = (b * 3) as PhysicalSlotID
        return !pinnedSlots.has(leadSlot) || lastUsedAtPerSlot[leadSlot] === 0
      })
      freeBlock =
        unpinned ??
        freeBlocks.reduce((oldest, b) =>
          lastUsedAtPerSlot[(b * 3) as PhysicalSlotID] < lastUsedAtPerSlot[(oldest * 3) as PhysicalSlotID] ? b : oldest,
        )
    }
  }

  if (freeBlock === undefined) {
    return {
      admitted: false,
      generation,
      reservedQuanta: 0,
      availableUnreservedQuanta: Math.max(0, 9 - totalCommitted),
      deficitQuanta: 3,
      reason: "No contiguous Buddy Block available (slots fragmented across blocks)",
    }
  }

  const leaseId = "lease_" + input.conversationId + "_" + (++leaseClock)
  const leadSlotId = (freeBlock * 3) as PhysicalSlotID
  const conv: AdmittedConversation = {
    conversationId: input.conversationId,
    agentId: input.agentId,
    ...(input.rootSessionId ? { rootSessionId: input.rootSessionId } : {}),
    leadBlockId: freeBlock,
    leadSlotId,
    reservedSubagentQuanta,
    activeSubagentQuanta: 0,
    activeSubagentCount: 0,
    maxConcurrentSubagents,
    leaseId,
  }

  conversations.set(input.conversationId, conv)
  conversationBlockMap.set(input.conversationId, freeBlock)
  blockMode[freeBlock] = "384k_locked"
  blockOwner[freeBlock] = input.conversationId
  if (input.rootSessionId) {
    sessionConversationMap.set(input.rootSessionId, input.conversationId)
    sessionTierMap.set(input.rootSessionId, "384k")
    recordPin(input.rootSessionId, leadSlotId)
  }
  generation++

  return {
    admitted: true,
    leaseId,
    generation,
    leadBlockId: freeBlock,
    leadSlotId,
    reservedQuanta: requiredEnvelope,
    availableUnreservedQuanta: Math.max(0, 9 - (totalCommitted + requiredEnvelope)),
    deficitQuanta: 0,
  }
}

export function bindConversationSession(input: {
  conversationId: string
  sessionID: string
}): { ok: boolean; leadSlotId?: number } {
  let conv = conversations.get(input.conversationId)
  if (!conv) {
    const adm = admitConversation({ conversationId: input.conversationId, rootSessionId: input.sessionID })
    if (!adm.admitted) {
      return { ok: false }
    }
    conv = conversations.get(input.conversationId)!
  } else {
    const existingPin = sessionSlotMap.get(input.sessionID)
    if (existingPin !== undefined) {
      const preferredBlock = Math.floor(existingPin / 3) as 0 | 1 | 2
      if (
        preferredBlock !== conv.leadBlockId &&
        activeSessionsBySlot[conv.leadSlotId].size === 0 &&
        isBlockFree(preferredBlock)
      ) {
        blockMode[conv.leadBlockId] = "idle"
        blockOwner[conv.leadBlockId] = undefined
        conv.leadBlockId = preferredBlock
        conv.leadSlotId = (preferredBlock * 3) as PhysicalSlotID
        blockMode[preferredBlock] = "384k_locked"
        blockOwner[preferredBlock] = conv.conversationId
        conversationBlockMap.set(conv.conversationId, preferredBlock)
      }
    }
  }
  conv.rootSessionId = input.sessionID
  sessionConversationMap.set(input.sessionID, input.conversationId)
  sessionTierMap.set(input.sessionID, "384k")
  recordPin(input.sessionID, conv.leadSlotId)
  generation++
  return { ok: true, leadSlotId: conv.leadSlotId }
}

function normalizeComputeSessionID(turnstileKey: string): string {
  return turnstileKey.endsWith(":background_compaction")
    ? turnstileKey.slice(0, -":background_compaction".length)
    : turnstileKey
}

function incrementActiveCompute(turnstileKey: string, slot: number): void {
  const baseId = normalizeComputeSessionID(turnstileKey)
  const existing = activeComputeBySession.get(baseId)
  if (existing) {
    existing.count += 1
    existing.slot = slot
  } else {
    activeComputeBySession.set(baseId, {
      count: 1,
      slot,
      startedAt: Date.now(),
    })
  }
}

function decrementActiveCompute(turnstileKey: string): void {
  const baseId = normalizeComputeSessionID(turnstileKey)
  const existing = activeComputeBySession.get(baseId)
  if (!existing) return
  existing.count -= 1
  if (existing.count <= 0) {
    activeComputeBySession.delete(baseId)
  }
}

export function hasActiveComputeScope(sessionID: string): boolean {
  const baseId = normalizeComputeSessionID(sessionID)
  const entry = activeComputeBySession.get(baseId)
  if (entry && entry.count > 0) return true
  return (
    activeComputeSlotBySession.has(baseId) ||
    activeComputeSlotBySession.has(`${baseId}:background_compaction`)
  )
}

function collectConversationFamilySessions(conversationId: string, extraSessionID?: string): Set<string> {
  const family = new Set<string>()
  const conv = conversations.get(conversationId)
  if (conv?.rootSessionId) family.add(conv.rootSessionId)
  if (extraSessionID) family.add(extraSessionID)
  for (const [sessId, cId] of sessionConversationMap.entries()) {
    if (cId === conversationId) family.add(sessId)
  }
  let added = true
  while (added) {
    added = false
    for (const [childId, parentId] of childParentMap.entries()) {
      if (!family.has(childId) && (family.has(parentId) || getConversationIdForSession(childId) === conversationId)) {
        family.add(childId)
        added = true
      }
    }
  }
  return family
}

function finalizeReleaseConversation(conversationId: string, purgeSessionID?: string): { ok: boolean } {
  quarantinedConversations.delete(conversationId)
  const conv = conversations.get(conversationId)
  if (purgeSessionID) {
    pendingDeferredReleaseSessions.delete(purgeSessionID)
    const pinnedSlot = sessionSlotMap.get(purgeSessionID)
    if (pinnedSlot !== undefined) {
      activeSessionsBySlot[pinnedSlot].delete(purgeSessionID)
      sessionSlotMap.delete(purgeSessionID)
    }
    sessionTierMap.delete(purgeSessionID)
    sessionConversationMap.delete(purgeSessionID)
    conversationBlockMap.delete(conversationId)
  }
  if (!conv) return { ok: Boolean(purgeSessionID) }

  const b = conv.leadBlockId
  blockMode[b] = "idle"
  blockOwner[b] = undefined

  if (conv.rootSessionId) {
    pendingDeferredReleaseSessions.delete(conv.rootSessionId)
    activeSessionsBySlot[conv.leadSlotId].delete(conv.rootSessionId)
    sessionConversationMap.delete(conv.rootSessionId)
    if (purgeSessionID) {
      sessionSlotMap.delete(conv.rootSessionId)
      sessionTierMap.delete(conv.rootSessionId)
    }
  }

  for (let i = waiterQueue.length - 1; i >= 0; i--) {
    const w = waiterQueue[i]
    if (
      w.conversationId === conversationId ||
      (w.parentSessionID !== undefined && sessionConversationMap.get(w.parentSessionID) === conversationId)
    ) {
      waiterQueue.splice(i, 1)
    }
  }

  for (const [sessId, cId] of sessionConversationMap.entries()) {
    if (cId === conversationId) {
      pendingDeferredReleaseSessions.delete(sessId)
      const slot = sessionSlotMap.get(sessId)
      if (slot !== undefined) {
        activeSessionsBySlot[slot].delete(sessId)
        if (purgeSessionID) sessionSlotMap.delete(sessId)
      }
      const bSess = slot !== undefined ? (Math.floor(slot / 3) as 0 | 1 | 2) : undefined
      if (
        bSess !== undefined &&
        blockOwner[bSess] === undefined &&
        activeSessionsBySlot[(bSess * 3) as PhysicalSlotID].size === 0 &&
        activeSessionsBySlot[(bSess * 3 + 1) as PhysicalSlotID].size === 0 &&
        activeSessionsBySlot[(bSess * 3 + 2) as PhysicalSlotID].size === 0
      ) {
        blockMode[bSess] = "idle"
      }
      if (purgeSessionID) sessionTierMap.delete(sessId)
      sessionConversationMap.delete(sessId)
    }
  }

  conversations.delete(conversationId)
  generation++

  drainWaiters()
  return { ok: true }
}

export function releaseConversation(conversationId: string, purgeSessionID?: string): { ok: boolean } {
  for (let i = waiterQueue.length - 1; i >= 0; i--) {
    const w = waiterQueue[i]
    if (
      w.conversationId === conversationId ||
      (w.parentSessionID !== undefined && sessionConversationMap.get(w.parentSessionID) === conversationId)
    ) {
      waiterQueue.splice(i, 1)
    }
  }

  const familySessions = collectConversationFamilySessions(conversationId, purgeSessionID)
  const activeFamilySessions = Array.from(familySessions).filter((sid) => hasActiveComputeScope(sid))

  if (activeFamilySessions.length > 0) {
    const conv = conversations.get(conversationId)
    for (const sid of familySessions) {
      removeWaitersForSession(sid)
      if (hasActiveComputeScope(sid)) {
        const computeSlot =
          activeComputeBySession.get(sid)?.slot ??
          activeComputeSlotBySession.get(sid) ??
          activeComputeSlotBySession.get(`${sid}:background_compaction`) ??
          sessionSlotMap.get(sid)
        if (computeSlot !== undefined && computeSlot >= 0 && computeSlot <= 8) {
          const phys = computeSlot as PhysicalSlotID
          activeSessionsBySlot[phys].add(sid)
          recordPin(sid, phys)
        }
        const prev = pendingDeferredReleaseSessions.get(sid)
        pendingDeferredReleaseSessions.set(sid, {
          purge: Boolean(prev?.purge || purgeSessionID !== undefined),
        })
      } else if (!conv || sid !== conv.rootSessionId) {
        performImmediateRelease(sid, { purge: purgeSessionID !== undefined })
      }
    }
    if (conv) {
      conv.reservedSubagentQuanta = conv.activeSubagentQuanta
    }
    const prevQ = quarantinedConversations.get(conversationId)
    quarantinedConversations.set(conversationId, {
      purgeSessionID: purgeSessionID ?? prevQ?.purgeSessionID,
    })
    generation++
    drainWaiters()
    return { ok: true }
  }

  return finalizeReleaseConversation(conversationId, purgeSessionID)
}

function tryAcquireSubagentSync(input: {
  sessionID: string
  parentSessionID?: string
  tier: "128k" | "256k" | "384k"
}): PhysicalSlotID | undefined {
  const tier = input.tier
  const existingSlot = sessionSlotMap.get(input.sessionID)
  if (existingSlot !== undefined && activeSessionsBySlot[existingSlot]?.has(input.sessionID)) {
    const existingTier = sessionTierMap.get(input.sessionID) ?? "128k"
    const requestedEffectiveTier = tier === "128k" ? "128k" : "384k"
    if (existingTier === requestedEffectiveTier) {
      lastUsedAtPerSlot[existingSlot] = ++leaseClock
      recordPin(input.sessionID, existingSlot)
      return existingSlot
    }
  }

  const neededQuanta = tier === "128k" ? 1 : 3
  const convId = input.parentSessionID ? getConversationIdForSession(input.parentSessionID) : undefined
  const conv = convId ? conversations.get(convId) : undefined

  if (conv) {
    const maxSubagentCap = Math.min(conv.maxConcurrentSubagents ?? MAX_CONCURRENT_SUBAGENTS_PER_CONVERSATION, MAX_CONCURRENT_SUBAGENTS_PER_CONVERSATION)
    if (conv.activeSubagentCount >= maxSubagentCap) {
      return undefined
    }
    if (conv.activeSubagentQuanta + neededQuanta > MAX_SUBAGENT_QUANTA_PER_CONVERSATION) {
      return undefined
    }
  }

  const totalCommitted = computeCommittedQuanta()
  const unreservedFree = Math.max(0, 9 - totalCommitted)
  let availQuanta = unreservedFree
  if (conv) {
    const remReserved = Math.max(0, conv.reservedSubagentQuanta - conv.activeSubagentQuanta)
    availQuanta = remReserved + unreservedFree
  }
  if (availQuanta < neededQuanta) {
    return undefined
  }

  if (tier === "128k") {
    const sticky = sessionSlotMap.get(input.sessionID)
    if (sticky !== undefined) {
      const b = Math.floor(sticky / 3) as 0 | 1 | 2
      if (
        blockMode[b] !== "384k_locked" &&
        activeSessionsBySlot[sticky].size === 0
      ) {
        activeSessionsBySlot[sticky].add(input.sessionID)
        lastUsedAtPerSlot[sticky] = ++leaseClock
        recordPin(input.sessionID, sticky)
        sessionTierMap.set(input.sessionID, "128k")
        if (conv) {
          conv.activeSubagentQuanta += 1
          conv.activeSubagentCount += 1
          sessionConversationMap.set(input.sessionID, conv.conversationId)
        }
        blockMode[b] = "128k_split"
        generation++
        return sticky
      }
    }

    const splitBlockSlots: PhysicalSlotID[] = []
    const idleBlockSlots: PhysicalSlotID[] = []

    for (const s of SUBAGENT_SLOT_PREFERENCE) {
      const b = Math.floor(s / 3) as 0 | 1 | 2
      if (blockMode[b] === "384k_locked") continue
      if (activeSessionsBySlot[s].size > 0) continue

      if (blockMode[b] === "128k_split") {
        splitBlockSlots.push(s)
      } else if (blockMode[b] === "idle") {
        idleBlockSlots.push(s)
      }
    }

    const candidateSlot = splitBlockSlots[0] ?? idleBlockSlots[0]
    if (candidateSlot === undefined) {
      return undefined
    }

    const b = Math.floor(candidateSlot / 3) as 0 | 1 | 2
    blockMode[b] = "128k_split"
    activeSessionsBySlot[candidateSlot].add(input.sessionID)
    lastUsedAtPerSlot[candidateSlot] = ++leaseClock
    recordPin(input.sessionID, candidateSlot)
    sessionTierMap.set(input.sessionID, "128k")
    if (conv) {
      conv.activeSubagentQuanta += 1
      conv.activeSubagentCount += 1
      sessionConversationMap.set(input.sessionID, conv.conversationId)
    }
    generation++
    return candidateSlot
  } else {
    for (const b of BUDDY_BLOCKS) {
      if (blockMode[b] !== "idle" || blockOwner[b] !== undefined) continue
      if (
        activeSessionsBySlot[(b * 3) as PhysicalSlotID].size === 0 &&
        activeSessionsBySlot[(b * 3 + 1) as PhysicalSlotID].size === 0 &&
        activeSessionsBySlot[(b * 3 + 2) as PhysicalSlotID].size === 0
      ) {
        const leadSlot = (b * 3) as PhysicalSlotID
        blockMode[b] = "384k_locked"
        activeSessionsBySlot[leadSlot].add(input.sessionID)
        lastUsedAtPerSlot[leadSlot] = ++leaseClock
        recordPin(input.sessionID, leadSlot)
        sessionTierMap.set(input.sessionID, "384k")
        if (conv) {
          conv.activeSubagentQuanta += 3
          conv.activeSubagentCount += 1
          sessionConversationMap.set(input.sessionID, conv.conversationId)
        }
        generation++
        return leadSlot
      }
    }
    return undefined
  }
}

function drainWaiters(): void {
  let progress = true
  while (progress && waiterQueue.length > 0) {
    progress = false
    for (let i = 0; i < waiterQueue.length; i++) {
      const waiter = waiterQueue[i]
      const slot = tryAcquireSubagentSync({
        sessionID: waiter.sessionID,
        parentSessionID: waiter.parentSessionID,
        tier: waiter.tier,
      })
      if (slot !== undefined) {
        waiterQueue.splice(i, 1)
        waiter.resume(Effect.succeed(slot))
        progress = true
        break
      }
    }
  }
}

export function removeWaitersForSession(sessionID: string): number {
  let removed = 0
  for (let i = waiterQueue.length - 1; i >= 0; i--) {
    if (waiterQueue[i].sessionID === sessionID) {
      waiterQueue.splice(i, 1)
      removed++
    }
  }
  return removed
}

export function isActivelyHeld(sessionID: string): PhysicalSlotID | undefined {
  for (const s of SLOTS) {
    if (activeSessionsBySlot[s].has(sessionID)) return s
  }
  return undefined
}

export function acquireSubagentAsync(input: {
  sessionID: string
  parentSessionID?: string
  tier: "128k" | "256k" | "384k"
}): Effect.Effect<SlotID> {
  return Effect.callback<SlotID>((resume) => {
    const immediate = tryAcquireSubagentSync(input)
    if (immediate !== undefined) {
      resume(Effect.succeed(immediate))
      return
    }

    const waiterId = "waiter_" + input.sessionID + "_" + (++leaseClock)
    const convId = input.parentSessionID ? getConversationIdForSession(input.parentSessionID) : undefined
    const waiter: SubagentWaiter = {
      id: waiterId,
      sessionID: input.sessionID,
      parentSessionID: input.parentSessionID,
      tier: input.tier,
      conversationId: convId,
      resume,
    }
    waiterQueue.push(waiter)
    return Effect.sync(() => {
      const idx = waiterQueue.findIndex((w) => w.id === waiterId)
      if (idx !== -1) {
        waiterQueue.splice(idx, 1)
      }
    })
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        removeWaitersForSession(input.sessionID)
      }),
    ),
  )
}

export function withTierLease<A, E, R>(
  input: {
    sessionID: string
    parentSessionID?: string
    tier: "128k" | "256k" | "384k"
  },
  use: (slot: SlotID) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    acquireSubagentAsync(input),
    (slot) => use(slot),
    () => Effect.sync(() => release(input.sessionID)),
  )
}

export function acquire(sessionID: string, isSubagent?: boolean): SlotID {
  const isSub = Boolean(isSubagent)

  const convId = sessionConversationMap.get(sessionID)
  const conv = convId ? conversations.get(convId) : undefined
  if (conv && !isSub) {
    activeSessionsBySlot[conv.leadSlotId].add(sessionID)
    lastUsedAtPerSlot[conv.leadSlotId] = ++leaseClock
    recordPin(sessionID, conv.leadSlotId)
    return conv.leadSlotId
  }

  if (isSub && conversations.size > 0) {
    const parentID = childParentMap.get(sessionID)
    const tier = sessionTierMap.get(sessionID) ?? "128k"
    const slot = tryAcquireSubagentSync({ sessionID, parentSessionID: parentID, tier })
    if (slot !== undefined) return slot
    return -1
  }

  const sticky = sessionSlotMap.get(sessionID)
  if (sticky !== undefined) {
    const b = Math.floor(sticky / 3) as 0 | 1 | 2
    const isLockedBy384k = blockMode[b] === "384k_locked" && sticky % 3 !== 0
    const ownedByOtherConv = blockOwner[b] !== undefined && blockOwner[b] !== convId
    if (!isLockedBy384k && !ownedByOtherConv) {
      const isOwnerActive = activeSessionsBySlot[sticky].has(sessionID)
      const isIdle = activeSessionsBySlot[sticky].size === 0
      if (isOwnerActive || (isIdle && (conversations.size === 0 || isSub))) {
        activeSessionsBySlot[sticky].add(sessionID)
        lastUsedAtPerSlot[sticky] = ++leaseClock
        recordPin(sessionID, sticky)
        return sticky
      }
    }
  }

  if (!isSub && conversations.size > 0) {
    const autoAdm = admitConversation({ conversationId: "conv_" + sessionID, rootSessionId: sessionID })
    if (autoAdm.admitted && autoAdm.leadSlotId !== undefined) {
      const slot = autoAdm.leadSlotId as PhysicalSlotID
      bindConversationSession({ conversationId: "conv_" + sessionID, sessionID })
      activeSessionsBySlot[slot].add(sessionID)
      lastUsedAtPerSlot[slot] = ++leaseClock
      recordPin(sessionID, slot)
      return slot
    }
    return -1
  }

  const primaryPool: ReadonlyArray<PhysicalSlotID> = isSub ? [1, 2] : [0]
  const fallbackPool: ReadonlyArray<PhysicalSlotID> = isSub ? [0] : [1, 2]

  const primaryIdle = primaryPool.filter((s) => {
    const b = Math.floor(s / 3) as 0 | 1 | 2
    return (
      activeSessionsBySlot[s].size === 0 &&
      blockOwner[b] === undefined &&
      !(blockMode[b] === "384k_locked" && s % 3 !== 0)
    )
  })
  const pinnedSlots = new Set(sessionSlotMap.values())

  if (primaryIdle.length > 0) {
    const chosen = pickBestIdleSlot(primaryIdle, pinnedSlots)
    activeSessionsBySlot[chosen].add(sessionID)
    lastUsedAtPerSlot[chosen] = ++leaseClock
    recordPin(sessionID, chosen)
    return chosen
  }

  const fallbackIdle = fallbackPool.filter((s) => {
    const b = Math.floor(s / 3) as 0 | 1 | 2
    return (
      activeSessionsBySlot[s].size === 0 &&
      blockOwner[b] === undefined &&
      !(blockMode[b] === "384k_locked" && s % 3 !== 0)
    )
  })
  if (fallbackIdle.length > 0) {
    const chosen = pickBestIdleSlot(fallbackIdle, pinnedSlots)
    activeSessionsBySlot[chosen].add(sessionID)
    lastUsedAtPerSlot[chosen] = ++leaseClock
    recordPin(sessionID, chosen)
    return chosen
  }

  return -1
}

export function resolveMaxComputeStreams(): number {
  const raw = process.env.AQUANOX_MAX_COMPUTE_STREAMS
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw.trim(), 10)
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.min(9, parsed)
    }
  }
  return DEFAULT_STRIDE_ALIGNED_COMPUTE_STREAMS
}

function computeWaiterAffinityScore(w: ComputeWaiter): number {
  if (activeComputeSlotBySession.size === 0) return 0
  let strideMatches = 0
  let splitBlockMatches = 0
  const waiterBlock = Math.floor(w.slot / 3) as 0 | 1 | 2
  const waiterMod3 = ((w.slot % 3) + 3) % 3

  for (const [activeSessionID, activeSlot] of activeComputeSlotBySession.entries()) {
    const activeMod3 = ((activeSlot % 3) + 3) % 3
    if (waiterMod3 === activeMod3) {
      strideMatches += 1
    }

    const activeBlock = Math.floor(activeSlot / 3) as 0 | 1 | 2
    const activeTier = sessionTierMap.get(activeSessionID)
    const isSplitSubagentBlock =
      blockMode[activeBlock] !== "384k_locked" &&
      activeTier !== "384k" &&
      (blockMode[activeBlock] === "128k_split" ||
        activeTier === "128k" ||
        childParentMap.has(activeSessionID) ||
        activeBlock >= 1 ||
        activeSlot % 3 !== 0 ||
        w.slot % 3 !== 0)

    if (waiterBlock === activeBlock && isSplitSubagentBlock && w.tier !== "384k") {
      splitBlockMatches += 1
    }
  }

  const totalActive = activeComputeSlotBySession.size
  if (strideMatches === totalActive) {
    return 100 + strideMatches * 10 + splitBlockMatches
  }
  if (splitBlockMatches === totalActive) {
    return 95 + splitBlockMatches * 10 + strideMatches
  }
  if (strideMatches > 0 || splitBlockMatches > 0) {
    return Math.max(strideMatches, splitBlockMatches) * 10 + strideMatches + splitBlockMatches
  }
  return 0
}

function selectNextComputeWaiterIndex(): number {
  if (computeWaiters.length === 0) return -1
  if (computeWaiters.length === 1) return 0

  const oldest = computeWaiters[0]!
  const nowMs = Date.now()
  if (
    nowMs - oldest.enqueuedAtMs >= COMPUTE_STARVATION_THRESHOLD_MS ||
    oldest.bypassedWaves >= COMPUTE_STARVATION_MAX_BYPASSED_WAVES
  ) {
    return 0
  }

  if (activeComputeSlotBySession.size === 0) {
    return 0
  }

  let bestIdx = 0
  let bestScore = computeWaiterAffinityScore(oldest)
  for (let i = 1; i < computeWaiters.length; i++) {
    const score = computeWaiterAffinityScore(computeWaiters[i]!)
    if (score > bestScore) {
      bestScore = score
      bestIdx = i
    }
  }
  return bestIdx
}

function drainComputeWaiters(): void {
  while (
    computeWaiters.length > 0 &&
    activeComputeSlotBySession.size < resolveMaxComputeStreams()
  ) {
    const nextIdx = selectNextComputeWaiterIndex()
    if (nextIdx < 0 || nextIdx >= computeWaiters.length) break
    for (let i = 0; i < nextIdx; i++) {
      computeWaiters[i]!.bypassedWaves += 1
    }
    const [chosen] = computeWaiters.splice(nextIdx, 1)
    if (!chosen) break
    activeComputeSlotBySession.set(chosen.sessionID, chosen.slot)
    incrementActiveCompute(chosen.sessionID, chosen.slot)
    chosen.grant()
  }
}

export function removeComputeWaitersForSession(sessionID: string): number {
  let removed = 0
  for (let i = computeWaiters.length - 1; i >= 0; i--) {
    if (computeWaiters[i]!.sessionID === sessionID) {
      computeWaiters.splice(i, 1)
      removed++
    }
  }
  return removed
}

function completeDeferredReleasesIfIdle(baseSessionID: string): void {
  if (hasActiveComputeScope(baseSessionID)) return

  const deferred = pendingDeferredReleaseSessions.get(baseSessionID)
  if (deferred) {
    pendingDeferredReleaseSessions.delete(baseSessionID)
    performImmediateRelease(baseSessionID, { purge: deferred.purge })
  }

  if (quarantinedConversations.size > 0) {
    for (const [cId, qInfo] of Array.from(quarantinedConversations.entries())) {
      const family = collectConversationFamilySessions(cId, qInfo.purgeSessionID)
      const stillActive = Array.from(family).some((sid) => hasActiveComputeScope(sid))
      if (!stillActive) {
        finalizeReleaseConversation(cId, qInfo.purgeSessionID)
      }
    }
  }
}

function releaseComputePermit(sessionID: string): void {
  removeComputeWaitersForSession(sessionID)
  const hadPermit = activeComputeSlotBySession.delete(sessionID)
  if (hadPermit) {
    decrementActiveCompute(sessionID)
    drainComputeWaiters()
  }
  const baseId = normalizeComputeSessionID(sessionID)
  completeDeferredReleasesIfIdle(baseId)
}

function acquireComputePermit(
  sessionID: string,
  slot: number,
  options?: { enqueuedAtMs?: number },
): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    if (activeComputeSlotBySession.get(sessionID) !== undefined) {
      resume(Effect.void)
      return
    }

    const maxStreams = resolveMaxComputeStreams()
    if (activeComputeSlotBySession.size < maxStreams && computeWaiters.length === 0) {
      activeComputeSlotBySession.set(sessionID, slot)
      incrementActiveCompute(sessionID, slot)
      resume(Effect.void)
      return
    }

    const waiterId = "cwait_" + sessionID + "_" + (++leaseClock)
    const tier: LeaseTier =
      sessionTierMap.get(sessionID) ?? (slot % 3 === 0 ? "384k" : "128k")
    const waiter: ComputeWaiter = {
      id: waiterId,
      sessionID,
      slot,
      tier,
      enqueuedAtMs: options?.enqueuedAtMs ?? Date.now(),
      bypassedWaves: 0,
      grant: () => {
        resume(Effect.void)
      },
    }
    computeWaiters.push(waiter)

    return Effect.sync(() => {
      const idx = computeWaiters.findIndex((w) => w.id === waiterId)
      if (idx !== -1) {
        computeWaiters.splice(idx, 1)
      }
    })
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        removeComputeWaitersForSession(sessionID)
      }),
    ),
  )
}

export function withComputeTurnstile<A, E, R>(
  sessionID: string,
  slot: number | undefined,
  use: () => Effect.Effect<A, E, R>,
  options?: { enqueuedAtMs?: number },
): Effect.Effect<A, E, R> {
  if (slot === undefined || slot < 0) {
    return use()
  }

  return Effect.suspend(() => {
    if (activeComputeSlotBySession.get(sessionID) !== undefined) {
      incrementActiveCompute(sessionID, slot)
      return use().pipe(
        Effect.ensuring(
          Effect.sync(() => {
            decrementActiveCompute(sessionID)
            completeDeferredReleasesIfIdle(normalizeComputeSessionID(sessionID))
          }),
        ),
      )
    }

    return acquireComputePermit(sessionID, slot, options).pipe(
      Effect.andThen(() => use()),
      Effect.ensuring(
        Effect.sync(() => {
          releaseComputePermit(sessionID)
        }),
      ),
    )
  })
}

export function getTelemetry(): ComputeTurnstileTelemetry {
  return {
    activeComputeStreamsCount: activeComputeSlotBySession.size,
    queuedComputeWaitersCount: computeWaiters.length,
    maxComputeStreams: resolveMaxComputeStreams(),
    deferredReleaseSessions: pendingDeferredReleaseSessions.size,
    deferredReleaseSessionIds: Array.from(pendingDeferredReleaseSessions.keys()),
    quarantinedConversations: quarantinedConversations.size,
    activeComputeSlots: Array.from(activeComputeSlotBySession.entries()).map(([sessionID, slot]) => ({
      sessionID,
      slot,
    })),
    queuedComputeWaiters: computeWaiters.map((w) => ({
      sessionID: w.sessionID,
      slot: w.slot,
      tier: w.tier,
      enqueuedAtMs: w.enqueuedAtMs,
      bypassedWaves: w.bypassedWaves,
    })),
  }
}

function performImmediateRelease(sessionID: string, options?: { purge?: boolean }): void {
  pendingDeferredReleaseSessions.delete(sessionID)
  let releasedSlot: PhysicalSlotID | undefined
  for (const s of SLOTS) {
    if (activeSessionsBySlot[s].has(sessionID)) {
      activeSessionsBySlot[s].delete(sessionID)
      releasedSlot = s
    }
  }

  if (releasedSlot !== undefined) {
    const b = Math.floor(releasedSlot / 3) as 0 | 1 | 2
    const tier = sessionTierMap.get(sessionID) ?? (releasedSlot % 3 === 0 ? "384k" : "128k")
    const convId = sessionConversationMap.get(sessionID)
    const conv = convId ? conversations.get(convId) : undefined

    if (conv && conv.rootSessionId !== sessionID) {
      const quanta = tier === "384k" ? 3 : 1
      conv.activeSubagentQuanta = Math.max(0, conv.activeSubagentQuanta - quanta)
      conv.activeSubagentCount = Math.max(0, conv.activeSubagentCount - 1)
    }

    if (tier === "384k") {
      if (blockOwner[b] === undefined) {
        blockMode[b] = "idle"
      }
    } else {
      if (
        blockOwner[b] === undefined &&
        activeSessionsBySlot[(b * 3) as PhysicalSlotID].size === 0 &&
        activeSessionsBySlot[(b * 3 + 1) as PhysicalSlotID].size === 0 &&
        activeSessionsBySlot[(b * 3 + 2) as PhysicalSlotID].size === 0
      ) {
        blockMode[b] = "idle"
      }
    }
    generation++
    drainWaiters()
  }

  if (options?.purge) {
    sessionSlotMap.delete(sessionID)
    sessionTierMap.delete(sessionID)
    sessionConversationMap.delete(sessionID)
    childParentMap.delete(sessionID)
  }
}

export function release(sessionID: string): void {
  const baseId = normalizeComputeSessionID(sessionID)
  if (hasActiveComputeScope(baseId)) {
    removeWaitersForSession(baseId)
    const computeSlot =
      activeComputeBySession.get(baseId)?.slot ??
      activeComputeSlotBySession.get(baseId) ??
      activeComputeSlotBySession.get(`${baseId}:background_compaction`) ??
      sessionSlotMap.get(baseId)
    if (computeSlot !== undefined && computeSlot >= 0 && computeSlot <= 8) {
      const phys = computeSlot as PhysicalSlotID
      activeSessionsBySlot[phys].add(baseId)
      recordPin(baseId, phys)
    }
    const prev = pendingDeferredReleaseSessions.get(baseId)
    pendingDeferredReleaseSessions.set(baseId, {
      purge: Boolean(prev?.purge),
    })
    generation++
    return
  }

  performImmediateRelease(baseId)
}

function performReleaseSubagentSession(sessionID: string, options?: { purge?: boolean }): void {
  const baseId = normalizeComputeSessionID(sessionID)
  removeWaitersForSession(baseId)
  if (hasActiveComputeScope(baseId)) {
    const computeSlot =
      activeComputeBySession.get(baseId)?.slot ??
      activeComputeSlotBySession.get(baseId) ??
      activeComputeSlotBySession.get(`${baseId}:background_compaction`) ??
      sessionSlotMap.get(baseId)
    if (computeSlot !== undefined && computeSlot >= 0 && computeSlot <= 8) {
      const phys = computeSlot as PhysicalSlotID
      activeSessionsBySlot[phys].add(baseId)
      recordPin(baseId, phys)
    }
    const prev = pendingDeferredReleaseSessions.get(baseId)
    pendingDeferredReleaseSessions.set(baseId, {
      purge: Boolean(prev?.purge || options?.purge),
    })
    generation++
    return
  }
  performImmediateRelease(baseId, options)
}

export function releaseSubagentSession(
  sessionID: string,
  options?: { purge?: boolean },
): Effect.Effect<void> {
  performReleaseSubagentSession(sessionID, options)
  return Effect.void
}

export function peek(sessionID: string, _isSubagent?: boolean): SlotID | undefined {
  for (const s of SLOTS) {
    if (activeSessionsBySlot[s].has(sessionID)) return s
  }
  return sessionSlotMap.get(sessionID)
}

export function activeCount(slot: SlotID | ChildSlotID): number {
  if (slot === -1) return 0
  return activeSessionsBySlot[slot as PhysicalSlotID]?.size ?? 0
}

export function reset(): void {
  for (const s of SLOTS) {
    activeSessionsBySlot[s].clear()
    lastUsedAtPerSlot[s] = 0
  }
  for (const b of BUDDY_BLOCKS) {
    blockMode[b] = "idle"
    blockOwner[b] = undefined
  }
  sessionSlotMap.clear()
  sessionTierMap.clear()
  sessionConversationMap.clear()
  childParentMap.clear()
  conversations.clear()
  conversationBlockMap.clear()
  waiterQueue.length = 0
  activeComputeSlotBySession.clear()
  activeComputeBySession.clear()
  pendingDeferredReleaseSessions.clear()
  quarantinedConversations.clear()
  computeWaiters.length = 0
  leaseClock = 0
  generation = 1
  applyInitialBackendCapacities()
}

export function resetForTesting(): void {
  reset()
  if (!process.env.AQUANOX_BACKEND_CTX_SIZE) {
    backendLeadBlockTokens = DEFAULT_LEAD_BLOCK_TOKENS
    backendQuantumTokens = DEFAULT_QUANTUM_TOKENS
    backendSlotCapacities = {}
    backendReconciled = false
    configuredModelContextTokens = undefined
  }
}

export function withSubagentLease<A, E, R>(
  sessionID: string,
  use: (slot: SlotID) => Effect.Effect<A, E, R>,
  options?: { parentSessionID?: string; tier?: LeaseTier },
): Effect.Effect<A, E, R> {
  const parentID = options?.parentSessionID ?? childParentMap.get(sessionID)
  const tier = options?.tier ?? sessionTierMap.get(sessionID) ?? "128k"
  return withTierLease({ sessionID, parentSessionID: parentID, tier }, use)
}

export function withLease<A, E, R>(
  sessionID: string,
  isSubagent: boolean,
  use: (slot: SlotID) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  if (isSubagent) {
    const parentID = childParentMap.get(sessionID)
    const tier = sessionTierMap.get(sessionID) ?? "128k"
    return withTierLease({ sessionID, parentSessionID: parentID, tier }, use)
  }
  return Effect.acquireUseRelease(
    Effect.sync(() => acquire(sessionID, false)),
    (slot) => use(slot),
    () => Effect.sync(() => release(sessionID)),
  )
}

export function withGpuToolSlotPolicy<A, E, R>(
  sessionID: string,
  use: () => Effect.Effect<A, E, R>,
  options?: { suspendMode?: "keep_reserved" | "evict_and_reacquire" | "save_full_state" },
): Effect.Effect<A, E, R> {
  const rawMode = options?.suspendMode ?? "keep_reserved"
  const suspendMode =
    rawMode === "save_full_state" && process.env.AQUANOX_FULL_SLOT_STATE_SAVE !== "1"
      ? "keep_reserved"
      : rawMode

  if (suspendMode !== "evict_and_reacquire") {
    return use().pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          removeWaitersForSession(sessionID)
        }),
      ),
    )
  }

  return Effect.gen(function* () {
    const parentID = childParentMap.get(sessionID)
    const tier = sessionTierMap.get(sessionID) ?? "128k"
    release(sessionID)
    sessionSlotMap.delete(sessionID)
    const result = yield* use()
    yield* acquireSubagentAsync({ sessionID, parentSessionID: parentID, tier }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          removeWaitersForSession(sessionID)
        }),
      ),
    )
    return result
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        removeWaitersForSession(sessionID)
      }),
    ),
  )
}

export function getResourceSnapshot(query?: {
  conversationId?: string
  sessionId?: string
}): SystemResourceSnapshot {
  const committedQuanta128k = computeCommittedQuanta()
  const unreservedFreeQuanta128k = Math.max(0, 9 - committedQuanta128k)
  const freeFullBlocks384k = countFreeFullBlocks()
  const canAdmitNewLeadConversation = freeFullBlocks384k >= 1 && unreservedFreeQuanta128k >= 3

  let activeQuanta = 0
  for (const s of SLOTS) {
    if (activeSessionsBySlot[s].size > 0) {
      const b = Math.floor(s / 3) as 0 | 1 | 2
      if (blockMode[b] === "384k_locked" && s % 3 === 0) {
        activeQuanta += 3
      } else {
        activeQuanta += 1
      }
    }
  }

  const blocks = BUDDY_BLOCKS.map((b) => ({
    blockId: b,
    mode: blockMode[b],
    ownerConversationId: blockOwner[b],
    slots: [b * 3, b * 3 + 1, b * 3 + 2],
  }))

  const slots = SLOTS.map((s) => {
    const b = Math.floor(s / 3) as 0 | 1 | 2
    const lockedBy384k = blockMode[b] === "384k_locked" && s % 3 !== 0
    const capacityTokens: number =
      blockMode[b] === "384k_locked" && s % 3 === 0
        ? backendLeadBlockTokens
        : (backendSlotCapacities[s] ?? backendQuantumTokens)
    const pinned = Array.from(sessionSlotMap.entries()).find(([_, slot]) => slot === s)?.[0]
    return {
      slotId: s,
      capacityTokens,
      busy: activeSessionsBySlot[s].size > 0,
      lockedBy384k,
      activeSessionIds: Array.from(activeSessionsBySlot[s]),
      pinnedSessionId: pinned,
    }
  })

  const convList = Array.from(conversations.values()).map((c) => ({
    conversationId: c.conversationId,
    agentId: c.agentId,
    rootSessionId: c.rootSessionId,
    leadSlotId: c.leadSlotId,
    reservedSubagentQuanta: c.reservedSubagentQuanta,
    activeSubagentQuanta: c.activeSubagentQuanta,
    activeSubagentCount: c.activeSubagentCount,
    maxConcurrentSubagents: c.maxConcurrentSubagents,
  }))

  const targetConvId =
    query?.conversationId ?? (query?.sessionId ? getConversationIdForSession(query.sessionId) : undefined)
  const conv = targetConvId ? conversations.get(targetConvId) : undefined

  let thisConversation: SystemResourceSnapshot["thisConversation"] | undefined
  if (conv) {
    const guaranteed = Math.max(0, conv.reservedSubagentQuanta - conv.activeSubagentQuanta)
    const opportunistic = unreservedFreeQuanta128k
    const maxSubCap = Math.min(conv.maxConcurrentSubagents ?? MAX_CONCURRENT_SUBAGENTS_PER_CONVERSATION, MAX_CONCURRENT_SUBAGENTS_PER_CONVERSATION)
    const allowedByCap = Math.max(0, maxSubCap - conv.activeSubagentCount)
    const allowedByQuanta = Math.max(0, MAX_SUBAGENT_QUANTA_PER_CONVERSATION - conv.activeSubagentQuanta)
    const totalAvailForConv = guaranteed + opportunistic

    const free128kSlots = SLOTS.filter((s) => {
      const b = Math.floor(s / 3) as 0 | 1 | 2
      return blockMode[b] !== "384k_locked" && activeSessionsBySlot[s].size === 0
    }).length

    const maxSpawnableNow128k = Math.min(allowedByCap, allowedByQuanta, totalAvailForConv, free128kSlots)
    const maxSpawnableNow384k =
      allowedByCap >= 1 &&
      allowedByQuanta >= 3 &&
      totalAvailForConv >= 3 &&
      freeFullBlocks384k >= 1
        ? 1
        : 0

    const queuedWaiters = waiterQueue.filter((w) => w.conversationId === conv.conversationId).length

    thisConversation = {
      conversationId: conv.conversationId,
      leadContextTier: "384k",
      leadContextTokens: backendLeadBlockTokens,
      subagentQuantumTokens: backendQuantumTokens,
      leadSlotId: conv.leadSlotId,
      reservedSubagents128k: conv.reservedSubagentQuanta,
      activeSubagents: conv.activeSubagentCount,
      activeSubagentQuanta128k: conv.activeSubagentQuanta,
      guaranteedAvailable128k: guaranteed,
      opportunisticAvailable128k: opportunistic,
      maxSpawnableNow128k,
      maxSpawnableNow384k,
      queuedSubagentWaiters: queuedWaiters,
    }
  }

  const lockedLeadBlocks = BUDDY_BLOCKS.filter((b) => blockMode[b] === "384k_locked").length
  let standaloneLeads = 0
  let standaloneSubagents = 0
  for (const s of SLOTS) {
    for (const sessId of activeSessionsBySlot[s]) {
      if (!sessionConversationMap.has(sessId)) {
        const isSub = childParentMap.has(sessId) || sessionTierMap.get(sessId) === "128k"
        if (isSub) {
          standaloneSubagents += 1
        } else {
          standaloneLeads += 1
        }
      }
    }
  }
  const activeLeads = Math.max(conversations.size, lockedLeadBlocks, standaloneLeads)
  const committedSubagentQuanta =
    Array.from(conversations.values()).reduce(
      (sum, c) => sum + Math.max(c.reservedSubagentQuanta, c.activeSubagentQuanta),
      0,
    ) + standaloneSubagents
  const subagentCommitmentsMib = committedSubagentQuanta * 2048

  const capacityMismatch =
    configuredModelContextTokens !== undefined && configuredModelContextTokens !== backendLeadBlockTokens

  return {
    protocolVersion: aquanox_slot_lease_v12_0,
    generation,
    totalQuanta128k: 9,
    totalTokens: 9 * backendQuantumTokens,
    committedQuanta128k,
    activeQuanta128k: activeQuanta,
    unreservedFreeQuanta128k,
    unreservedFreeTokens: unreservedFreeQuanta128k * backendQuantumTokens,
    freeFullBlocks384k,
    canAdmitNewLeadConversation,
    activeLeads,
    subagentCommitmentsMib,
    active_leads: activeLeads,
    subagent_commitments_mib: subagentCommitmentsMib,
    backendReconciled,
    backendLeadBlockTokens,
    backendQuantumTokens,
    ...(configuredModelContextTokens !== undefined ? { configuredContextTokens: configuredModelContextTokens } : {}),
    capacityMismatch,
    deferredReleaseSessions: pendingDeferredReleaseSessions.size,
    deferredReleaseSessionIds: Array.from(pendingDeferredReleaseSessions.keys()),
    quarantinedConversations: quarantinedConversations.size,
    blocks,
    slots,
    conversations: convList,
    thisConversation,
  }
}

export const snapshot = getResourceSnapshot
