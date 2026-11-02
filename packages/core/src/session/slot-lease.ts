export * as SessionSlotLease from "./slot-lease.js"

import { Effect } from "effect"

export type SlotID = -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
export type PhysicalSlotID = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
export type ChildSlotID = 1 | 2 | 4 | 5 | 7 | 8

export const SLOTS: ReadonlyArray<PhysicalSlotID> = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const
export const BUDDY_BLOCKS: ReadonlyArray<0 | 1 | 2> = [0, 1, 2] as const
export const MAX_CONCURRENT_SUBAGENTS_PER_CONVERSATION = 3
export const MAX_SUBAGENT_QUANTA_PER_CONVERSATION = 3

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
  generation: number
  totalQuanta128k: number
  totalTokens: number
  committedQuanta128k: number
  activeQuanta128k: number
  unreservedFreeQuanta128k: number
  unreservedFreeTokens: number
  freeFullBlocks384k: number
  canAdmitNewLeadConversation: boolean
  blocks: Array<{
    blockId: 0 | 1 | 2
    mode: "idle" | "384k_locked" | "128k_split"
    ownerConversationId?: string
    slots: number[]
  }>
  slots: Array<{
    slotId: number
    capacityTokens: 131072 | 393216
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
const waiterQueue: SubagentWaiter[] = []

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

function countFreeFullBlocks(): number {
  let count = 0
  for (const b of BUDDY_BLOCKS) {
    if (blockOwner[b] !== undefined || blockMode[b] === "384k_locked") continue
    if (
      activeSessionsBySlot[(b * 3) as PhysicalSlotID].size === 0 &&
      activeSessionsBySlot[(b * 3 + 1) as PhysicalSlotID].size === 0 &&
      activeSessionsBySlot[(b * 3 + 2) as PhysicalSlotID].size === 0
    ) {
      count++
    }
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

  let freeBlock: (0 | 1 | 2) | undefined
  for (const b of BUDDY_BLOCKS) {
    if (blockOwner[b] !== undefined || blockMode[b] === "384k_locked") continue
    if (
      activeSessionsBySlot[(b * 3) as PhysicalSlotID].size === 0 &&
      activeSessionsBySlot[(b * 3 + 1) as PhysicalSlotID].size === 0 &&
      activeSessionsBySlot[(b * 3 + 2) as PhysicalSlotID].size === 0
    ) {
      freeBlock = b
      break
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
    leadBlockId: freeBlock,
    leadSlotId,
    reservedSubagentQuanta,
    activeSubagentQuanta: 0,
    activeSubagentCount: 0,
    maxConcurrentSubagents,
    leaseId,
  }

  conversations.set(input.conversationId, conv)
  blockMode[freeBlock] = "384k_locked"
  blockOwner[freeBlock] = input.conversationId
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
    const adm = admitConversation({ conversationId: input.conversationId })
    if (!adm.admitted) {
      return { ok: false }
    }
    conv = conversations.get(input.conversationId)!
  }
  conv.rootSessionId = input.sessionID
  sessionConversationMap.set(input.sessionID, input.conversationId)
  sessionTierMap.set(input.sessionID, "384k")
  recordPin(input.sessionID, conv.leadSlotId)
  generation++
  return { ok: true, leadSlotId: conv.leadSlotId }
}

export function releaseConversation(conversationId: string): { ok: boolean } {
  const conv = conversations.get(conversationId)
  if (!conv) return { ok: false }

  const b = conv.leadBlockId
  blockMode[b] = "idle"
  blockOwner[b] = undefined

  if (conv.rootSessionId) {
    activeSessionsBySlot[conv.leadSlotId].delete(conv.rootSessionId)
    sessionConversationMap.delete(conv.rootSessionId)
  }

  for (const [sessId, cId] of sessionConversationMap.entries()) {
    if (cId === conversationId) {
      const slot = sessionSlotMap.get(sessId)
      if (slot !== undefined) {
        activeSessionsBySlot[slot].delete(sessId)
      }
      sessionConversationMap.delete(sessId)
    }
  }

  conversations.delete(conversationId)
  generation++

  drainWaiters()
  return { ok: true }
}

function tryAcquireSubagentSync(input: {
  sessionID: string
  parentSessionID?: string
  tier: "128k" | "256k" | "384k"
}): PhysicalSlotID | undefined {
  const tier = input.tier
  const neededQuanta = tier === "384k" ? 3 : 1
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
        (activeSessionsBySlot[sticky].has(input.sessionID) || activeSessionsBySlot[sticky].size === 0)
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

    const SUBAGENT_SLOT_PREFERENCE: ReadonlyArray<PhysicalSlotID> = [2, 5, 8, 1, 4, 7] as const
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
  })
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
    if (!isLockedBy384k) {
      const isOwnerActive = activeSessionsBySlot[sticky].has(sessionID)
      const isIdle = activeSessionsBySlot[sticky].size === 0
      if (isOwnerActive || isIdle) {
        activeSessionsBySlot[sticky].add(sessionID)
        lastUsedAtPerSlot[sticky] = ++leaseClock
        recordPin(sessionID, sticky)
        return sticky
      }
    }
  }

  if (!isSub && conversations.size > 0) {
    const autoAdm = admitConversation({ conversationId: "conv_" + sessionID })
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

  const primaryIdle = primaryPool.filter((s) => activeSessionsBySlot[s].size === 0 && !(blockMode[Math.floor(s / 3) as 0 | 1 | 2] === "384k_locked" && s % 3 !== 0))
  const pinnedSlots = new Set(sessionSlotMap.values())

  if (primaryIdle.length > 0) {
    const chosen = pickBestIdleSlot(primaryIdle, pinnedSlots)
    activeSessionsBySlot[chosen].add(sessionID)
    lastUsedAtPerSlot[chosen] = ++leaseClock
    recordPin(sessionID, chosen)
    return chosen
  }

  const fallbackIdle = fallbackPool.filter((s) => activeSessionsBySlot[s].size === 0 && !(blockMode[Math.floor(s / 3) as 0 | 1 | 2] === "384k_locked" && s % 3 !== 0))
  if (fallbackIdle.length > 0) {
    const chosen = pickBestIdleSlot(fallbackIdle, pinnedSlots)
    activeSessionsBySlot[chosen].add(sessionID)
    lastUsedAtPerSlot[chosen] = ++leaseClock
    recordPin(sessionID, chosen)
    return chosen
  }

  return -1
}

export function release(sessionID: string): void {
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
  waiterQueue.length = 0
  leaseClock = 0
  generation = 1
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
    const capacityTokens: 131072 | 393216 =
      blockMode[b] === "384k_locked" && s % 3 === 0 ? 393216 : 131072
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

  return {
    generation,
    totalQuanta128k: 9,
    totalTokens: 1179648,
    committedQuanta128k,
    activeQuanta128k: activeQuanta,
    unreservedFreeQuanta128k,
    unreservedFreeTokens: unreservedFreeQuanta128k * 131072,
    freeFullBlocks384k,
    canAdmitNewLeadConversation,
    blocks,
    slots,
    conversations: convList,
    thisConversation,
  }
}
