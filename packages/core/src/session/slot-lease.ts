export * as SessionSlotLease from "./slot-lease.js"

import { Effect } from "effect"

export type SlotID = -1 | 0 | 1 | 2
export type ChildSlotID = 1 | 2

export const SLOTS: ReadonlyArray<0 | 1 | 2> = [0, 1, 2] as const

const MAX_PINNED_SESSIONS = 256

const activeSessionsBySlot: Record<0 | 1 | 2, Set<string>> = {
  0: new Set<string>(),
  1: new Set<string>(),
  2: new Set<string>(),
}

const sessionSlotMap = new Map<string, 0 | 1 | 2>()
const lastUsedAtPerSlot: Record<0 | 1 | 2, number> = {
  0: 0,
  1: 0,
  2: 0,
}
let leaseClock = 0

function recordPin(sessionID: string, slot: 0 | 1 | 2): void {
  sessionSlotMap.delete(sessionID)
  sessionSlotMap.set(sessionID, slot)
  if (sessionSlotMap.size > MAX_PINNED_SESSIONS) {
    for (const candidate of sessionSlotMap.keys()) {
      if (
        !activeSessionsBySlot[0].has(candidate) &&
        !activeSessionsBySlot[1].has(candidate) &&
        !activeSessionsBySlot[2].has(candidate)
      ) {
        sessionSlotMap.delete(candidate)
        if (sessionSlotMap.size <= MAX_PINNED_SESSIONS) break
      }
    }
  }
}

function pickBestIdleSlot(
  candidateSlots: ReadonlyArray<0 | 1 | 2>,
  pinnedSlots: ReadonlySet<0 | 1 | 2>,
): 0 | 1 | 2 {
  // Prefer an unassigned slot first (not pinned to any session or never used)
  const unassigned = candidateSlots.find((s) => !pinnedSlots.has(s) || lastUsedAtPerSlot[s] === 0)
  if (unassigned !== undefined) return unassigned
  // Otherwise pick the oldest idle LRU
  return candidateSlots.reduce((oldest, s) =>
    lastUsedAtPerSlot[s] < lastUsedAtPerSlot[oldest] ? s : oldest,
  )
}

/**
 * Deterministically assigns and pins llama-server KV slots across --parallel 3:
 * Manages a 3-slot pool {0, 1, 2} dynamically across all sessions (both root and child subagents):
 * 1. If sessionID already owns a sticky slotId and activeCountPerSlot[slotId] === 0
 *    (or sessionID is already active on it), reuse slotId!
 * 2. Otherwise (either new session, OR its sticky slotId is currently busy serving another session!),
 *    if any slot in {0, 1, 2} has activeCountPerSlot[s] === 0, assign the least-recently-used idle slot s
 *    (preferring primary pool unassigned first, then oldest idle LRU, then fallback pool) and update sessionSlotMap.
 * 3. If all 3 slots {0, 1, 2} currently have activeCountPerSlot[s] > 0, pass id_slot = -1
 *    (letting llama-server's Net-Token get_available_slot() dispatch to whichever slot finishes first
 *    without head-of-line pinning).
 */
export function acquire(sessionID: string, isSubagent?: boolean): SlotID {
  const isSub = Boolean(isSubagent)

  // 1. If sessionID already owns a sticky slotId and it is idle (or held by sessionID), reuse it!
  const sticky = sessionSlotMap.get(sessionID)
  if (sticky !== undefined) {
    const isOwnerActive = activeSessionsBySlot[sticky].has(sessionID)
    const isIdle = activeSessionsBySlot[sticky].size === 0
    if (isOwnerActive || isIdle) {
      activeSessionsBySlot[sticky].add(sessionID)
      lastUsedAtPerSlot[sticky] = ++leaseClock
      recordPin(sessionID, sticky)
      return sticky
    }
  }

  // 2. Dynamic pool allocation across {0, 1, 2}
  // Primary preferences: root prefers Slot 0; child subagents prefer Slots 1 and 2.
  // Both fall back across all idle slots in {0, 1, 2} if primary slots are busy.
  const primaryPool: ReadonlyArray<0 | 1 | 2> = isSub ? [1, 2] : [0]
  const fallbackPool: ReadonlyArray<0 | 1 | 2> = isSub ? [0] : [1, 2]

  const primaryIdle = primaryPool.filter((s) => activeSessionsBySlot[s].size === 0)
  const pinnedSlots = new Set(sessionSlotMap.values())

  if (primaryIdle.length > 0) {
    const chosen = pickBestIdleSlot(primaryIdle, pinnedSlots)
    activeSessionsBySlot[chosen].add(sessionID)
    lastUsedAtPerSlot[chosen] = ++leaseClock
    recordPin(sessionID, chosen)
    return chosen
  }

  const fallbackIdle = fallbackPool.filter((s) => activeSessionsBySlot[s].size === 0)
  if (fallbackIdle.length > 0) {
    const chosen = pickBestIdleSlot(fallbackIdle, pinnedSlots)
    activeSessionsBySlot[chosen].add(sessionID)
    lastUsedAtPerSlot[chosen] = ++leaseClock
    recordPin(sessionID, chosen)
    return chosen
  }

  // 3. All 3 slots currently have activeCount > 0: return -1 (dynamic llama-server dispatch)
  return -1
}

/**
 * Releases the active lease for a session when its turn finishes,
 * while retaining its slot affinity in sessionSlotMap for future continuations.
 */
export function release(sessionID: string): void {
  for (const s of SLOTS) {
    activeSessionsBySlot[s].delete(sessionID)
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
  return activeSessionsBySlot[slot].size
}

export function reset(): void {
  for (const s of SLOTS) {
    activeSessionsBySlot[s].clear()
    lastUsedAtPerSlot[s] = 0
  }
  sessionSlotMap.clear()
  leaseClock = 0
}

/**
 * Runs an effect with a guaranteed acquire/release lifecycle using Effect.acquireUseRelease,
 * ensuring active counts never leak on error or interruption.
 */
export function withLease<A, E, R>(
  sessionID: string,
  isSubagent: boolean,
  use: (slot: SlotID) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => acquire(sessionID, isSubagent)),
    (slot) => use(slot),
    () => Effect.sync(() => release(sessionID)),
  )
}
