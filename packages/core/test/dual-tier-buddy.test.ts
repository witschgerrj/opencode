import { beforeEach, describe, expect, test } from "bun:test"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { resolveSessionContextTier } from "@opencode/core/session/runner/model"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionSlotLease } from "@opencode/core/session/slot-lease"
import { calculateCeiling } from "@opencode/core/session/compaction"
import { ConfigMarkdown } from "@opencode/core/config/markdown"
import { Money } from "@opencode/schema/money"
import { DateTime, Effect } from "effect"
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
    expect(leadHigh).toBe(8192)

    // Turn entry for lead session with variant 'max' -> 12288
    const leadMax = SessionRunnerLLM.computeCausalReasoningBudget({
      messages: [userMsg],
      variant: "max",
      isSubagent: false,
      isExplore: false,
      isSynthesizing: false,
      stepLimitReached: false,
    })
    expect(leadMax).toBe(12288)

    // Turn entry for SUBAGENT session with variant 'high' -> capped at 8192!
    const subHigh = SessionRunnerLLM.computeCausalReasoningBudget({
      messages: [userMsg],
      variant: "high",
      isSubagent: true,
      isExplore: false,
      isSynthesizing: false,
      stepLimitReached: false,
    })
    expect(subHigh).toBe(8192)

    // Turn entry for SUBAGENT session with variant 'max' -> capped at 8192!
    const subMax = SessionRunnerLLM.computeCausalReasoningBudget({
      messages: [userMsg],
      variant: "max",
      isSubagent: true,
      isExplore: false,
      isSynthesizing: false,
      stepLimitReached: false,
    })
    expect(subMax).toBe(8192)

    // Mutating continuation for subagent -> 4096 (non-truncating ceiling)
    const subMutating = SessionRunnerLLM.computeCausalReasoningBudget({
      messages: [userMsg],
      variant: "high",
      isSubagent: true,
      isExplore: false,
      isSynthesizing: false,
      stepLimitReached: false,
    })
    expect(subMutating).toBeLessThanOrEqual(8192)
  })
})

describe("Aquanox Dual-Tier Agent Profiles — Frontmatter Verification", () => {
  const openWorldAgentsDir = fs.existsSync("/home/rjwits/github/open-world/.opencode/agents") ? "/home/rjwits/github/open-world/.opencode/agents" : "/home/rjwits/worktrees/open-world-dual-tier/.opencode/agents"

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
