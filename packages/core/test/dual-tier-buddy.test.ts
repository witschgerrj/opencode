import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { resolveSessionContextTier } from "@opencode/core/session/runner/model"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionSlotLease } from "@opencode/core/session/slot-lease"
import {
  acquireCompactionSlotEffect,
  calculateCeiling,
  due,
  estimateConversationMessageTokens,
  resolveCompactionLeaseOrFail,
  resolveCompactionSlotOrFail,
  extractCompactionSlot,
  resolveCompactionRequestSlot,
  attachSlotToRequest,
  attachSlotToOptions,
  withCompactionLeaseAndTurnstile,
  activePrecomputeFibers,
  interruptPrecompute,
  awaitPrecompute,
  shouldPrecompute,
} from "@opencode/core/session/compaction"
import { deriveFallbackTitle } from "@opencode/core/session/title"
import { MAX_SUBAGENT_DEPTH, resolveMaxSubagentDepth } from "@opencode/core/tool/plugin/subagent"
import { ConfigMarkdown } from "@opencode/core/config/markdown"
import { Money } from "@opencode/schema/money"
import { DateTime, Deferred, Effect, Exit, Fiber } from "effect"
import fs from "node:fs"

const created = DateTime.makeUnsafe(1_700_000_000_000)

const zeroTokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

const makeSession = (id: string, parentID?: string, metadata?: Record<string, unknown>): SessionSchema.Info =>
  SessionSchema.Info.make({
    id: SessionSchema.ID.make(id),
    projectID: Project.ID.global,
    location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
    ...(parentID ? { parentID: SessionSchema.ID.make(parentID) } : {}),
    cost: Money.USD.zero,
    tokens: zeroTokens,
    title: id,
    time: { created, updated: created },
    ...(metadata ? { metadata } : {}),
  })

const makeUserMessage = (text: string): SessionMessage.User =>
  SessionMessage.User.make({
    id: SessionMessage.ID.make("msg_user_1"),
    type: "user",
    text,
    time: { created },
  })

describe("Aquanox Dual-Tier 9-Quantum Coordinator — SessionSlotLease Buddy Arena", () => {
  beforeEach(() => {
    SessionSlotLease.reset()
  })

  test("initial snapshot reflects 9 idle quanta and 3 free 384k buddy blocks", () => {
    const snap = SessionSlotLease.getResourceSnapshot()
    expect(snap.totalQuanta128k).toBe(9)
    expect(snap.totalTokens).toBe(1_179_648)
    expect(snap.committedQuanta128k).toBe(0)
    expect(snap.activeQuanta128k).toBe(0)
    expect(snap.unreservedFreeQuanta128k).toBe(9)
    expect(snap.freeFullBlocks384k).toBe(3)
    expect(snap.canAdmitNewLeadConversation).toBe(true)
    expect(snap.blocks.length).toBe(3)
    expect(snap.slots.length).toBe(9)
    for (const b of snap.blocks) {
      expect(b.mode).toBe("idle")
      expect(b.ownerConversationId).toBeUndefined()
    }
  })

  test("admits lead conversation with 384k lead + 3 reserved 128k subagents and locks Block 0", () => {
    const adm = SessionSlotLease.admitConversation({
      conversationId: "conv_animator",
      agentId: "master-animator",
      resources: {
        contextTier: "384k",
        reservedSubagents: { count: 3, contextTier: "128k" },
        maxConcurrentSubagents: 3,
      },
    })
    expect(adm.admitted).toBe(true)
    expect(adm.leadSlotId).toBe(0)
    expect(adm.leadBlockId).toBe(0)

    const snap = SessionSlotLease.getResourceSnapshot({ conversationId: "conv_animator" })
    expect(snap.committedQuanta128k).toBe(6) // 3 lead + 3 reserved
    expect(snap.unreservedFreeQuanta128k).toBe(3)
    expect(snap.freeFullBlocks384k).toBe(2) // Block 1 and 2
    expect(snap.canAdmitNewLeadConversation).toBe(true) // 1 block (3 quanta) still free

    const thisConv = snap.thisConversation!
    expect(thisConv.leadSlotId).toBe(0)
    expect(thisConv.reservedSubagents128k).toBe(3)
    expect(thisConv.guaranteedAvailable128k).toBe(3)
    expect(thisConv.opportunisticAvailable128k).toBe(3)
    // Hard ceiling: max 3 concurrent subagents per conversation
    expect(thisConv.maxSpawnableNow128k).toBe(3)
    // 1 full 384k subagent allowed when all 3 quanta are available
    expect(thisConv.maxSpawnableNow384k).toBe(1)
  })

  test("admits second lead conversation (384k lead, 0 reserved) and rejects third due to quota exhaustion", () => {
    // 1. Admit first conversation (6 quanta committed: 3 lead + 3 reserved)
    SessionSlotLease.admitConversation({
      conversationId: "conv_1",
      resources: {
        contextTier: "384k",
        reservedSubagents: { count: 3, contextTier: "128k" },
      },
    })

    // 2. Admit second conversation (3 quanta committed: 3 lead + 0 reserved)
    const adm2 = SessionSlotLease.admitConversation({
      conversationId: "conv_2",
      resources: { contextTier: "384k" },
    })
    expect(adm2.admitted).toBe(true)
    expect(adm2.leadSlotId).toBe(3) // Block 1

    const snap2 = SessionSlotLease.getResourceSnapshot()
    expect(snap2.committedQuanta128k).toBe(9) // Fully committed
    expect(snap2.unreservedFreeQuanta128k).toBe(0)
    expect(snap2.canAdmitNewLeadConversation).toBe(false)

    // 3. Third conversation admission rejected
    const adm3 = SessionSlotLease.admitConversation({
      conversationId: "conv_3",
      resources: { contextTier: "384k" },
    })
    expect(adm3.admitted).toBe(false)
    expect(adm3.reason).toContain("Insufficient quanta envelope")
  })

  test("allocates subagents into independent split blocks while keeping 384k buddy blocks sealed", () => {
    // Admit conv_1 with lead in Block 0 (slot 0)
    SessionSlotLease.admitConversation({
      conversationId: "conv_animator",
      resources: {
        contextTier: "384k",
        reservedSubagents: { count: 3, contextTier: "128k" },
        maxConcurrentSubagents: 3,
      },
    })
    SessionSlotLease.bindConversationSession({ conversationId: "conv_animator", sessionID: "ses_lead" })

    // Root acquires Slot 0
    const leadSlot = SessionSlotLease.acquire("ses_lead", false)
    expect(leadSlot).toBe(0)

    // Subagent 1 acquires a slot: Block 0 is 384k_locked, so sibling slots 1 & 2 are sealed!
    // It must allocate into an idle block, turning it into 128k_split.
    SessionSlotLease.registerChildSession("ses_sub_1", "ses_lead")
    SessionSlotLease.setSessionTier("ses_sub_1", "128k")

    const sub1Slot = Effect.runSync(
      SessionSlotLease.acquireSubagentAsync({
        sessionID: "ses_sub_1",
        parentSessionID: "ses_lead",
        tier: "128k",
      }),
    )
    // Sibling slots 1 and 2 in Block 0 must NOT be given to subagent while Block 0 is 384k_locked!
    expect(sub1Slot).not.toBe(1)
    expect(sub1Slot).not.toBe(2)
    // Should be from Block 1 or Block 2 (e.g. 3, 4, 5, 6, 7, 8)
    expect(sub1Slot).toBeGreaterThanOrEqual(3)

    // Verify snapshot reflects active subagent
    const snap = SessionSlotLease.getResourceSnapshot({ conversationId: "conv_animator" })
    expect(snap.thisConversation?.activeSubagents).toBe(1)
    expect(snap.thisConversation?.activeSubagentQuanta128k).toBe(1)

    // Release subagent
    SessionSlotLease.release("ses_sub_1")
    const snapAfter = SessionSlotLease.getResourceSnapshot({ conversationId: "conv_animator" })
    expect(snapAfter.thisConversation?.activeSubagents).toBe(0)
  })

  test("releases conversation and reclaims all committed buddy arena resources", () => {
    SessionSlotLease.admitConversation({
      conversationId: "conv_to_release",
      resources: {
        contextTier: "384k",
        reservedSubagents: { count: 3, contextTier: "128k" },
      },
    })
    SessionSlotLease.bindConversationSession({ conversationId: "conv_to_release", sessionID: "ses_lead" })
    SessionSlotLease.acquire("ses_lead", false)

    const released = SessionSlotLease.releaseConversation("conv_to_release")
    expect(released.ok).toBe(true)

    const snap = SessionSlotLease.getResourceSnapshot()
    expect(snap.committedQuanta128k).toBe(0)
    expect(snap.unreservedFreeQuanta128k).toBe(9)
    expect(snap.freeFullBlocks384k).toBe(3)
    expect(snap.canAdmitNewLeadConversation).toBe(true)
  })

  test("idempotent sticky subagent re-acquisition does not leak activeSubagents or quanta", () => {
    SessionSlotLease.admitConversation({
      conversationId: "conv_idempotent",
      resources: {
        contextTier: "384k",
        reservedSubagents: { count: 3, contextTier: "128k" },
        maxConcurrentSubagents: 3,
      },
    })
    SessionSlotLease.bindConversationSession({ conversationId: "conv_idempotent", sessionID: "ses_lead" })
    SessionSlotLease.acquire("ses_lead", false)

    SessionSlotLease.registerChildSession("ses_sub_1", "ses_lead")
    SessionSlotLease.setSessionTier("ses_sub_1", "128k")

    const slotA = Effect.runSync(
      SessionSlotLease.acquireSubagentAsync({
        sessionID: "ses_sub_1",
        parentSessionID: "ses_lead",
        tier: "128k",
      }),
    )
    const slotB = Effect.runSync(
      SessionSlotLease.acquireSubagentAsync({
        sessionID: "ses_sub_1",
        parentSessionID: "ses_lead",
        tier: "128k",
      }),
    )
    expect(slotB).toBe(slotA)

    const snapDuring = SessionSlotLease.getResourceSnapshot({ conversationId: "conv_idempotent" })
    expect(snapDuring.thisConversation?.activeSubagents).toBe(1)
    expect(snapDuring.thisConversation?.activeSubagentQuanta128k).toBe(1)

    SessionSlotLease.release("ses_sub_1")
    const snapAfter = SessionSlotLease.getResourceSnapshot({ conversationId: "conv_idempotent" })
    expect(snapAfter.thisConversation?.activeSubagents).toBe(0)
    expect(snapAfter.thisConversation?.activeSubagentQuanta128k).toBe(0)
  })
})

describe("Aquanox Dual-Tier Context Engine — Tier Resolution & Compaction Ceiling", () => {
  test("resolveSessionContextTier resolves 256k for standard lead, 384k for explicit lead, and 128k for subagents", () => {
    const rootSession = makeSession("ses_root")
    expect(resolveSessionContextTier(rootSession)).toBe("256k")

    const root384 = makeSession("ses_root_384", undefined, { contextTier: "384k" })
    expect(resolveSessionContextTier(root384)).toBe("384k")

    const subDefault = makeSession("ses_sub_1", "ses_root")
    expect(resolveSessionContextTier(subDefault)).toBe("128k")

    const subExplicit128 = makeSession("ses_sub_2", "ses_root", { contextTier: "128k" })
    expect(resolveSessionContextTier(subExplicit128)).toBe("128k")

    const subExplicit384 = makeSession("ses_sub_3", "ses_root", { contextTier: "384k" })
    expect(resolveSessionContextTier(subExplicit384)).toBe("384k")
  })

  test("calculateCeiling enforces 98,304 tokens for 128k tier and 334,234 tokens for 384k tier", () => {
    // 128k tier: window = 131072, effectiveBuffer = 32768, ceiling = 98304
    const ceiling128 = calculateCeiling({ context: 131_072, output: 16_384 }, undefined, "deepseek-local")
    expect(ceiling128).toBe(98_304)

    // 384k tier: window = 393216, floor = Math.floor(0.85 * 393216) = 334233, ceiling = 334234
    const ceiling384 = calculateCeiling({ context: 393_216, output: 32_768 }, undefined, "deepseek-local")
    expect(ceiling384).toBe(334_234)
  })
})


  test("preserves sticky Buddy Block affinity across conversation release and re-admission and prevents 4th-root corruption", () => {
    SessionSlotLease.reset()
    // Admit conv_0 (Block 0) and conv_1 (Block 1)
    const adm0 = SessionSlotLease.admitConversation({ conversationId: "conv_0", rootSessionId: "ses_root_0" })
    const adm1 = SessionSlotLease.admitConversation({ conversationId: "conv_1", rootSessionId: "ses_root_1" })
    expect(adm0.leadBlockId).toBe(0)
    expect(adm1.leadBlockId).toBe(1)

    // Release both conversations; both Block 0 and Block 1 are now free, but ses_root_1 has sticky pin on Block 1 (slot 3)
    SessionSlotLease.releaseConversation("conv_0")
    SessionSlotLease.releaseConversation("conv_1")

    // Re-admitting ses_root_1 preferentially re-assigns Block 1 (slot 3) rather than jumping to Block 0!
    const reAdm1 = SessionSlotLease.admitConversation({ conversationId: "conv_1_resumed", rootSessionId: "ses_root_1" })
    expect(reAdm1.admitted).toBe(true)
    expect(reAdm1.leadBlockId).toBe(1)
    expect(reAdm1.leadSlotId).toBe(3)

    // Admit conv_0 and conv_2 to fill all 3 Buddy Blocks (0, 1, 2)
    const reAdm0 = SessionSlotLease.admitConversation({ conversationId: "conv_0_resumed", rootSessionId: "ses_root_0" })
    const adm2 = SessionSlotLease.admitConversation({ conversationId: "conv_2", rootSessionId: "ses_root_2" })
    expect(reAdm0.leadBlockId).toBe(0)
    expect(adm2.leadBlockId).toBe(2)

    // A 4th root session attempting acquire() under full 3-block contention gets -1 without stealing any locked Buddy Block
    expect(SessionSlotLease.acquire("ses_root_4", false)).toBe(-1)
  })

describe("Aquanox Dual-Tier Reasoning Engine — Causal Reasoning Budget Capping", () => {
  test("caps subagent reasoning budget at <= 8192 across all variants and continuation states", () => {
    const userMsg = makeUserMessage("Inspect mesh topology")

    // Turn entry for lead session with variant 'high' -> 8192
    const leadHigh = SessionRunnerLLM.computeCausalReasoningBudget({
      messages: [userMsg],
      variant: "high",
      isSubagent: false,
      isExplore: false,
      isSynthesizing: false,
      stepLimitReached: false,
    })
    expect(leadHigh).toBe(2048)

    // Turn entry for lead session with variant 'max' -> 12288
    const leadMax = SessionRunnerLLM.computeCausalReasoningBudget({
      messages: [userMsg],
      variant: "max",
      isSubagent: false,
      isExplore: false,
      isSynthesizing: false,
      stepLimitReached: false,
    })
    expect(leadMax).toBe(2048)

    // Turn entry for SUBAGENT session with variant 'high' -> capped at 8192!
    const subHigh = SessionRunnerLLM.computeCausalReasoningBudget({
      messages: [userMsg],
      variant: "high",
      isSubagent: true,
      isExplore: false,
      isSynthesizing: false,
      stepLimitReached: false,
    })
    expect(subHigh).toBe(2048)

    // Turn entry for SUBAGENT session with variant 'max' -> capped at 8192!
    const subMax = SessionRunnerLLM.computeCausalReasoningBudget({
      messages: [userMsg],
      variant: "max",
      isSubagent: true,
      isExplore: false,
      isSynthesizing: false,
      stepLimitReached: false,
    })
    expect(subMax).toBe(2048)

    // Mutating continuation for subagent -> 4096 (non-truncating ceiling)
    const subMutating = SessionRunnerLLM.computeCausalReasoningBudget({
      messages: [userMsg],
      variant: "high",
      isSubagent: true,
      isExplore: false,
      isSynthesizing: false,
      stepLimitReached: false,
    })
    expect(subMutating).toBeLessThanOrEqual(2048)
  })
})

describe("Aquanox Dual-Tier Agent Profiles — Frontmatter Verification", () => {
  const candidateDirs = [
    "/Users/rjwits/github/open-world/.opencode/agents",
    "/home/rjwits/github/open-world/.opencode/agents",
    "/Users/rjwits/worktrees/open-world-dual-tier/.opencode/agents",
    "/home/rjwits/worktrees/open-world-dual-tier/.opencode/agents",
  ]
  const openWorldAgentsDir = candidateDirs.find((d) => fs.existsSync(d)) ?? "/Users/rjwits/github/open-world/.opencode/agents"

  test("master-animator.md configures 384k lead tier, 3 reserved 128k subagents, max 3 concurrent", () => {
    const raw = fs.readFileSync(`${openWorldAgentsDir}/master-animator.md`, "utf8")
    const parsed = ConfigMarkdown.parseOption(raw)?.data as any
    expect(parsed.resources).toBeDefined()
    expect(parsed.resources.contextTier).toBe("384k")
    expect(parsed.resources.reservedSubagents).toEqual({ count: 3, contextTier: "128k" })
    expect(parsed.resources.maxConcurrentSubagents).toBe(3)
  })

  test("all 3 companion animation subagents configure 128k contextTier", () => {
    for (const sub of ["animation-keyframe-reviewer.md", "animation-review-committee-member.md", "animation-movement-researcher.md"]) {
      const raw = fs.readFileSync(`${openWorldAgentsDir}/${sub}`, "utf8")
      const parsed = ConfigMarkdown.parseOption(raw)?.data as any
      expect(parsed.resources).toBeDefined()
      expect(parsed.resources.contextTier).toBe("128k")
    }
  })

  test("all 8 deterministic lead agent workflows configure 384k contextTier", () => {
    const leads = [
      "agent-one.md",
      "boulder-outcrop-sculptor.md",
      "landform-cliff-mason.md",
      "meadow-grass-cultivator.md",
      "rodin-stage1-to-3-author.md",
      "topological-rig-calisthenics-certifier.md",
      "tree-species-architect.md",
      "wind-field-integrator.md",
    ]
    for (const lead of leads) {
      const raw = fs.readFileSync(`${openWorldAgentsDir}/${lead}`, "utf8")
      const parsed = ConfigMarkdown.parseOption(raw)?.data as any
      expect(parsed.resources).toBeDefined()
      expect(parsed.resources.contextTier).toBe("384k")
    }
  })
})

describe("Aquanox Dual-Tier v12.0 Coordinator — Profile A (9 Active Quanta) & Single-Lead Packing", () => {
  beforeEach(() => {
    SessionSlotLease.reset()
  })

  test("Profile A (9 active quanta): 2 384k Leads on Blocks 0 & 1 (slots 0 and 3) + 3 128k Subagents deterministically acquiring slots 8, 7, 6 in Block 2", () => {
    expect(SessionSlotLease.SUBAGENT_SLOT_PREFERENCE).toEqual([2, 5, 8, 1, 4, 7, 0, 3, 6])

    // 1. Admit Lead 1 (384k, 0 reserved) -> locks Block 0 (slot 0)
    const admLead1 = SessionSlotLease.admitConversation({
      conversationId: "conv_lead_1",
      resources: { contextTier: "384k" },
    })
    expect(admLead1.admitted).toBe(true)
    expect(admLead1.leadBlockId).toBe(0)
    expect(admLead1.leadSlotId).toBe(0)
    SessionSlotLease.bindConversationSession({ conversationId: "conv_lead_1", sessionID: "ses_lead_1" })
    expect(SessionSlotLease.acquire("ses_lead_1", false)).toBe(0)

    // 2. Admit Lead 2 (384k, 0 reserved) -> locks Block 1 (slot 3)
    const admLead2 = SessionSlotLease.admitConversation({
      conversationId: "conv_lead_2",
      resources: { contextTier: "384k" },
    })
    expect(admLead2.admitted).toBe(true)
    expect(admLead2.leadBlockId).toBe(1)
    expect(admLead2.leadSlotId).toBe(3)
    SessionSlotLease.bindConversationSession({ conversationId: "conv_lead_2", sessionID: "ses_lead_2" })
    expect(SessionSlotLease.acquire("ses_lead_2", false)).toBe(3)

    // With Blocks 0 & 1 locked by 384k leads, candidate subagent slots are in Block 2.
    // SUBAGENT_SLOT_PREFERENCE = [2, 5, 8, 1, 4, 7, 0, 3, 6]
    // 2 and 5 are sealed (Blocks 0 & 1 are 384k_locked).
    // So for idle Block 2, it splits Block 2 and deterministically allocates slots 8, 7, 6!
    SessionSlotLease.registerChildSession("ses_sub_1", "ses_lead_1")
    SessionSlotLease.setSessionTier("ses_sub_1", "128k")
    const slotSub1 = Effect.runSync(
      SessionSlotLease.acquireSubagentAsync({
        sessionID: "ses_sub_1",
        parentSessionID: "ses_lead_1",
        tier: "128k",
      }),
    )
    expect(slotSub1).toBe(8)

    SessionSlotLease.registerChildSession("ses_sub_2", "ses_lead_1")
    SessionSlotLease.setSessionTier("ses_sub_2", "128k")
    const slotSub2 = Effect.runSync(
      SessionSlotLease.acquireSubagentAsync({
        sessionID: "ses_sub_2",
        parentSessionID: "ses_lead_1",
        tier: "128k",
      }),
    )
    expect(slotSub2).toBe(7)

    SessionSlotLease.registerChildSession("ses_sub_3", "ses_lead_2")
    SessionSlotLease.setSessionTier("ses_sub_3", "128k")
    const slotSub3 = Effect.runSync(
      SessionSlotLease.acquireSubagentAsync({
        sessionID: "ses_sub_3",
        parentSessionID: "ses_lead_2",
        tier: "128k",
      }),
    )
    expect(slotSub3).toBe(6)

    // Verify 9 active quanta total
    const snap = SessionSlotLease.getResourceSnapshot()
    expect(snap.activeQuanta128k).toBe(9)
    expect(snap.freeFullBlocks384k).toBe(0)
    expect(snap.blocks[0].mode).toBe("384k_locked")
    expect(snap.blocks[1].mode).toBe("384k_locked")
    expect(snap.blocks[2].mode).toBe("128k_split")
  })

  test("Single-Lead packing: 1 384k Lead on Block 0 (slot 0) + 3 128k Subagents packing into slots 5, 4, 3 of Block 1 while Block 2 stays idle (freeFullBlocks384k === 1)", () => {
    // 1. Admit Lead 1 (384k) on Block 0 (slot 0)
    const admLead1 = SessionSlotLease.admitConversation({
      conversationId: "conv_single_lead",
      resources: { contextTier: "384k" },
    })
    expect(admLead1.admitted).toBe(true)
    expect(admLead1.leadBlockId).toBe(0)
    expect(admLead1.leadSlotId).toBe(0)
    SessionSlotLease.bindConversationSession({ conversationId: "conv_single_lead", sessionID: "ses_lead_1" })
    expect(SessionSlotLease.acquire("ses_lead_1", false)).toBe(0)

    // 2. Spawn 3 128k subagents under Lead 1
    // Block 0 is 384k_locked (slots 1 & 2 are sealed).
    // SUBAGENT_SLOT_PREFERENCE = [2, 5, 8, 1, 4, 7, 0, 3, 6]
    // Subagent 1 chooses slot 5 (in idle Block 1, splitting it into 128k_split).
    // Once Block 1 is 128k_split, remaining slots in split Block 1 (slots 4 and 3)
    // are preferred over splitting idle Block 2!
    // So Subagent 2 gets slot 4 and Subagent 3 gets slot 3.
    SessionSlotLease.registerChildSession("ses_sub_1", "ses_lead_1")
    SessionSlotLease.setSessionTier("ses_sub_1", "128k")
    const slotSub1 = Effect.runSync(
      SessionSlotLease.acquireSubagentAsync({
        sessionID: "ses_sub_1",
        parentSessionID: "ses_lead_1",
        tier: "128k",
      }),
    )
    expect(slotSub1).toBe(5)

    SessionSlotLease.registerChildSession("ses_sub_2", "ses_lead_1")
    SessionSlotLease.setSessionTier("ses_sub_2", "128k")
    const slotSub2 = Effect.runSync(
      SessionSlotLease.acquireSubagentAsync({
        sessionID: "ses_sub_2",
        parentSessionID: "ses_lead_1",
        tier: "128k",
      }),
    )
    expect(slotSub2).toBe(4)

    SessionSlotLease.registerChildSession("ses_sub_3", "ses_lead_1")
    SessionSlotLease.setSessionTier("ses_sub_3", "128k")
    const slotSub3 = Effect.runSync(
      SessionSlotLease.acquireSubagentAsync({
        sessionID: "ses_sub_3",
        parentSessionID: "ses_lead_1",
        tier: "128k",
      }),
    )
    expect(slotSub3).toBe(3)

    // Block 1 is 128k_split containing slots 5, 4, 3.
    // Crucially: Block 2 stays completely idle! freeFullBlocks384k === 1 preserved!
    const snap = SessionSlotLease.getResourceSnapshot()
    expect(snap.blocks[0].mode).toBe("384k_locked")
    expect(snap.blocks[1].mode).toBe("128k_split")
    expect(snap.blocks[2].mode).toBe("idle")
    expect(snap.freeFullBlocks384k).toBe(1)
    expect(snap.canAdmitNewLeadConversation).toBe(true)

    // A second 384k Lead can immediately acquire Block 2 (slot 6) without waiting!
    const admLead2 = SessionSlotLease.admitConversation({
      conversationId: "conv_second_lead",
      resources: { contextTier: "384k" },
    })
    expect(admLead2.admitted).toBe(true)
    expect(admLead2.leadBlockId).toBe(2)
    expect(admLead2.leadSlotId).toBe(6)
    SessionSlotLease.bindConversationSession({ conversationId: "conv_second_lead", sessionID: "ses_lead_2" })
    expect(SessionSlotLease.acquire("ses_lead_2", false)).toBe(6)
  })
})

describe("Aquanox Dual-Tier v12.0 GPU Tool Slot Policy — withGpuToolSlotPolicy", () => {
  beforeEach(() => {
    SessionSlotLease.reset()
  })

  test("default suspendMode 'keep_reserved' keeps subagent slot reserved across GPU tool call and resumes with 0 ms re-acquisition delay", () => {
    SessionSlotLease.admitConversation({
      conversationId: "conv_tool",
      resources: { contextTier: "384k" },
    })
    SessionSlotLease.bindConversationSession({ conversationId: "conv_tool", sessionID: "ses_lead" })
    SessionSlotLease.acquire("ses_lead", false)

    SessionSlotLease.registerChildSession("ses_sub_gpu", "ses_lead")
    SessionSlotLease.setSessionTier("ses_sub_gpu", "128k")
    const slot = Effect.runSync(
      SessionSlotLease.acquireSubagentAsync({
        sessionID: "ses_sub_gpu",
        parentSessionID: "ses_lead",
        tier: "128k",
      }),
    )
    expect(slot).toBe(5)

    let insideSlotReserved = false
    Effect.runSync(
      SessionSlotLease.withGpuToolSlotPolicy("ses_sub_gpu", () =>
        Effect.sync(() => {
          // Inside tool execution: slot 5 remains actively held by ses_sub_gpu
          insideSlotReserved = SessionSlotLease.isActivelyHeld("ses_sub_gpu") === 5
        }),
      ),
    )
    expect(insideSlotReserved).toBe(true)
    // Post tool execution: slot 5 remains held by ses_sub_gpu without re-acquisition delay
    expect(SessionSlotLease.isActivelyHeld("ses_sub_gpu")).toBe(5)
  })

  test("explicit suspendMode 'evict_and_reacquire' releases slot during tool call, and interrupted waiter exits cleanly in < 10 ms", async () => {
    SessionSlotLease.admitConversation({
      conversationId: "conv_tool_evict",
      resources: { contextTier: "384k" },
    })
    SessionSlotLease.bindConversationSession({ conversationId: "conv_tool_evict", sessionID: "ses_lead" })
    SessionSlotLease.acquire("ses_lead", false)

    SessionSlotLease.registerChildSession("ses_sub_evict", "ses_lead")
    SessionSlotLease.setSessionTier("ses_sub_evict", "128k")
    const slot = Effect.runSync(
      SessionSlotLease.acquireSubagentAsync({
        sessionID: "ses_sub_evict",
        parentSessionID: "ses_lead",
        tier: "128k",
      }),
    )
    expect(slot).toBe(5)

    let slotReleasedDuringUse = false
    Effect.runSync(
      SessionSlotLease.withGpuToolSlotPolicy(
        "ses_sub_evict",
        () =>
          Effect.sync(() => {
            // While use() runs under evict_and_reacquire, the slot is released
            slotReleasedDuringUse = SessionSlotLease.isActivelyHeld("ses_sub_evict") === undefined
          }),
        { suspendMode: "evict_and_reacquire" },
      ),
    )
    expect(slotReleasedDuringUse).toBe(true)
    // After use() completes successfully, it re-acquires the slot
    expect(SessionSlotLease.isActivelyHeld("ses_sub_evict")).toBe(5)

    // Now test interruption of re-acquisition:
    // With 2 Leads and 3 Subagents, all 9 quanta are active.
    SessionSlotLease.reset()
    SessionSlotLease.admitConversation({
      conversationId: "conv_q1",
      resources: { contextTier: "384k" },
    })
    SessionSlotLease.bindConversationSession({ conversationId: "conv_q1", sessionID: "lead_1" })
    SessionSlotLease.acquire("lead_1", false)

    SessionSlotLease.admitConversation({
      conversationId: "conv_q2",
      resources: { contextTier: "384k" },
    })
    SessionSlotLease.bindConversationSession({ conversationId: "conv_q2", sessionID: "lead_2" })
    SessionSlotLease.acquire("lead_2", false)

    SessionSlotLease.registerChildSession("sub_1", "lead_1")
    SessionSlotLease.setSessionTier("sub_1", "128k")
    SessionSlotLease.registerChildSession("sub_2", "lead_1")
    SessionSlotLease.setSessionTier("sub_2", "128k")
    SessionSlotLease.registerChildSession("sub_3", "lead_2")
    SessionSlotLease.setSessionTier("sub_3", "128k")
    Effect.runSync(SessionSlotLease.acquireSubagentAsync({ sessionID: "sub_1", parentSessionID: "lead_1", tier: "128k" }))
    Effect.runSync(SessionSlotLease.acquireSubagentAsync({ sessionID: "sub_2", parentSessionID: "lead_1", tier: "128k" }))
    Effect.runSync(SessionSlotLease.acquireSubagentAsync({ sessionID: "sub_3", parentSessionID: "lead_2", tier: "128k" }))

    // All 9 quanta are now active!
    // A 4th subagent will queue in waiterQueue:
    SessionSlotLease.registerChildSession("sub_queued", "lead_1")
    SessionSlotLease.setSessionTier("sub_queued", "128k")
    const reacquireFiber = Effect.runFork(
      SessionSlotLease.acquireSubagentAsync({ sessionID: "sub_queued", parentSessionID: "lead_1", tier: "128k" }),
    )
    const t0 = performance.now()
    await Effect.runPromise(Fiber.interrupt(reacquireFiber))
    const elapsedMs = performance.now() - t0

    expect(elapsedMs).toBeLessThan(100) // exits in < 10 ms
    // Waiter was cleanly removed by Effect.onInterrupt without leaking a zombie slot
    expect(SessionSlotLease.removeWaitersForSession("sub_queued")).toBe(0)
  })
})

describe("Aquanox Dual-Tier v12.0 Child Session Cleanup — releaseSubagentSession", () => {
  beforeEach(() => {
    SessionSlotLease.reset()
  })

  test("releasing/purging child subagent session preserves parent 384k Lead lease on slot 0 and wakes queued sibling subagents", async () => {
    // 1. Admit Lead in Block 0 (slot 0)
    SessionSlotLease.admitConversation({
      conversationId: "conv_family",
      resources: {
        contextTier: "384k",
        reservedSubagents: { count: 3, contextTier: "128k" },
        maxConcurrentSubagents: 3,
      },
    })
    SessionSlotLease.bindConversationSession({ conversationId: "conv_family", sessionID: "ses_lead" })
    expect(SessionSlotLease.acquire("ses_lead", false)).toBe(0)

    // 2. Children 1, 2, 3 acquire slots 5, 4, 3 in Block 1 (maxConcurrentSubagents = 3 reached)
    for (const id of ["ses_child_1", "ses_child_2", "ses_child_3"]) {
      SessionSlotLease.registerChildSession(id, "ses_lead")
      SessionSlotLease.setSessionTier(id, "128k")
    }
    expect(
      Effect.runSync(
        SessionSlotLease.acquireSubagentAsync({ sessionID: "ses_child_1", parentSessionID: "ses_lead", tier: "128k" }),
      ),
    ).toBe(5)
    expect(
      Effect.runSync(
        SessionSlotLease.acquireSubagentAsync({ sessionID: "ses_child_2", parentSessionID: "ses_lead", tier: "128k" }),
      ),
    ).toBe(4)
    expect(
      Effect.runSync(
        SessionSlotLease.acquireSubagentAsync({ sessionID: "ses_child_3", parentSessionID: "ses_lead", tier: "128k" }),
      ),
    ).toBe(3)

    // 3. Queue a 4th sibling subagent while 3 are active
    SessionSlotLease.registerChildSession("ses_child_4", "ses_lead")
    SessionSlotLease.setSessionTier("ses_child_4", "128k")
    const child4Fiber = Effect.runFork(
      SessionSlotLease.acquireSubagentAsync({ sessionID: "ses_child_4", parentSessionID: "ses_lead", tier: "128k" }),
    )
    expect(SessionSlotLease.getResourceSnapshot({ conversationId: "conv_family" }).thisConversation?.queuedSubagentWaiters).toBe(1)

    // 4. Child 1 completes turn: releaseSubagentSession({ purge: false }) releases slot 5 and wakes queued ses_child_4!
    Effect.runSync(SessionSlotLease.releaseSubagentSession("ses_child_1", { purge: false }))
    expect(SessionSlotLease.isActivelyHeld("ses_child_1")).toBeUndefined()
    const child4Slot = await Effect.runPromise(Fiber.join(child4Fiber))
    expect(child4Slot).toBe(5)
    expect(SessionSlotLease.isActivelyHeld("ses_child_4")).toBe(5)

    // Parent lead slot 0 remains completely intact!
    expect(SessionSlotLease.isActivelyHeld("ses_lead")).toBe(0)
    expect(SessionSlotLease.getResourceSnapshot().blocks[0].mode).toBe("384k_locked")

    // 5. Final child session teardown: releaseSubagentSession({ purge: true }) purges child mappings without touching parent
    Effect.runSync(SessionSlotLease.releaseSubagentSession("ses_child_1", { purge: true }))
    Effect.runSync(SessionSlotLease.releaseSubagentSession("ses_child_2", { purge: true }))
    Effect.runSync(SessionSlotLease.releaseSubagentSession("ses_child_3", { purge: true }))
    Effect.runSync(SessionSlotLease.releaseSubagentSession("ses_child_4", { purge: true }))
    expect(SessionSlotLease.isActivelyHeld("ses_lead")).toBe(0)
    expect(SessionSlotLease.getResourceSnapshot({ conversationId: "conv_family" }).thisConversation?.leadSlotId).toBe(0)
  })
})

describe("Aquanox Dual-Tier v12.0 Subagent Nesting Depth — MAX_SUBAGENT_DEPTH", () => {
  const originalEnv = process.env.AQUANOX_FULL_SLOT_STATE_SAVE

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.AQUANOX_FULL_SLOT_STATE_SAVE = originalEnv
    } else {
      delete process.env.AQUANOX_FULL_SLOT_STATE_SAVE
    }
  })

  test("enforces MAX_SUBAGENT_DEPTH = 1 by default and clamps experimental.subagent_depth to hardMaxDepth = 1", () => {
    delete process.env.AQUANOX_FULL_SLOT_STATE_SAVE

    expect(MAX_SUBAGENT_DEPTH).toBe(1)
    // Default limit when configuredLimit is undefined is 1
    expect(resolveMaxSubagentDepth()).toBe(1)
    // When configuredLimit is 3, it is clamped to hardMaxDepth 1
    expect(resolveMaxSubagentDepth(3)).toBe(1)
    // When configuredLimit is 0, it returns 0
    expect(resolveMaxSubagentDepth(0)).toBe(0)
  })

  test("allows depth up to 2 when AQUANOX_FULL_SLOT_STATE_SAVE=1 override is active", () => {
    process.env.AQUANOX_FULL_SLOT_STATE_SAVE = "1"

    // When full slot state save is enabled, hardMaxDepth is 2
    expect(resolveMaxSubagentDepth(2)).toBe(2)
    // But still clamped if configured exceeds 2
    expect(resolveMaxSubagentDepth(5)).toBe(2)
  })
})

describe("Aquanox Dual-Tier v12.0 Title Derivation — deriveFallbackTitle", () => {
  test("extracts clean deterministic fallback title without calling :8080 unleased", () => {
    const rawMessage =
      "Here is the first message of the conversation:\n\n<message>\nImplement Godot 4.7 collision layer for Aurelith actors\n</message>\n\nReply with only the title."
    expect(deriveFallbackTitle(rawMessage)).toBe("Implement Godot 4.7 collision layer for Aurelith actors")

    const rawConversation =
      "Here is the conversation so far:\n\n<conversation>\nOriginal request:\n# Investigate mesh deformation in blender pipeline\n\nRecent conversation:\nUser: Can you check the bones?\n</conversation>\n\nReply with only the title."
    expect(deriveFallbackTitle(rawConversation)).toBe("Investigate mesh deformation in blender pipeline")

    const plainText = "Quick test without tags"
    expect(deriveFallbackTitle(plainText)).toBe("Quick test without tags")
  })
})

describe("Aquanox Dual-Tier v12.0 Plane-2 Stride-Aligned Compute Turnstile — withComputeTurnstile", () => {
  const originalMaxStreams = process.env.AQUANOX_MAX_COMPUTE_STREAMS

  beforeEach(() => {
    delete process.env.AQUANOX_MAX_COMPUTE_STREAMS
    SessionSlotLease.resetForTesting()
  })

  afterEach(() => {
    if (originalMaxStreams !== undefined) {
      process.env.AQUANOX_MAX_COMPUTE_STREAMS = originalMaxStreams
    } else {
      delete process.env.AQUANOX_MAX_COMPUTE_STREAMS
    }
    SessionSlotLease.resetForTesting()
  })

  test("paces 5 simultaneous Plane-1 leased sessions (2 Leads on 0, 3 + 3 Subagents on 8, 7, 6 = 9 quanta) into Wave 1 (3 active) and Wave 2 (2 waiting) with 0 KV evictions", async () => {
    expect(SessionSlotLease.DEFAULT_STRIDE_ALIGNED_COMPUTE_STREAMS).toBe(3)
    expect(SessionSlotLease.MAX_ACTIVE_COMPUTE_STREAMS).toBe(4)

    // Plane 1: Admit 2 384k Leads on Blocks 0 & 1 (slots 0 and 3)
    SessionSlotLease.admitConversation({ conversationId: "conv_p2_1", resources: { contextTier: "384k" } })
    SessionSlotLease.bindConversationSession({ conversationId: "conv_p2_1", sessionID: "lead_0" })
    expect(SessionSlotLease.acquire("lead_0", false)).toBe(0)

    SessionSlotLease.admitConversation({ conversationId: "conv_p2_2", resources: { contextTier: "384k" } })
    SessionSlotLease.bindConversationSession({ conversationId: "conv_p2_2", sessionID: "lead_3" })
    expect(SessionSlotLease.acquire("lead_3", false)).toBe(3)

    // Plane 1: Admit 3 128k Subagents into Block 2 (slots 8, 7, 6)
    SessionSlotLease.registerChildSession("sub_8", "lead_0")
    SessionSlotLease.setSessionTier("sub_8", "128k")
    expect(
      Effect.runSync(SessionSlotLease.acquireSubagentAsync({ sessionID: "sub_8", parentSessionID: "lead_0", tier: "128k" })),
    ).toBe(8)

    SessionSlotLease.registerChildSession("sub_7", "lead_0")
    SessionSlotLease.setSessionTier("sub_7", "128k")
    expect(
      Effect.runSync(SessionSlotLease.acquireSubagentAsync({ sessionID: "sub_7", parentSessionID: "lead_0", tier: "128k" })),
    ).toBe(7)

    SessionSlotLease.registerChildSession("sub_6", "lead_3")
    SessionSlotLease.setSessionTier("sub_6", "128k")
    expect(
      Effect.runSync(SessionSlotLease.acquireSubagentAsync({ sessionID: "sub_6", parentSessionID: "lead_3", tier: "128k" })),
    ).toBe(6)

    // Verify all 9 quanta are resident in Plane 1
    expect(SessionSlotLease.getResourceSnapshot().activeQuanta128k).toBe(9)

    const wave1Gate = Effect.runSync(Deferred.make<void>())
    const wave2Gate = Effect.runSync(Deferred.make<void>())
    const enteredOrder: string[] = []
    let currentInFlight = 0
    let maxConcurrentInFlight = 0

    const makeStepTask = (sessionID: string, slot: number, gate: Deferred.Deferred<void>) =>
      SessionSlotLease.withComputeTurnstile(sessionID, slot, () =>
        Effect.gen(function* () {
          enteredOrder.push(sessionID)
          currentInFlight += 1
          if (currentInFlight > maxConcurrentInFlight) {
            maxConcurrentInFlight = currentInFlight
          }
          yield* Deferred.await(gate)
          currentInFlight -= 1
          return `${sessionID}:${slot}`
        }),
      )

    // Launch all 5 sessions into Plane-2 compute turnstile simultaneously
    const f1 = Effect.runFork(makeStepTask("lead_0", 0, wave1Gate))
    const f2 = Effect.runFork(makeStepTask("lead_3", 3, wave1Gate))
    const f3 = Effect.runFork(makeStepTask("sub_8", 8, wave1Gate))
    const f4 = Effect.runFork(makeStepTask("sub_7", 7, wave2Gate))
    const f5 = Effect.runFork(makeStepTask("sub_6", 6, wave2Gate))

    await Effect.runPromise(Effect.yieldNow)

    // Wave 1: Exactly 3 streams active in Plane 2; 2 sessions queued in Plane 2
    const telemetryWave1 = SessionSlotLease.getTelemetry()
    expect(telemetryWave1.activeComputeStreamsCount).toBe(3)
    expect(telemetryWave1.queuedComputeWaitersCount).toBe(2)
    expect(currentInFlight).toBe(3)
    expect(enteredOrder).toEqual(["lead_0", "lead_3", "sub_8"])

    // Crucially: All 5 KV slots remain 100% leased and resident in Plane 1 (0 KV evictions!)
    expect(SessionSlotLease.isActivelyHeld("lead_0")).toBe(0)
    expect(SessionSlotLease.isActivelyHeld("lead_3")).toBe(3)
    expect(SessionSlotLease.isActivelyHeld("sub_8")).toBe(8)
    expect(SessionSlotLease.isActivelyHeld("sub_7")).toBe(7)
    expect(SessionSlotLease.isActivelyHeld("sub_6")).toBe(6)
    expect(SessionSlotLease.getResourceSnapshot().activeQuanta128k).toBe(9)

    // Complete Wave 1 -> Wave 2 (sub_7 and sub_6) immediately enters Plane 2
    await Effect.runPromise(Deferred.succeed(wave1Gate, void 0))
    await Effect.runPromise(Fiber.joinAll([f1, f2, f3]))
    await Effect.runPromise(Effect.yieldNow)

    const telemetryWave2 = SessionSlotLease.getTelemetry()
    expect(telemetryWave2.activeComputeStreamsCount).toBe(2)
    expect(telemetryWave2.queuedComputeWaitersCount).toBe(0)
    expect(currentInFlight).toBe(2)
    expect(enteredOrder.length).toBe(5)
    expect(maxConcurrentInFlight).toBe(3)

    // Complete Wave 2
    await Effect.runPromise(Deferred.succeed(wave2Gate, void 0))
    const results = await Effect.runPromise(Fiber.joinAll([f4, f5]))
    expect(results.sort()).toEqual(["sub_6:6", "sub_7:7"])
    expect(SessionSlotLease.getTelemetry().activeComputeStreamsCount).toBe(0)
    // Plane 1 slots remain leased until explicit turn completion
    expect(SessionSlotLease.getResourceSnapshot().activeQuanta128k).toBe(9)
  })

  test("Stride-3 affinity selection prioritizes modulo-3 residue class and contiguous split_128k block while enforcing FIFO anti-starvation", async () => {
    // Part A: Modulo-3 residue class affinity ({0, 3, 6})
    // Hold 3 active streams: lead_0 (slot 0), lead_3 (slot 3), sub_8 (slot 8)
    const gate0 = Effect.runSync(Deferred.make<void>())
    const gate3 = Effect.runSync(Deferred.make<void>())
    const gate8 = Effect.runSync(Deferred.make<void>())
    const gateWaiters = Effect.runSync(Deferred.make<void>())
    const wakeOrder: string[] = []

    const f0 = Effect.runFork(SessionSlotLease.withComputeTurnstile("lead_0", 0, () => Deferred.await(gate0)))
    const f3 = Effect.runFork(SessionSlotLease.withComputeTurnstile("lead_3", 3, () => Deferred.await(gate3)))
    const f8 = Effect.runFork(SessionSlotLease.withComputeTurnstile("sub_8", 8, () => Deferred.await(gate8)))
    await Effect.runPromise(Effect.yieldNow)

    // Enqueue sub_7 (slot 7, mod 3 = 1) FIRST, then sub_6 (slot 6, mod 3 = 0) SECOND
    const f7 = Effect.runFork(
      SessionSlotLease.withComputeTurnstile("sub_7", 7, () =>
        Effect.gen(function* () {
          wakeOrder.push("sub_7")
          yield* Deferred.await(gateWaiters)
        }),
      ),
    )
    const f6 = Effect.runFork(
      SessionSlotLease.withComputeTurnstile("sub_6", 6, () =>
        Effect.gen(function* () {
          wakeOrder.push("sub_6")
          yield* Deferred.await(gateWaiters)
        }),
      ),
    )
    await Effect.runPromise(Effect.yieldNow)
    expect(SessionSlotLease.getTelemetry().queuedComputeWaitersCount).toBe(2)

    // When sub_8 finishes, active compute slots are {0, 3} (both slot % 3 === 0).
    // Stride-3 affinity must wake sub_6 (slot 6, 6 % 3 === 0) ahead of sub_7 (slot 7, 7 % 3 === 1)!
    await Effect.runPromise(Deferred.succeed(gate8, void 0))
    await Effect.runPromise(Fiber.join(f8))
    await Effect.runPromise(Effect.yieldNow)

    expect(wakeOrder).toEqual(["sub_6"])

    // Now test anti-starvation fairness: sub_7 has been bypassed 1 wave so far (bypassedWaves === 1).
    // Enqueue another stride-aligned waiter sub_6b (slot 6) and release gateWaiters for sub_6:
    const gate6b = Effect.runSync(Deferred.make<void>())
    const f6b = Effect.runFork(
      SessionSlotLease.withComputeTurnstile("sub_6b", 6, () =>
        Effect.gen(function* () {
          wakeOrder.push("sub_6b")
          yield* Deferred.await(gate6b)
        }),
      ),
    )
    await Effect.runPromise(Effect.yieldNow)

    // Release sub_6 -> sub_7 has bypassedWaves === 1 < 2, so sub_6b (stride-aligned) wakes second,
    // incrementing sub_7's bypassedWaves to 2!
    await Effect.runPromise(Deferred.succeed(gateWaiters, void 0))
    await Effect.runPromise(Fiber.join(f6))
    await Effect.runPromise(Effect.yieldNow)
    expect(wakeOrder).toEqual(["sub_6", "sub_6b"])

    // Enqueue a third stride-aligned waiter sub_6c (slot 6):
    const f6c = Effect.runFork(
      SessionSlotLease.withComputeTurnstile("sub_6c", 6, () =>
        Effect.sync(() => {
          wakeOrder.push("sub_6c")
        }),
      ),
    )
    await Effect.runPromise(Effect.yieldNow)

    // Now sub_7 has bypassedWaves === 2 (>= 2 threshold!). When sub_6b finishes,
    // anti-starvation fairness MUST wake oldest FIFO waiter sub_7 BEFORE sub_6c!
    await Effect.runPromise(Deferred.succeed(gate6b, void 0))
    await Effect.runPromise(Fiber.join(f6b))
    await Effect.runPromise(Effect.yieldNow)
    expect(wakeOrder).toEqual(["sub_6", "sub_6b", "sub_7", "sub_6c"])

    await Effect.runPromise(Deferred.succeed(gate0, void 0))
    await Effect.runPromise(Deferred.succeed(gate3, void 0))
    await Effect.runPromise(Fiber.joinAll([f0, f3, f7, f6c]))

    // Part B: Contiguous split_128k block affinity ({6, 7, 8})
    SessionSlotLease.resetForTesting()
    SessionSlotLease.setSessionTier("sub_b8", "128k")
    SessionSlotLease.setSessionTier("sub_b7", "128k")
    SessionSlotLease.setSessionTier("sub_b6", "128k")
    SessionSlotLease.setSessionTier("lead_b0", "384k")
    SessionSlotLease.setSessionTier("sub_b2", "128k")

    const g8 = Effect.runSync(Deferred.make<void>())
    const g7 = Effect.runSync(Deferred.make<void>())
    const g2 = Effect.runSync(Deferred.make<void>())
    const blockWakeOrder: string[] = []

    const fb8 = Effect.runFork(SessionSlotLease.withComputeTurnstile("sub_b8", 8, () => Deferred.await(g8)))
    const fb7 = Effect.runFork(SessionSlotLease.withComputeTurnstile("sub_b7", 7, () => Deferred.await(g7)))
    const fb2 = Effect.runFork(SessionSlotLease.withComputeTurnstile("sub_b2", 2, () => Deferred.await(g2)))
    await Effect.runPromise(Effect.yieldNow)

    // Queue lead_b0 (slot 0, Block 0) first, then sub_b6 (slot 6, Block 2) second
    const fb0 = Effect.runFork(
      SessionSlotLease.withComputeTurnstile("lead_b0", 0, () =>
        Effect.sync(() => {
          blockWakeOrder.push("lead_b0")
        }),
      ),
    )
    const fb6 = Effect.runFork(
      SessionSlotLease.withComputeTurnstile("sub_b6", 6, () =>
        Effect.sync(() => {
          blockWakeOrder.push("sub_b6")
        }),
      ),
    )
    await Effect.runPromise(Effect.yieldNow)

    // Release sub_b2 -> active slots are {8, 7} (both in split_128k Block 2).
    // sub_b6 (slot 6, Block 2) shares the contiguous split_128k block and wakes before lead_b0!
    await Effect.runPromise(Deferred.succeed(g2, void 0))
    await Effect.runPromise(Fiber.join(fb2))
    await Effect.runPromise(Effect.yieldNow)

    expect(blockWakeOrder).toEqual(["sub_b6", "lead_b0"])
    await Effect.runPromise(Deferred.succeed(g8, void 0))
    await Effect.runPromise(Deferred.succeed(g7, void 0))
    await Effect.runPromise(Fiber.joinAll([fb8, fb7, fb0, fb6]))
  })

  test("interruption of a queued compute waiter cleans up in < 10 ms without leaking permits, and supports re-entrancy & cloud bypass", async () => {
    // 1. Cloud / non-leased bypass (slot === undefined or slot < 0) and re-entrant call on same session
    let reentrantRan = false
    const bypassRes = await Effect.runPromise(
      SessionSlotLease.withComputeTurnstile("cloud_ses", undefined, () =>
        SessionSlotLease.withComputeTurnstile("cloud_ses", -1, () => Effect.succeed("ok")),
      ),
    )
    expect(bypassRes).toBe("ok")

    const reentrantRes = await Effect.runPromise(
      SessionSlotLease.withComputeTurnstile("ses_reentrant", 0, () =>
        SessionSlotLease.withComputeTurnstile("ses_reentrant", 0, () =>
          Effect.sync(() => {
            reentrantRan = true
            return 42
          }),
        ),
      ),
    )
    expect(reentrantRan).toBe(true)
    expect(reentrantRes).toBe(42)
    expect(SessionSlotLease.getTelemetry().activeComputeStreamsCount).toBe(0)

    // 2. Saturate all 3 compute streams, queue a 4th waiter, and interrupt the 4th waiter
    const holdGate = Effect.runSync(Deferred.make<void>())
    const f1 = Effect.runFork(SessionSlotLease.withComputeTurnstile("s1", 0, () => Deferred.await(holdGate)))
    const f2 = Effect.runFork(SessionSlotLease.withComputeTurnstile("s2", 3, () => Deferred.await(holdGate)))
    const f3 = Effect.runFork(SessionSlotLease.withComputeTurnstile("s3", 6, () => Deferred.await(holdGate)))
    await Effect.runPromise(Effect.yieldNow)

    expect(SessionSlotLease.getTelemetry().activeComputeStreamsCount).toBe(3)

    const fQueued = Effect.runFork(
      SessionSlotLease.withComputeTurnstile("s_cancelled", 8, () => Effect.succeed("never")),
    )
    await Effect.runPromise(Effect.yieldNow)
    expect(SessionSlotLease.getTelemetry().queuedComputeWaitersCount).toBe(1)

    const t0 = performance.now()
    await Effect.runPromise(Fiber.interrupt(fQueued))
    const elapsedMs = performance.now() - t0

    expect(elapsedMs).toBeLessThan(10)
    expect(SessionSlotLease.getTelemetry().queuedComputeWaitersCount).toBe(0)
    expect(SessionSlotLease.getTelemetry().activeComputeStreamsCount).toBe(3)

    // Release holding streams and verify a subsequent session can acquire all permits without leak
    await Effect.runPromise(Deferred.succeed(holdGate, void 0))
    await Effect.runPromise(Fiber.joinAll([f1, f2, f3]))
    expect(SessionSlotLease.getTelemetry().activeComputeStreamsCount).toBe(0)
  })
})

describe("Aquanox Dual-Tier v12.0 Fail-Closed Compaction Slot Lease — Finding 11", () => {
  beforeEach(() => {
    SessionSlotLease.reset()
  })

  test("resolveCompactionSlotOrFail reuses actively held slot and fails closed when all 9 quanta (3 x 384k) are occupied — never returning -1", () => {
    // Occupy all 3 384k Buddy Blocks (9 quanta total)
    SessionSlotLease.admitConversation({ conversationId: "conv_c0", rootSessionId: "ses_lead_0" })
    SessionSlotLease.bindConversationSession({ conversationId: "conv_c0", sessionID: "ses_lead_0" })
    expect(SessionSlotLease.acquire("ses_lead_0", false)).toBe(0)

    SessionSlotLease.admitConversation({ conversationId: "conv_c1", rootSessionId: "ses_lead_1" })
    SessionSlotLease.bindConversationSession({ conversationId: "conv_c1", sessionID: "ses_lead_1" })
    expect(SessionSlotLease.acquire("ses_lead_1", false)).toBe(3)

    SessionSlotLease.admitConversation({ conversationId: "conv_c2", rootSessionId: "ses_lead_2" })
    SessionSlotLease.bindConversationSession({ conversationId: "conv_c2", sessionID: "ses_lead_2" })
    expect(SessionSlotLease.acquire("ses_lead_2", false)).toBe(6)

    // Actively held sessions reuse their exact physical slot (0, 3, 6) with wasAlreadyHeldByTurn = true
    expect(resolveCompactionLeaseOrFail("ses_lead_0", false)).toEqual({
      slot: 0,
      wasAlreadyHeldByTurn: true,
    })
    expect(resolveCompactionSlotOrFail("ses_lead_1", false)).toBe(3)
    expect(resolveCompactionSlotOrFail("ses_lead_2", false)).toBe(6)

    // Unleased 4th Lead or unleased Subagent when all 9 quanta are occupied MUST fail closed, NEVER returning -1 or hijacking slot 0!
    expect(() => resolveCompactionSlotOrFail("ses_unleased_lead_4", false)).toThrow(
      /ERR_COMPACTION_SLOT_UNAVAILABLE/,
    )
    expect(() => resolveCompactionSlotOrFail("ses_unleased_sub_1", true)).toThrow(
      /ERR_COMPACTION_SLOT_UNAVAILABLE/,
    )
    // Verify slot 0 is still exclusively owned by ses_lead_0
    expect(SessionSlotLease.isActivelyHeld("ses_lead_0")).toBe(0)
    expect(SessionSlotLease.isActivelyHeld("ses_unleased_lead_4")).toBeUndefined()
  })

  test("resolveCompactionSlotOrFail and acquireCompactionSlotEffect handle 2L + 3S (9 active quanta) contention without ever returning -1", async () => {
    // 2 Leads on Blocks 0 & 1 (slots 0 and 3)
    SessionSlotLease.admitConversation({ conversationId: "conv_l0", rootSessionId: "lead_0" })
    SessionSlotLease.bindConversationSession({ conversationId: "conv_l0", sessionID: "lead_0" })
    expect(SessionSlotLease.acquire("lead_0", false)).toBe(0)

    SessionSlotLease.admitConversation({ conversationId: "conv_l1", rootSessionId: "lead_1" })
    SessionSlotLease.bindConversationSession({ conversationId: "conv_l1", sessionID: "lead_1" })
    expect(SessionSlotLease.acquire("lead_1", false)).toBe(3)

    // 3 Subagents on Block 2 (slots 8, 7, 6)
    for (const [subId, parentId] of [
      ["sub_8", "lead_0"],
      ["sub_7", "lead_0"],
      ["sub_6", "lead_1"],
    ] as const) {
      SessionSlotLease.registerChildSession(subId, parentId)
      SessionSlotLease.setSessionTier(subId, "128k")
      const acquired = Effect.runSync(
        SessionSlotLease.acquireSubagentAsync({ sessionID: subId, parentSessionID: parentId, tier: "128k" }),
      )
      expect(acquired).toBeGreaterThanOrEqual(6)
    }

    expect(SessionSlotLease.getResourceSnapshot().activeQuanta128k).toBe(9)

    // Synchronous resolution for a 4th subagent under 2L + 3S saturation throws ERR_COMPACTION_SLOT_UNAVAILABLE (never -1)
    SessionSlotLease.registerChildSession("sub_4_compact", "lead_1")
    SessionSlotLease.setSessionTier("sub_4_compact", "128k")
    expect(() => resolveCompactionSlotOrFail("sub_4_compact", true)).toThrow(/ERR_COMPACTION_SLOT_UNAVAILABLE/)

    // Asynchronous queueing via acquireCompactionSlotEffect({ queueWhenBusy: true }) waits until sub_6 releases slot 6
    const queuedFiber = Effect.runFork(
      acquireCompactionSlotEffect("sub_4_compact", true, {
        parentSessionID: "lead_1",
        tier: "128k",
        queueWhenBusy: true,
      }),
    )
    await Effect.runPromise(Effect.yieldNow)

    // Release sub_6 -> sub_4_compact receives valid physical slot 6 (>= 0, never -1)
    SessionSlotLease.release("sub_6")
    const resolved = await Effect.runPromise(Fiber.join(queuedFiber))
    expect(resolved.slot).toBe(6)
    expect(resolved.slot).toBeGreaterThanOrEqual(0)
    expect(resolved.wasAlreadyHeldByTurn).toBe(false)
    SessionSlotLease.release("sub_4_compact")
  })
})

describe("Aquanox Dual-Tier v12.0 Compaction & Precompute Turnstile Gating — GPU-019", () => {
  beforeEach(() => {
    SessionSlotLease.reset()
    activePrecomputeFibers.clear()
  })

  test("compaction inference execution is gated through Plane-2 withComputeTurnstile and paces behind active streams", async () => {
    // 1. Fill Plane-2 turnstile with 3 active streams (max 3 concurrent)
    const gate0 = Effect.runSync(Deferred.make<void>())
    const gate1 = Effect.runSync(Deferred.make<void>())
    const gate2 = Effect.runSync(Deferred.make<void>())
    const compactionDone = Effect.runSync(Deferred.make<string>())

    const f0 = Effect.runFork(SessionSlotLease.withComputeTurnstile("lead_0", 0, () => Deferred.await(gate0)))
    const f1 = Effect.runFork(SessionSlotLease.withComputeTurnstile("lead_1", 1, () => Deferred.await(gate1)))
    const f2 = Effect.runFork(SessionSlotLease.withComputeTurnstile("lead_2", 2, () => Deferred.await(gate2)))
    await Effect.runPromise(Effect.yieldNow)

    expect(SessionSlotLease.getTelemetry().activeComputeStreamsCount).toBe(3)
    expect(SessionSlotLease.getTelemetry().queuedComputeWaitersCount).toBe(0)

    // 2. Compaction execution on slot 6 must queue in turnstile rather than bypassing Plane-2!
    let compactionStarted = false
    const fCompact = Effect.runFork(
      SessionSlotLease.withComputeTurnstile("ses_compact_turnstile", 6, () =>
        Effect.gen(function* () {
          compactionStarted = true
          return yield* Deferred.await(compactionDone)
        }),
      ),
    )
    await Effect.runPromise(Effect.yieldNow)

    // Compaction must be enqueued and NOT started while 3 streams are busy
    expect(compactionStarted).toBe(false)
    expect(SessionSlotLease.getTelemetry().queuedComputeWaitersCount).toBe(1)

    // 3. Release one active stream (slot 0) -> turnstile wakes compaction on slot 6
    await Effect.runPromise(Deferred.succeed(gate0, void 0))
    await Effect.runPromise(Fiber.join(f0))
    await Effect.runPromise(Effect.yieldNow)

    expect(compactionStarted).toBe(true)
    expect(SessionSlotLease.getTelemetry().activeComputeStreamsCount).toBe(3)

    // 4. Compaction completes and releases its turnstile permit
    await Effect.runPromise(Deferred.succeed(compactionDone, "compact_ok"))
    const res = await Effect.runPromise(Fiber.join(fCompact))
    expect(res).toBe("compact_ok")

    // Clean up remaining streams
    await Effect.runPromise(Deferred.succeed(gate1, void 0))
    await Effect.runPromise(Deferred.succeed(gate2, void 0))
    await Effect.runPromise(Fiber.joinAll([f1, f2]))
    expect(SessionSlotLease.getTelemetry().activeComputeStreamsCount).toBe(0)
  })

  test("active background compaction summary fiber is tracked and interruptPrecompute cancels it cleanly", async () => {
    const sessionID = "ses_bg_compaction_1"
    const bgGate = Effect.runSync(Deferred.make<void>())
    let interrupted = false

    // Simulate forked background precompute fiber tracked in activePrecomputeFibers
    const bgFiber = Effect.runFork(
      Effect.gen(function* () {
        yield* Deferred.await(bgGate)
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true
          }),
        ),
      ),
    )

    activePrecomputeFibers.set(sessionID, bgFiber as any)
    expect(activePrecomputeFibers.has(sessionID)).toBe(true)

    // Call interruptPrecompute (as executed before foreground inference or session cleanup in llm.ts)
    await Effect.runPromise(interruptPrecompute(sessionID))

    expect(activePrecomputeFibers.has(sessionID)).toBe(false)
    expect(interrupted).toBe(true)
    const exit = await Effect.runPromise(Fiber.await(bgFiber))
    expect(Exit.hasInterrupts(exit)).toBe(true)
  })

  test("awaitPrecompute waits for background compaction summary to settle", async () => {
    const sessionID = "ses_bg_compaction_2"
    let settled = false

    const bgFiber = Effect.runFork(
      Effect.gen(function* () {
        yield* Effect.sleep("10 millis")
        settled = true
      }),
    )

    activePrecomputeFibers.set(sessionID, bgFiber as any)
    await Effect.runPromise(awaitPrecompute(sessionID))
    expect(settled).toBe(true)
  })

  test("shouldPrecompute honors precompute === false and auto === false (GPU-019)", () => {
    // Honors precompute === false regardless of any provider or context
    expect(shouldPrecompute({ precompute: false, auto: true })).toBe(false)
    expect(shouldPrecompute({ precompute: false, auto: false })).toBe(false)
    expect(shouldPrecompute({ precompute: true, auto: false })).toBe(false)
    expect(shouldPrecompute({ precompute: true, auto: true })).toBe(true)
  })

  test("GPU-019: extractCompactionSlot resolves id_slot across all request/options/providerOptions/session shapes and withCompactionLeaseAndTurnstile holds lease + turnstile across prepare and stream while blocking behind active foreground turnstile", async () => {
    // 1. Verify extractCompactionSlot / resolveCompactionRequestSlot across all supported shapes
    expect(extractCompactionSlot({ leasedSlot: 3 })).toBe(3)
    expect(extractCompactionSlot({ options: { id_slot: 4 } })).toBe(4)
    expect(extractCompactionSlot({ options: { body: { id_slot: 5 } } })).toBe(5)
    expect(extractCompactionSlot({ options: { httpBody: { id_slot: 6 } } })).toBe(6)
    expect(extractCompactionSlot({ options: { http: { body: { id_slot: 7 } } } })).toBe(7)
    expect(extractCompactionSlot({ options: { providerOptions: { "deepseek-local": { id_slot: 8 } } } })).toBe(8)
    expect(extractCompactionSlot({ options: { providerOptions: { openaiCompatible: { id_slot: 2 } } } })).toBe(2)
    expect(extractCompactionSlot({ request: { id_slot: 1 } })).toBe(1)
    expect(extractCompactionSlot({ request: { body: { id_slot: 3 } } })).toBe(3)
    expect(extractCompactionSlot({ request: { httpBody: { id_slot: 4 } } })).toBe(4)
    expect(extractCompactionSlot({ request: { http: { body: { id_slot: 0 } } } })).toBe(0)
    expect(extractCompactionSlot({ request: { providerOptions: { "deepseek-local": { id_slot: 6 } } } })).toBe(6)
    expect(extractCompactionSlot({ request: { providerOptions: { openaiCompatible: { id_slot: 7 } } } })).toBe(7)
    expect(resolveCompactionRequestSlot("ses_none", { http: { body: { id_slot: 5 } } })).toBe(5)

    // Session fallback: active lease or admitted conversation leadSlotId
    SessionSlotLease.admitConversation({
      conversationId: "conv_gpu019",
      rootSessionId: "ses_gpu019_lead",
      resources: { contextTier: "384k" },
    })
    expect(extractCompactionSlot({ sessionId: "ses_gpu019_lead" })).toBe(0)
    expect(SessionSlotLease.acquire("ses_gpu019_lead", false)).toBe(0)
    expect(extractCompactionSlot("ses_gpu019_lead")).toBe(0)

    // 2. Verify attachSlotToRequest and attachSlotToOptions propagate id_slot across all fields
    const reqWithSlot = attachSlotToRequest({ messages: [] } as any, 0)
    expect((reqWithSlot.http?.body as any)?.id_slot).toBe(0)
    expect((reqWithSlot as any).httpBody?.id_slot).toBe(0)
    expect((reqWithSlot.providerOptions as any)?.["deepseek-local"]?.id_slot).toBe(0)
    expect((reqWithSlot.providerOptions as any)?.openaiCompatible?.id_slot).toBe(0)

    const optsWithSlot = attachSlotToOptions({} as any, 0)
    expect((optsWithSlot as any).id_slot).toBe(0)
    expect((optsWithSlot as any).body?.id_slot).toBe(0)
    expect((optsWithSlot as any).httpBody?.id_slot).toBe(0)
    expect((optsWithSlot as any).providerOptions?.["deepseek-local"]?.id_slot).toBe(0)
    expect((optsWithSlot as any).providerOptions?.openaiCompatible?.id_slot).toBe(0)

    // 3. Verify background compaction blocks behind an active foreground turnstile on the same slot (even when total streams < 3),
    //    and once foreground completes, holds BOTH Plane-1 slot lease and Plane-2 turnstile continuously across prepare AND stream!
    const fgGate = Effect.runSync(Deferred.make<void>())
    const streamGate = Effect.runSync(Deferred.make<void>())
    const streamEntered = Effect.runSync(Deferred.make<void>())

    // Start foreground turnstile on ses_gpu019_lead (slot 0)
    const fgFiber = Effect.runFork(
      SessionSlotLease.withComputeTurnstile("ses_gpu019_lead", 0, () => Deferred.await(fgGate)),
    )
    await Effect.runPromise(Effect.yieldNow)
    expect(SessionSlotLease.getTelemetry().activeComputeSlots).toEqual([{ sessionID: "ses_gpu019_lead", slot: 0 }])

    let prepareExecuted = false
    let streamExecuted = false
    let slotDuringPrepare: number | undefined
    let turnstileDuringPrepare: Array<{ sessionID: string; slot: number }> = []
    let slotBetweenPrepareAndStream: number | undefined
    let slotDuringStream: number | undefined
    let turnstileDuringStream: Array<{ sessionID: string; slot: number }> = []
    let capturedStreamReq: any
    let capturedStreamOpts: any

    // Release Plane-1 lease before compaction starts so we also prove compaction acquires and holds Plane-1 lease across prepare+stream
    SessionSlotLease.release("ses_gpu019_lead")
    // Re-enter foreground turnstile on slot 0 to simulate an in-flight foreground stream
    const fgFiber2 = Effect.runFork(
      SessionSlotLease.withComputeTurnstile("ses_gpu019_lead", 0, () => Deferred.await(fgGate)),
    )
    await Effect.runPromise(Effect.yieldNow)

    const compactFiber = Effect.runFork(
      withCompactionLeaseAndTurnstile(
        {
          sessionID: "ses_gpu019_lead",
          isSubagent: false,
          localSlotBudgeted: true,
          allowReentrantTurnstile: false,
        },
        (leasedSlot, turnstileKey) =>
          Effect.gen(function* () {
            // Simulate prepare()
            prepareExecuted = true
            slotDuringPrepare = SessionSlotLease.isActivelyHeld("ses_gpu019_lead")
            turnstileDuringPrepare = SessionSlotLease.getTelemetry().activeComputeSlots
            const preparedReq = attachSlotToRequest({ messages: [] } as any, leasedSlot)
            const preparedOpts = attachSlotToOptions({} as any, leasedSlot)

            // Verify lease is STILL held between prepare() and stream()
            yield* Effect.yieldNow
            slotBetweenPrepareAndStream = SessionSlotLease.isActivelyHeld("ses_gpu019_lead")

            // Simulate stream() inside deliver()
            const resolvedStreamSlot = extractCompactionSlot({
              sessionId: "ses_gpu019_lead",
              request: preparedReq,
              options: preparedOpts,
              leasedSlot,
            })
            capturedStreamReq = attachSlotToRequest(preparedReq, resolvedStreamSlot)
            capturedStreamOpts = attachSlotToOptions(preparedOpts, resolvedStreamSlot)

            return yield* SessionSlotLease.withComputeTurnstile(turnstileKey, resolvedStreamSlot, () =>
              Effect.gen(function* () {
                streamExecuted = true
                slotDuringStream = SessionSlotLease.isActivelyHeld("ses_gpu019_lead")
                turnstileDuringStream = SessionSlotLease.getTelemetry().activeComputeSlots
                yield* Deferred.succeed(streamEntered, void 0)
                yield* Deferred.await(streamGate)
                return "compaction_summary_ok"
              }),
            )
          }),
      ),
    )

    // Give compaction fiber a chance to poll; it MUST block behind fgFiber2
    await new Promise((r) => setTimeout(r, 25))
    expect(prepareExecuted).toBe(false)
    expect(streamExecuted).toBe(false)

    // Release foreground turnstile -> background compaction wakes up, acquires lease + turnstile, runs prepare, and enters stream
    await Effect.runPromise(Deferred.succeed(fgGate, void 0))
    await Effect.runPromise(Fiber.joinAll([fgFiber, fgFiber2]))
    await Effect.runPromise(Deferred.await(streamEntered))

    expect(prepareExecuted).toBe(true)
    expect(streamExecuted).toBe(true)
    expect(slotDuringPrepare).toBe(0)
    expect(slotBetweenPrepareAndStream).toBe(0)
    expect(slotDuringStream).toBe(0)
    expect(turnstileDuringPrepare).toEqual([{ sessionID: "ses_gpu019_lead:background_compaction", slot: 0 }])
    expect(turnstileDuringStream).toEqual([{ sessionID: "ses_gpu019_lead:background_compaction", slot: 0 }])
    expect((capturedStreamReq.http?.body as any)?.id_slot).toBe(0)
    expect(capturedStreamReq.httpBody?.id_slot).toBe(0)
    expect(capturedStreamReq.providerOptions?.["deepseek-local"]?.id_slot).toBe(0)
    expect(capturedStreamReq.providerOptions?.openaiCompatible?.id_slot).toBe(0)
    expect(capturedStreamOpts.id_slot).toBe(0)
    expect(capturedStreamOpts.httpBody?.id_slot).toBe(0)

    // Complete compaction stream -> both turnstile and Plane-1 lease acquired by compaction are released cleanly
    await Effect.runPromise(Deferred.succeed(streamGate, void 0))
    const compactOut = await Effect.runPromise(Fiber.join(compactFiber))
    expect(compactOut).toBe("compaction_summary_ok")
    expect(SessionSlotLease.getTelemetry().activeComputeStreamsCount).toBe(0)
    expect(SessionSlotLease.isActivelyHeld("ses_gpu019_lead")).toBeUndefined()

    // 4. Exercise real SessionCompaction.Service.compact (prepare + summarize + stream) through SessionCompaction.layer
    const { Agent } = await import("@opencode/core/agent")
    const { Bus } = await import("@opencode/core/bus")
    const { Database } = await import("@opencode/core/database/database")
    const { Model } = await import("@opencode/core/model")
    const { SessionCompaction } = await import("@opencode/core/session/compaction")
    const { SessionRunnerModel } = await import("@opencode/core/session/runner/model")
    const { LLMClient, LLMEvent, LanguageModel } = await import("@opencode/ai/effect")
    const { OpenAIChat } = await import("@opencode/ai/protocols")
    const { Layer, Stream } = await import("effect")

    const fgServiceGate = Effect.runSync(Deferred.make<void>())
    const serviceStreamEntered = Effect.runSync(Deferred.make<void>())
    const serviceStreamGate = Effect.runSync(Deferred.make<void>())

    let servicePrepareCalls = 0
    let serviceSlotInPrepare: number | undefined
    let serviceTurnstileInPrepare: Array<{ sessionID: string; slot: number }> = []
    let serviceSlotInStream: number | undefined
    let serviceTurnstileInStream: Array<{ sessionID: string; slot: number }> = []
    let serviceStreamRequest: any
    let serviceStreamOptions: any

    const mockDeps = Layer.mergeAll(
      Layer.mock(Agent.Service)({
        get: () => Effect.succeed(undefined),
      } as any),
      Layer.mock(Bus.Service)({
        publish: () => Effect.void,
      } as any),
      Layer.mock(Model.Service)({
        available: [],
      } as any),
      Layer.mock(SessionRunnerModel.Service)({
        resolve: () => Effect.die("unused"),
      } as any),
      Layer.mock(Database.Service)({
        db: {} as any,
      } as any),
      Layer.mock(SessionModelRequest.Service)({
        compaction: (input: any) =>
          Effect.sync(() => {
            servicePrepareCalls++
            serviceSlotInPrepare = SessionSlotLease.isActivelyHeld("ses_gpu019_lead")
            serviceTurnstileInPrepare = SessionSlotLease.getTelemetry().activeComputeSlots
            return {
              event: { result: undefined },
              request: attachSlotToRequest(
                {
                  model: input.model.model,
                  system: input.system ?? [],
                  messages: input.messages ?? [],
                  tools: [],
                } as any,
                input.httpBody?.id_slot,
              ),
              options: {},
              retry: () => Effect.void,
            }
          }),
      } as any),
      Layer.mock(LLMClient.Service)({
        stream: (request: any, options: any) => {
          serviceStreamRequest = request
          serviceStreamOptions = options
          serviceSlotInStream = SessionSlotLease.isActivelyHeld("ses_gpu019_lead")
          serviceTurnstileInStream = SessionSlotLease.getTelemetry().activeComputeSlots
          return Stream.fromEffect(
            Deferred.succeed(serviceStreamEntered, void 0).pipe(Effect.andThen(Deferred.await(serviceStreamGate))),
          ).pipe(
            Stream.drain,
            Stream.concat(
              Stream.make(
                LLMEvent.textDelta({ id: "sum_1", text: "## Objective\n- compacted via SessionCompaction.Service" }),
                LLMEvent.finish({ reason: { normalized: "stop" } }),
              ),
            ),
          )
        },
        generate: () => Effect.die("unused"),
      } as any),
    )

    const testModel = SessionRunnerModel.resolved(
      LanguageModel.make({
        id: "deepseek-v4",
        provider: "deepseek-local",
        route: OpenAIChat.route,
      }),
      {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: [],
        limit: { context: 393_216, output: 32_768 },
      },
    )

    const testContext = {
      session: makeSession("ses_gpu019_lead"),
      agent: {
        id: Agent.ID.make("build"),
        info: {
          name: Agent.ID.make("build"),
          mode: "primary",
          permission: [],
          options: {},
        },
      },
      tools: { definitions: [] },
      model: {
        ...testModel,
        ref: { ...testModel.ref, providerID: "deepseek-local" as any },
      },
      initial: [],
      messages: [makeUserMessage("First user turn to compact")],
    } as any

    const fgServiceFiber = Effect.runFork(
      SessionSlotLease.withComputeTurnstile("ses_gpu019_lead", 0, () => Deferred.await(fgServiceGate)),
    )
    await Effect.runPromise(Effect.yieldNow)

    const serviceCompactFiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* SessionCompaction.Service
          return yield* svc.compact({
            reason: "manual",
            inputID: "in_gpu019" as any,
            context: testContext,
          })
        }).pipe(Effect.provide(SessionCompaction.layer.pipe(Layer.provide(mockDeps)))),
      ),
    )

    await new Promise((r) => setTimeout(r, 25))
    expect(servicePrepareCalls).toBe(0)

    await Effect.runPromise(Deferred.succeed(fgServiceGate, void 0))
    await Effect.runPromise(Fiber.join(fgServiceFiber))
    await Effect.runPromise(Deferred.await(serviceStreamEntered))

    expect(servicePrepareCalls).toBe(1)
    expect(serviceSlotInPrepare).toBe(0)
    expect(serviceSlotInStream).toBe(0)
    expect(serviceTurnstileInPrepare).toEqual([{ sessionID: "ses_gpu019_lead:background_compaction", slot: 0 }])
    expect(serviceTurnstileInStream).toEqual([{ sessionID: "ses_gpu019_lead:background_compaction", slot: 0 }])
    expect((serviceStreamRequest?.http?.body as any)?.id_slot).toBe(0)
    expect(serviceStreamRequest?.httpBody?.id_slot).toBe(0)
    expect(serviceStreamRequest?.providerOptions?.["deepseek-local"]?.id_slot).toBe(0)
    expect(serviceStreamRequest?.providerOptions?.openaiCompatible?.id_slot).toBe(0)
    expect(serviceStreamOptions?.id_slot).toBe(0)
    expect(serviceStreamOptions?.httpBody?.id_slot).toBe(0)

    await Effect.runPromise(Deferred.succeed(serviceStreamGate, void 0))
    const serviceOutcome = await Effect.runPromise(Fiber.join(serviceCompactFiber))
    expect(serviceOutcome.status).toBe("completed")
    expect(SessionSlotLease.getTelemetry().activeComputeStreamsCount).toBe(0)
    expect(SessionSlotLease.isActivelyHeld("ses_gpu019_lead")).toBeUndefined()
  })
})

describe("Aquanox Dual-Tier v12.0 Backend Slot Capacity Reconciliation — GPU-031", () => {
  beforeEach(() => {
    SessionSlotLease.resetForTesting()
  })

  afterEach(() => {
    SessionSlotLease.resetForTesting()
  })

  test("setBackendSlotCapacities and reconcileBackendSlotCapacities with [98304, 65536, 32768] update getResourceSnapshot and detect capacityMismatch", async () => {
    SessionSlotLease.setBackendSlotCapacities({
      slots: [
        { id: 0, n_ctx: 98304 },
        { id: 1, n_ctx: 65536 },
        { id: 2, n_ctx: 32768 },
      ],
      configuredContextTokens: 393216,
    })

    SessionSlotLease.admitConversation({
      conversationId: "conv_96k",
      rootSessionId: "ses_lead_96k",
      resources: {
        contextTier: "384k",
        reservedSubagents: { count: 2, contextTier: "128k" },
      },
    })

    const snapMismatch = SessionSlotLease.getResourceSnapshot({ conversationId: "conv_96k" })
    expect(snapMismatch.backendReconciled).toBe(true)
    expect(snapMismatch.backendLeadBlockTokens).toBe(98304)
    expect(snapMismatch.backendQuantumTokens).toBe(32768)
    expect(snapMismatch.totalTokens).toBe(294912)
    expect(snapMismatch.unreservedFreeTokens).toBe(4 * 32768)
    expect(snapMismatch.slots[0]?.capacityTokens).toBe(98304)
    expect(snapMismatch.slots[1]?.capacityTokens).toBe(65536)
    expect(snapMismatch.slots[2]?.capacityTokens).toBe(32768)
    expect(snapMismatch.configuredContextTokens).toBe(393216)
    expect(snapMismatch.capacityMismatch).toBe(true)
    expect(snapMismatch.thisConversation?.leadContextTokens).toBe(98304)
    expect(snapMismatch.thisConversation?.subagentQuantumTokens).toBe(32768)

    // Effective slot context limits are clamped to 98,304 (Lead slots 0, 3, 6) and 32,768 (child slots 1, 2, 4, 5, 7, 8)
    expect(SessionSlotLease.getEffectiveSlotContextLimit(0, "384k", 393216)).toBe(98304)
    expect(SessionSlotLease.getEffectiveSlotContextLimit(3, "384k", 393216)).toBe(98304)
    expect(SessionSlotLease.getEffectiveSlotContextLimit(5, "128k", 131072)).toBe(32768)
    expect(SessionSlotLease.getEffectiveSlotContextLimit(8, "128k", 131072)).toBe(32768)

    // outputLimit clamps against reconciled slot capacity
    const clampedLeadOut = SessionModelRequest.outputLimit(
      { context: 393216, output: 32768 },
      { measured: 80000, estimated: 0 },
      { slotId: 0, tier: "384k", providerID: "deepseek-local" },
    )
    expect(clampedLeadOut).toBe(18304)

    const clampedChildOut = SessionModelRequest.outputLimit(
      { context: 131072, output: 16384 },
      { measured: 28000, estimated: 0 },
      { slotId: 5, tier: "128k", providerID: "deepseek-local" },
    )
    expect(clampedChildOut).toBe(4768)

    // Now test HTTP reconciliation via reconcileBackendSlotCapacities against a local mock /slots endpoint
    SessionSlotLease.resetForTesting()
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/slots") {
          return Response.json([
            { id: 0, n_ctx: 98304 },
            { id: 1, n_ctx: 65536 },
            { id: 2, n_ctx: 32768 },
            { id: 3, n_ctx: 98304 },
            { id: 4, n_ctx: 65536 },
            { id: 5, n_ctx: 32768 },
            { id: 6, n_ctx: 98304 },
            { id: 7, n_ctx: 65536 },
            { id: 8, n_ctx: 32768 },
          ])
        }
        return new Response("not found", { status: 404 })
      },
    })
    try {
      const ok = await SessionSlotLease.reconcileBackendSlotCapacities(`http://127.0.0.1:${server.port}/v1`, {
        configuredContextTokens: 98304,
      })
      expect(ok).toBe(true)
      const snapAligned = SessionSlotLease.getResourceSnapshot()
      expect(snapAligned.backendReconciled).toBe(true)
      expect(snapAligned.totalTokens).toBe(294912)
      expect(snapAligned.slots[0]?.capacityTokens).toBe(98304)
      expect(snapAligned.slots[2]?.capacityTokens).toBe(32768)
      expect(snapAligned.capacityMismatch).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  test("calculateCeiling enforces 83,558 for 96k, 53,248 for 64k, and 24,576 for 32k while preserving 128k/384k ceilings", () => {
    // 32k dedicated_3gpu quantum: 32768 - 8192 = 24576
    expect(calculateCeiling({ context: 32_768, output: 8_192 }, undefined, "deepseek-local")).toBe(24_576)
    expect(calculateCeiling({ context: 32_768, output: 8_192 }, 38_144, "deepseek-local")).toBe(24_576)

    // 64k dedicated_3gpu 2-quantum slot: 65536 - 12288 = 53248
    expect(calculateCeiling({ context: 65_536, output: 16_384 }, undefined, "deepseek-local")).toBe(53_248)
    expect(calculateCeiling({ context: 65_536, output: 16_384 }, 38_144, "deepseek-local")).toBe(53_248)

    // 96k dedicated_3gpu Lead block: Math.floor(0.85 * 98304) = 83558 (buffer = 14746)
    expect(calculateCeiling({ context: 98_304, output: 32_768 }, undefined, "deepseek-local")).toBe(83_558)
    expect(calculateCeiling({ context: 98_304, output: 32_768 }, 14_746, "deepseek-local")).toBe(83_558)
    expect(calculateCeiling({ context: 98_304, output: 32_768 }, 38_144, "deepseek-local")).toBe(83_558)

    // Preserves 128k (98,304) and 384k (334,234 / 334,233) ceilings
    expect(calculateCeiling({ context: 131_072, output: 16_384 }, undefined, "deepseek-local")).toBe(98_304)
    expect(calculateCeiling({ context: 393_216, output: 32_768 }, undefined, "deepseek-local")).toBe(334_234)
    expect(calculateCeiling({ context: 393_216, output: 32_768 }, 60_000, "deepseek-local")).toBe(334_233)
  })

  test("due() and compact({ reason: 'auto' }) skip premature auto-compaction on 32k deepseek-local subagent slots when static system prompt dominates (< 4,096 message tokens and promptTotal < 28,672), and trigger once messages >= 4,096 or promptTotal >= 28,672", async () => {
    const { Agent } = await import("@opencode/core/agent")
    const { Bus } = await import("@opencode/core/bus")
    const { Database } = await import("@opencode/core/database/database")
    const { Model } = await import("@opencode/core/model")
    const { SessionCompaction } = await import("@opencode/core/session/compaction")
    const { SessionRunnerModel } = await import("@opencode/core/session/runner/model")
    const { LLMClient, LanguageModel } = await import("@opencode/ai/effect")
    const { OpenAIChat } = await import("@opencode/ai/protocols")
    const { Layer } = await import("effect")

    SessionSlotLease.setBackendSlotCapacities({
      slots: [
        { id: 0, n_ctx: 98304 },
        { id: 1, n_ctx: 65536 },
        { id: 2, n_ctx: 32768 },
      ],
      configuredContextTokens: 98304,
    })

    const subModel = SessionRunnerModel.resolved(
      LanguageModel.make({
        id: "deepseek-v4.1-flash",
        provider: "deepseek-local",
        route: OpenAIChat.route,
      }),
      {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: [],
        limit: { context: 32_768, output: 8_192 },
      },
    )

    const shortMessages = [
      makeUserMessage("Compute 42 * 19 and return a 2-sentence summary."),
      SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_asst_b1_birch"),
        type: "assistant",
        agent: Agent.ID.make("general"),
        model: { ...subModel.ref, providerID: "deepseek-local" as any },
        content: [{ type: "text", text: "42 * 19 = 798. Summary ready." } as any],
        tokens: {
          input: 1_504,
          output: 40,
          reasoning: 120,
          cache: { read: 23_496, write: 0 },
        },
        time: { created, completed: created },
      }),
    ]

    const shortMsgTokens = estimateConversationMessageTokens(shortMessages)
    expect(shortMsgTokens).toBeGreaterThan(0)
    expect(shortMsgTokens).toBeLessThan(4_096)

    const subContextShort = {
      session: makeSession("ses_b1_birch", "ses_owner_b"),
      agent: {
        id: Agent.ID.make("general"),
        info: {
          name: Agent.ID.make("general"),
          mode: "subagent",
          permission: [],
          options: {},
        },
      },
      tools: { definitions: [] },
      model: {
        ...subModel,
        ref: { ...subModel.ref, providerID: "deepseek-local" as any },
      },
      initial: [],
      messages: shortMessages,
    } as any

    // Ceiling on 32k subagent slot is 24,576; static system prompt is 23,496 and total prompt is 25,000 (< 28,672)
    const ceiling32k = calculateCeiling(subContextShort.model.limit, undefined, "deepseek-local", {
      slotId: 2,
      tier: "128k",
    })
    expect(ceiling32k).toBe(24_576)
    expect(due(subContextShort, ceiling32k, { measured: 25_000, estimated: 0 })).toBe(false)

    // Verify compact({ reason: "auto" }) returns { status: "skipped" } without calling LLM stream
    let streamCalled = false
    const mockDeps = Layer.mergeAll(
      Layer.mock(Agent.Service)({ get: () => Effect.succeed(undefined) } as any),
      Layer.mock(Bus.Service)({ publish: () => Effect.void } as any),
      Layer.mock(Model.Service)({ available: [] } as any),
      Layer.mock(SessionRunnerModel.Service)({ resolve: () => Effect.die("unused") } as any),
      Layer.mock(Database.Service)({ db: {} as any } as any),
      Layer.mock(SessionModelRequest.Service)({ compaction: () => Effect.die("should not prepare") } as any),
      Layer.mock(LLMClient.Service)({
        stream: () => {
          streamCalled = true
          return Effect.die("should not stream") as any
        },
        generate: () => Effect.die("unused"),
      } as any),
    )

    const skippedOutcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* SessionCompaction.Service
          return yield* svc.compact({
            reason: "auto",
            context: subContextShort,
            estimate: { measured: 25_000, estimated: 0 },
          })
        }).pipe(Effect.provide(SessionCompaction.layer.pipe(Layer.provide(mockDeps)))),
      ),
    )
    expect(skippedOutcome).toEqual({ status: "skipped" })
    expect(streamCalled).toBe(false)

    // Once promptTotal >= 28,672 (ceiling + 4,096), due() triggers auto-compaction even with short messages
    expect(due(subContextShort, ceiling32k, { measured: 28_672, estimated: 0 })).toBe(true)

    // Once conversation messages >= 4,096 tokens, due() triggers auto-compaction at 25,000 tokens
    const heavyMessages = [
      ...shortMessages,
      makeUserMessage("x".repeat(20_000)),
    ]
    expect(estimateConversationMessageTokens(heavyMessages)).toBeGreaterThanOrEqual(4_096)
    const subContextHeavy = {
      ...subContextShort,
      messages: heavyMessages,
    }
    expect(due(subContextHeavy, ceiling32k, { measured: 25_000, estimated: 0 })).toBe(true)
  })

  test("capLiveReconciledReasoningBudget caps subagent at 384, Lead turn-entry/error at 512, and Lead continuation at 256", () => {
    // Zero/minimal budget remains 0
    expect(
      SessionRunnerLLM.capLiveReconciledReasoningBudget(0, {
        isSubagent: false,
        isTurnEntry: true,
        isSynthesizing: false,
        hasErrorOrDiagnostic: false,
      }),
    ).toBe(0)

    // Subagent is capped at 384 across turn entry, error, synthesis, or continuation
    expect(
      SessionRunnerLLM.capLiveReconciledReasoningBudget(2048, {
        isSubagent: true,
        isTurnEntry: true,
        isSynthesizing: false,
        hasErrorOrDiagnostic: false,
      }),
    ).toBe(384)
    expect(
      SessionRunnerLLM.capLiveReconciledReasoningBudget(1024, {
        isSubagent: true,
        isTurnEntry: false,
        isSynthesizing: true,
        hasErrorOrDiagnostic: false,
      }),
    ).toBe(384)
    expect(
      SessionRunnerLLM.capLiveReconciledReasoningBudget(256, {
        isSubagent: true,
        isTurnEntry: false,
        isSynthesizing: false,
        hasErrorOrDiagnostic: false,
      }),
    ).toBe(256)

    // Lead turn-entry and error/diagnostic steps are capped at 512
    expect(
      SessionRunnerLLM.capLiveReconciledReasoningBudget(2048, {
        isSubagent: false,
        isTurnEntry: true,
        isSynthesizing: false,
        hasErrorOrDiagnostic: false,
      }),
    ).toBe(512)
    expect(
      SessionRunnerLLM.capLiveReconciledReasoningBudget(2048, {
        isSubagent: false,
        isTurnEntry: false,
        isSynthesizing: false,
        hasErrorOrDiagnostic: true,
      }),
    ).toBe(512)

    // Lead continuation / synthesis steps are capped at 256
    expect(
      SessionRunnerLLM.capLiveReconciledReasoningBudget(1024, {
        isSubagent: false,
        isTurnEntry: false,
        isSynthesizing: false,
        hasErrorOrDiagnostic: false,
      }),
    ).toBe(256)
    expect(
      SessionRunnerLLM.capLiveReconciledReasoningBudget(1024, {
        isSubagent: false,
        isTurnEntry: false,
        isSynthesizing: true,
        hasErrorOrDiagnostic: false,
      }),
    ).toBe(256)
  })

  test("GPU-038: releaseConversation and release quarantine physical slot and quanta while surviving compute scope is active, then auto-release on exit", async () => {
    SessionSlotLease.reset()

    const adm = SessionSlotLease.admitConversation({
      conversationId: "conv_gpu038",
      rootSessionId: "ses_lead_038",
      reservedSubagentQuanta: 3,
      maxConcurrentSubagents: 3,
    })
    expect(adm.admitted).toBe(true)
    expect(adm.leadSlotId).toBe(0)
    expect(SessionSlotLease.acquire("ses_lead_038", false)).toBe(0)

    SessionSlotLease.registerChildSession("ses_sub_038", "ses_lead_038")
    SessionSlotLease.setSessionTier("ses_sub_038", "128k")
    const subSlot = Effect.runSync(
      SessionSlotLease.acquireSubagentAsync({
        sessionID: "ses_sub_038",
        parentSessionID: "ses_lead_038",
        tier: "128k",
      }),
    )
    expect(subSlot).toBe(5)

    const startedGate = Effect.runSync(Deferred.make<void>())
    const finishGate = Effect.runSync(Deferred.make<void>())

    const computeFiber = Effect.runFork(
      SessionSlotLease.withComputeTurnstile("ses_sub_038", subSlot, () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(startedGate, undefined)
          yield* Deferred.await(finishGate)
          return "done"
        }),
      ),
    )

    await Effect.runPromise(Deferred.await(startedGate))
    expect(SessionSlotLease.hasActiveComputeScope("ses_sub_038")).toBe(true)

    // Premature release while ses_sub_038 compute stream is still active in llama.cpp
    SessionSlotLease.releaseConversation("conv_gpu038", "ses_lead_038")
    SessionSlotLease.release("ses_sub_038")

    // Slot 5 and conversation quanta MUST remain quarantined while compute is active
    expect(SessionSlotLease.isActivelyHeld("ses_sub_038")).toBe(5)
    expect(SessionSlotLease.activeCount(subSlot)).toBe(1)
    expect(SessionSlotLease.peek("ses_sub_038")).toBe(subSlot)

    const snapDuring = SessionSlotLease.getResourceSnapshot()
    expect(snapDuring.deferredReleaseSessions).toBe(1)
    expect(snapDuring.deferredReleaseSessionIds).toContain("ses_sub_038")
    expect(snapDuring.quarantinedConversations).toBe(1)
    expect(snapDuring.committedQuanta128k).toBe(4) // 3 lead + 1 active subagent quantum

    const telemetryDuring = SessionSlotLease.getTelemetry()
    expect(telemetryDuring.deferredReleaseSessions).toBe(1)
    expect(telemetryDuring.activeComputeStreamsCount).toBe(1)

    // Another subagent cannot steal subSlot (slot 5) while quarantined
    const intruderSlot = Effect.runSync(
      SessionSlotLease.acquireSubagentAsync({
        sessionID: "ses_intruder",
        tier: "128k",
      }),
    )
    expect(intruderSlot).not.toBe(subSlot)
    SessionSlotLease.release("ses_intruder")

    // Complete surviving compute scope -> deferred release must auto-finalize
    await Effect.runPromise(Deferred.succeed(finishGate, undefined))
    const joinRes = await Effect.runPromise(Fiber.join(computeFiber))
    expect(joinRes).toBe("done")

    expect(SessionSlotLease.hasActiveComputeScope("ses_sub_038")).toBe(false)
    expect(SessionSlotLease.isActivelyHeld("ses_sub_038")).toBeUndefined()
    expect(SessionSlotLease.activeCount(subSlot)).toBe(0)
    expect(SessionSlotLease.peek("ses_sub_038")).toBeUndefined()

    const snapAfter = SessionSlotLease.getResourceSnapshot()
    expect(snapAfter.deferredReleaseSessions).toBe(0)
    expect(snapAfter.quarantinedConversations).toBe(0)
    expect(snapAfter.committedQuanta128k).toBe(0)
    expect(snapAfter.freeFullBlocks384k).toBe(3)

    // =========================================================================
    // Explicit slot-8 double-allocation scenario across Conversations A & B:
    // - Admit Conversation A (lead on Block 0 / slot 0) and Conversation B (lead on Block 1 / slot 3)
    // - Conversation A spawns a subagent that occupies slot 8 (in Block 2) and enters withComputeTurnstile (held open via Deferred)
    // - Call SessionSlotLease.releaseConversation on Conversation A while slot-8 subagent is still inside withComputeTurnstile
    // - Verify that when Conversation B spawns a subagent, it CANNOT double-allocate slot 8 while Conversation A's subagent compute stream is active (deferredReleaseSessions > 0)
    // - Once the Deferred completes, slot 8 and Conversation A's resources are automatically released!
    // =========================================================================
    SessionSlotLease.reset()

    // 1. Admit Conversation A (lead on Block 0 / slot 0)
    const admA = SessionSlotLease.admitConversation({
      conversationId: "conv_A",
      rootSessionId: "ses_lead_A",
      resources: { contextTier: "384k" },
    })
    expect(admA.admitted).toBe(true)
    expect(admA.leadBlockId).toBe(0)
    expect(admA.leadSlotId).toBe(0)
    expect(SessionSlotLease.acquire("ses_lead_A", false)).toBe(0)

    // 2. Admit Conversation B (lead on Block 1 / slot 3)
    const admB = SessionSlotLease.admitConversation({
      conversationId: "conv_B",
      rootSessionId: "ses_lead_B",
      resources: { contextTier: "384k" },
    })
    expect(admB.admitted).toBe(true)
    expect(admB.leadBlockId).toBe(1)
    expect(admB.leadSlotId).toBe(3)
    expect(SessionSlotLease.acquire("ses_lead_B", false)).toBe(3)

    // 3. Conversation A spawns a subagent occupying slot 8 in Block 2
    SessionSlotLease.registerChildSession("ses_sub_A", "ses_lead_A")
    SessionSlotLease.setSessionTier("ses_sub_A", "128k")
    const slotSubA = Effect.runSync(
      SessionSlotLease.acquireSubagentAsync({
        sessionID: "ses_sub_A",
        parentSessionID: "ses_lead_A",
        tier: "128k",
      }),
    )
    expect(slotSubA).toBe(8)

    // 4. Subagent enters withComputeTurnstile held open via Deferred
    const gateStartedA = Effect.runSync(Deferred.make<void>())
    const gateFinishA = Effect.runSync(Deferred.make<void>())

    const computeFiberA = Effect.runFork(
      SessionSlotLease.withComputeTurnstile("ses_sub_A", slotSubA, () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(gateStartedA, undefined)
          yield* Deferred.await(gateFinishA)
          return "compute_done_A"
        }),
      ),
    )

    await Effect.runPromise(Deferred.await(gateStartedA))
    expect(SessionSlotLease.hasActiveComputeScope("ses_sub_A")).toBe(true)

    // 5. Call SessionSlotLease.releaseConversation on Conversation A while slot-8 subagent is still inside withComputeTurnstile
    SessionSlotLease.releaseConversation("conv_A", "ses_lead_A")

    // Quarantined: deferredReleaseSessions > 0, slot 8 still actively held
    const snapQuarantineA = SessionSlotLease.getResourceSnapshot()
    expect(snapQuarantineA.deferredReleaseSessions).toBeGreaterThan(0)
    expect(snapQuarantineA.deferredReleaseSessionIds).toContain("ses_sub_A")
    expect(snapQuarantineA.quarantinedConversations).toBe(1)
    expect(SessionSlotLease.isActivelyHeld("ses_sub_A")).toBe(8)
    expect(SessionSlotLease.activeCount(8)).toBe(1)

    // 6. Verify Conversation B spawning a subagent CANNOT double-allocate slot 8
    SessionSlotLease.registerChildSession("ses_sub_B", "ses_lead_B")
    SessionSlotLease.setSessionTier("ses_sub_B", "128k")
    const slotSubB = Effect.runSync(
      SessionSlotLease.acquireSubagentAsync({
        sessionID: "ses_sub_B",
        parentSessionID: "ses_lead_B",
        tier: "128k",
      }),
    )
    // Slot 8 is quarantined by Conv A's active compute stream; Conv B must get slot 7, NOT 8!
    expect(slotSubB).not.toBe(8)
    expect(slotSubB).toBe(7)

    // 7. Complete the Deferred: slot 8 and Conversation A's resources are automatically released!
    await Effect.runPromise(Deferred.succeed(gateFinishA, undefined))
    const joinResA = await Effect.runPromise(Fiber.join(computeFiberA))
    expect(joinResA).toBe("compute_done_A")

    expect(SessionSlotLease.hasActiveComputeScope("ses_sub_A")).toBe(false)
    expect(SessionSlotLease.isActivelyHeld("ses_sub_A")).toBeUndefined()
    expect(SessionSlotLease.peek("ses_sub_A")).toBeUndefined()
    expect(SessionSlotLease.activeCount(8)).toBe(0)

    const snapAfterA = SessionSlotLease.getResourceSnapshot()
    expect(snapAfterA.deferredReleaseSessions).toBe(0)
    expect(snapAfterA.quarantinedConversations).toBe(0)

    // Clean up Conversation B
    SessionSlotLease.release("ses_sub_B")
    SessionSlotLease.releaseConversation("conv_B", "ses_lead_B")
  })
})
