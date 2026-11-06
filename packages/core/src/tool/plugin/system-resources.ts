export * as SystemResourcesTool from "./system-resources.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Permission } from "../../permission.js"
import { SessionSlotLease } from "../../session/slot-lease.js"

export const name = "inspect_system_resources"

export const DESCRIPTION = [
  "Inspect current system hardware slot and context memory allocations across the 9-quantum Buddy Arena.",
  "Returns deterministic visibility into 128k/384k Buddy Blocks (0..2), physical slots (0..8), committed reservations, active subagents, unreserved opportunistic capacity, and admission readiness.",
  "Use this tool before spawning heavy concurrent subagents or multi-agent pipelines to verify available quanta and prevent starvation.",
  "A single conversation is hard-limited to at most 3 concurrent subagents (<= 3x128k or 1x384k), preserving room for concurrent conversations.",
].join(" ")

export const Input = Schema.Struct({
  conversation_id: Schema.optionalKey(Schema.String).annotate({
    description: "Optional conversation ID to filter or inspect. Defaults to the current session's conversation.",
  }),
})

export const Output = Schema.Record(Schema.String, Schema.Unknown)

function formatSnapshotMarkdown(s: SessionSlotLease.SystemResourceSnapshot): string {
  const quantumK = Math.round((s.backendQuantumTokens ?? 131072) / 1024)
  const leadK = Math.round((s.backendLeadBlockTokens ?? 393216) / 1024)
  const lines: string[] = [
    `# System Resource Coordinator Snapshot (Gen ${s.generation})`,
    "",
    `**Quanta Overview:** ${s.committedQuanta128k} / 9 committed (${quantumK}k quanta), ${s.activeQuanta128k} active, ${s.unreservedFreeQuanta128k} unreserved free (${Math.round(s.unreservedFreeTokens / 1024)}k tokens).`,
    `**Full ${leadK}k Blocks Free:** ${s.freeFullBlocks384k} / 3. **Lead Admission Ready:** ${s.canAdmitNewLeadConversation ? "YES" : "NO"}.`,
    ...(s.capacityMismatch
      ? [
          `**Capacity Reconciliation Warning:** Configured model context (${s.configuredContextTokens} tokens) exceeds active backend Lead block capacity (${s.backendLeadBlockTokens} tokens); clamped to live backend slot capacities.`,
        ]
      : []),
    "",
    `### Buddy Blocks (3 x ${leadK}k)`,
  ]

  for (const b of s.blocks) {
    const owner = b.ownerConversationId ? ` [Owner: ${b.ownerConversationId}]` : ""
    lines.push(`- **Block ${b.blockId}**: mode=${b.mode}${owner} (Slots ${b.slots.join(", ")})`)
  }

  lines.push("", "### Physical Slots (0..8)")
  for (const sl of s.slots) {
    const status = sl.busy ? `BUSY (sessions: ${sl.activeSessionIds.join(", ")})` : sl.lockedBy384k ? "LOCKED (384k)" : "IDLE"
    const pinned = sl.pinnedSessionId ? ` [pinned: ${sl.pinnedSessionId}]` : ""
    lines.push(`- **Slot ${sl.slotId}** (${sl.capacityTokens / 1024}k): ${status}${pinned}`)
  }

  if (s.thisConversation) {
    const tc = s.thisConversation
    lines.push(
      "",
      "### Current Conversation State",
      `- **Conversation ID:** ${tc.conversationId}`,
      `- **Lead Tier:** ${tc.leadContextTier} (Slot ${tc.leadSlotId})`,
      `- **Subagents:** ${tc.activeSubagents} active (${tc.activeSubagentQuanta128k} quanta), ${tc.reservedSubagents128k} reserved`,
      `- **Available for this conversation:** Guaranteed=${tc.guaranteedAvailable128k}, Opportunistic=${tc.opportunisticAvailable128k}`,
      `- **Max Spawnable Right Now:** 128k=${tc.maxSpawnableNow128k}, 384k=${tc.maxSpawnableNow384k}`,
      `- **Queued Waiters:** ${tc.queuedSubagentWaiters}`,
    )
  }

  return lines.join("\n")
}

export const Plugin = {
  id: "opencode.tool.inspect_system_resources",
  effect: Effect.fn("SystemResourcesTool.Plugin")(function* (ctx: Context) {
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name,
          options: { codemode: false },
          description: DESCRIPTION,
          input: Input,
          output: Output,
          execute: (input, context) =>
            permission
              .assert({
                action: name,
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              .pipe(
                Effect.mapError(
                  (error) => new ToolFailure({ message: "Unable to inspect system resources", error }),
                ),
                Effect.andThen(() =>
                  !SessionSlotLease.isBackendReconciled() &&
                  process.env.NODE_ENV !== "test" &&
                  !process.env.BUN_TEST
                    ? Effect.promise(() => SessionSlotLease.reconcileBackendSlotCapacities().catch(() => false))
                    : Effect.void,
                ),
                Effect.map(() => {
                  const snapshot = SessionSlotLease.getResourceSnapshot({
                    conversationId: input.conversation_id,
                    sessionId: context.sessionID,
                  })
                  return {
                    output: snapshot as any,
                    content: formatSnapshotMarkdown(snapshot),
                    metadata: {
                      generation: snapshot.generation,
                      committedQuanta128k: snapshot.committedQuanta128k,
                      unreservedFreeQuanta128k: snapshot.unreservedFreeQuanta128k,
                    },
                  }
                }),
              ),
        })
      })
      .pipe(Effect.orDie)
  }),
}
