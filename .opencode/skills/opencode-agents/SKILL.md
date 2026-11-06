---
name: opencode-agents
description: Configure select orchestrate OpenCode V2 primary agents subagent trees buddy slot leases and child session lifecycle
---

# OpenCode Agents and Subagents

OpenCode V2 agent bundles system prompt, model preference, exec mode, step limit, ordered permissions, UI metadata into named profile.

> **Core Invariant**: Never degrade the quality of an agent's output in favor of invoking the agent. The 9-Quantum Buddy Slot system (`384k` Leads, `128k` Subagents, `keep_reserved` GPU tool slot policy) exists explicitly to ensure agents have appropriate bandwidth to think and process data, guaranteeing dedicated KV context and compute/memory headroom so agents never suffer reasoning truncation or output quality degradation.

## Boundaries with Neighbor Skills

- Model catalog, variants, API compatibility: Use `opencode-models` (and `opencode-providers` for credentials/endpoints).
- Permission matching, wildcards, saved grants, live approval prompts: Use `opencode-permissions`, `opencode-human-input`.
- Root session creation, prompt turns, forking, deletion: Use `opencode-session-lifecycle`.
- Slash commands switching agents or spawning background runs: Use `opencode-commands`.

## Core Workflow

1. **Choose definition scope and format**:
   - Reusable profiles: Markdown files in `~/.config/opencode/agents/<name>.md` (global), system config `agents/`, `.opencode/agents/<name>.md` (project upward discovery), or inline under `agents` in `opencode.json(c)`.
   - Nested dirs form slash-scoped IDs (`.opencode/agents/team/reviewer.md` → `team/reviewer`).
   - Read `references/configuration.md` for V2 fields, `default_agent` fallback rules, V1 migration caveats.
2. **Separate primary selection from subagent delegation**:
   - `mode: "primary"` (default custom agents) runs as main session agent; `mode: "subagent"` runs only child sessions via `subagent` tool; `mode: "all"` supports both.
   - Inspect live `agent.list({ location })` / `agent.get({ agentID, location })` metadata for actual `mode`, `hidden`, `permissions` (do not infer from display labels).
3. **Orchestrate and verify child-session trees**:
   - Subagents exec with fresh ctx, own configured `permissions`, configured `model` (inherit parent model only when unset).
   - Display, await, stop subagent trees: follow [child-sessions.md](references/child-sessions.md).

## 9-Quantum Buddy Slot Allocator (`packages/core/src/session/slot-lease.ts`)

9-quantum dual-tier Buddy Arena (`9Q = 1,179,648` unified pure-`FP16` MLA+DSA tokens) across 3 Buddy Blocks:
- **Block 0**: Slots `0, 1, 2` (`384k` Lead or `3 × 128k` subagents)
- **Block 1**: Slots `3, 4, 5` (`384k` Lead or `3 × 128k` subagents)
- **Block 2**: Slots `6, 7, 8` (`384k` Lead or `3 × 128k` subagents)
- **Preference Order**: `SUBAGENT_SLOT_PREFERENCE = [2, 5, 8, 1, 4, 7, 0, 3, 6] as const`

| Allocation Profile | Concurrency Topology | Slot Mapping | Quanta Invariant |
| :--- | :--- | :--- | :--- |
| **Profile A (2 Leads + 3 Subagents)** | 2 Leads (`384k`) + 3 Subagents (`128k`) | Leads lock Blocks 0 (`0..2`) & 1 (`3..5`); Subagents acquire **`8, 7, 6`** in Block 2 | Saturation at `9/9` quanta; zero slot blocking |
| **Single-Lead Packing** | 1 Lead (`384k`) + 3 Subagents (`128k`) | Lead locks Block 0; Subagents pack into **`5, 4, 3`** in Block 1 | Block 2 stays `"idle"` (`freeFullBlocks384k === 1` preserved for 2nd Lead) |
| **Profile B (Lead Max)** | 3 Leads (`384k`) | Leads lock Blocks 0, 1, 2 (`slots 0, 3, 6`) | 0 subagent quanta; subagents queue in `waiterQueue` |

- **Plane-2 Stride-Aligned Compute Turnstile (`SessionSlotLease.withComputeTurnstile`)**:
  - Decouples Plane-1 KV residency (`N = 9` persistent slots) from Plane-2 active forward-pass compute (`K = 3` stride-aligned streams default via `DEFAULT_STRIDE_ALIGNED_COMPUTE_STREAMS = 3`, configurable via `AQUANOX_MAX_COMPUTE_STREAMS`, hard cap `MAX_ACTIVE_COMPUTE_STREAMS = 4`).
  - Wraps each LLM `steps.attempt` in `runner/index.ts`. Waiter arbitration (`computeWaiterAffinityScore`) prioritizes distinct modulo-3 residue classes (`slotId % 3` across Blocks 0/1/2) and `128k_split` block locality, with a `15,000 ms` / 2-wave starvation guard (`COMPUTE_STARVATION_THRESHOLD_MS = 15_000`, `COMPUTE_STARVATION_MAX_BYPASSED_WAVES = 2`).
- **Causal Reasoning Scheduler (`computeCausalReasoningBudget` & `capLiveReconciledReasoningBudget` in `runner/llm.ts`)**:
  - Dynamically scales `reasoning_budget_tokens` per step: **Tier 1** (`1024..2048` on turn entry / error diagnosis via `FAILURE_DIAGNOSTIC_REGEX`), **Tier 2** (`512` on multi-file fan-in `previousToolCount >= 3` or `cumulativeExploratorySteps >= 2`), **Tier 3** (`1024` on clean mutating continuation or `request_synthesis`), **Tier 4** (`256` on single exploratory read/grep/glob continuation). Sets `think_temp: 0.85` on error/diagnostic vs `0.55` normal (`think_min_p: 0.01`).
  - **Live Reasoning Budget Cap (`S05`)**: Under 3-stream concurrent decode (`~9.4–12.5 t/s` per slot), an uncapped `2048` reasoning budget causes sessions to spend `130–170s` drafting rough essays inside `<think>`. Live reconciled budgets are capped at **`512` Lead turn-entry**, **`256` Lead continuation**, and **`384` Subagent**, keeping reasoning focused and eliminating 200s+ turn timeouts.
- **32k Subagent Auto-Compaction Guard (`S04`)**: When static system prompts + skill headers + tool schemas consume `~23,496` tokens, `due()` guards `32k` subagent slots against auto-compaction while conversation messages are `< 4,096` tokens and total prompt tokens are `< 28,672`, preventing ~90s stalls on un-compactable static instructions.
- **Dual-Home Config Synchronization (`S05`)**: Always sync config updates (`opencode.json`) to `/var/lib/aquanox-runner/home/.config/opencode/opencode.json` in addition to `/home/rjwits/.config/opencode/opencode.json` because `aquanox-opencode.service` runs with `HOME=/var/lib/aquanox-runner/home`.

## GPU Tool Slot Reservation Policy (`SessionSlotLease.withGpuToolSlotPolicy`)

```typescript
withGpuToolSlotPolicy(sessionID, use, { suspendMode?: "keep_reserved" | "evict_and_reacquire" | "save_full_state" })
```
- **`suspendMode: "keep_reserved"` (Default)**: Keeps `activeSessionsBySlot[slot]` locked to `sessionID` during GPU tool calls (`generate_image`, `godot_gpu`). Sibling subagents cannot overwrite the `:8080` KV prefix. Resume latency is **`0 ms`**.
- **`suspendMode: "evict_and_reacquire"`**: Deletes `stickySubagentSlotBySession` and clears active slot. Registers `Effect.onInterrupt(() => removeWaitersForSession(sessionID))` for `< 10 ms` waiter cleanup.
- **`suspendMode: "save_full_state"`**: Permitted only when `AQUANOX_FULL_SLOT_STATE_SAVE === "1"`.

## Child-Scoped Teardown & Nesting Depth Clamp

- **Scoped Release (`SessionSlotLease.releaseSubagentSession`)**:
  - `releaseSubagentSession(sessionID, { purge })` releases only that child's active quantum (`activeSessionsBySlot[slot] = null`) and wakes queued waiters.
  - When `purge: true`, cleans `stickySubagentSlotBySession`, `sessionTierMap`, and `childParentMap` without touching parent Lead's `384k` conversation lease.
- **Nesting Clamp (`MAX_SUBAGENT_DEPTH = 1`)**:
  - `subagent.ts` sets `MAX_SUBAGENT_DEPTH = 1`.
  - `resolveMaxSubagentDepth(configuredLimit)` enforces `Math.min(configuredLimit ?? MAX_SUBAGENT_DEPTH, hardMaxDepth)` (`1` unless `AQUANOX_FULL_SLOT_STATE_SAVE === "1"`).
  - Enforces `180s` admission timeout; purges reservation on timeout (`ERR_SUBAGENT_ADMISSION_TIMEOUT`). Never falls back to unleased `id_slot: -1`.
- **Effect v4 Combinator Hygiene & Scoped Cleanup (`GPU-032`)**:
  - OpenCode uses `effect@4.0.1`, where `Effect.catchAll`, `Effect.catchAllCause`, `Effect.catchAllDefect`, and `Effect.failCause` are removed. Always use `Effect.catch` or `Effect.catchCause`. Calling removed combinators triggers runtime `TypeError: Effect.catchAll is not a function` during pipeline construction.
  - All operations after child session registration and slot acquisition (`registerChildSession`, `registerWriteScope`, `acquireSubagentAsync`, broker admission) must run inside an outer `Effect.onExit` / `Effect.ensuring` cleanup scope that unconditionally invokes `SessionSlotLease.releaseSubagentSession(childId, { purge: true })` and `activeWriteScopes.delete(childId)` on error or interruption, preserving `sessionID: ${child.id}` in `ToolFailure` responses.

## Graph-Coupled Subagent Partitioning & Bounded `Explore` Contract

- **Graph-Coupled Partitioning Over Prompt-Noun Counting (`subagent.ts`, `epoch-prefix.ts`, `system.txt`, `system-prompt.ts`, `deepseek.txt`)**:
  - **Rule 1 (Scout Shared Hub First)**: Handle single-module or tightly coupled vertical slices (`<= 10` files) directly in Root ($k^* = 0$) via `read({ batch, compact: true })` + parallel `grep`/`glob`. When a shared hub fans out into disjoint spokes, read the shared hub **once in Root (`2–4` fast calls)** and spawn subagents **only for disjoint spokes** (or spawn mid-trace when a scout reveals `>= 2` orthogonal downstream branches with $O_{\text{cf}}^{\text{file}} = 0\%$, preventing `9.5x–10.1x` Root KV-Cache History Growth Amplification $\text{HGA}_{\text{root}}$).
  - **Rule 2 (Disjoint `include`/`exclude` Boundaries)**: Every subagent prompt must specify explicit directory/file `include` and shared-hub `exclude` boundaries so sibling file overlap stays $O_{\text{sib}}^{\text{file}} < 10\%$.
  - **Rule 3 (Hard `Explore` Budget — No `"Very Thorough"` Inducement)**: `PROMPT_EXPLORE` (`packages/core/src/plugin/agent.ts`) caps `explore` subagents at **`<= 5` turns and `<= 12–15` batched tool calls** ($S_{\text{creep}} \le 3.0$ TCs/file, $\text{TCTR} < 15\%$). Never pass `"Thoroughness: very thorough"` (which triggered `39–58` TCs/child and a `59%` redundant post-discovery grep tail). Once target files in scope are read, `explore` must stop and call `request_synthesis({})` immediately.
  - **Rule 4 (Verbatim Snippets for $T_{\text{parent}}^{\text{read}} = 0\%$)**: Subagents must return clickable `[symbol](file:///abs/path#L1-L10)` links **plus verbatim 3–10 line code snippets/signatures/conditionals** so Root synthesizes directly upon child return without re-reading child files.
- **Recency Placement of `subagentReminder` (`packages/core/src/session/epoch-prefix.ts`)**:
  - `getSubagentReminder` is placed at the tail of `reminderParts` (`[workspaceSummary, renderedVolatile, subagentReminder]`) immediately above `</system-reminder>\n\n${msg.text}` so `<env>...</env>` never buries the subagent partitioning directive.

## Critical Invariants and Gotchas

- **Switching primary agents never changes session model**: Sessions store selected model independently. `session.switchAgent` (`POST /api/session/:id/agent`) changes only active agent. Changing `default_agent` in config never alters existing sessions.
- **Subagent tool-schema budgeting via `permissions`**: Subagent sessions assemble prompts with tool schemas for all permitted tools. Specialized subagents (research/review) must configure explicit `deny` rules on unused heavy tools (`execute`, `write`, `edit`, `patch`, `todowrite`) to trim schemas, minimize prompt prefill latency.
- **Parent permissions gate target IDs, not child tools**: Parent `{ "action": "subagent", "resource": "<agent-id>", "effect": "..." }` rule controls *which* subagents launch; never restricts child tool permissions once launched.
- **`hidden: true` is visibility, not security**: Hidden agents vanish from pickers, `subagent` tool catalog. Permissions enforce access control. Built-in hidden `compaction`, `title`, `summary` cannot be selected directly.
- **`request` overlays inert**: V2 preserves `agents.<id>.request` (`headers`, `body`) in config, but session runner does not send with model reqs. Put active `headers`, `body`, sampling settings on provider, model, or model `#variant`.
- **Permission ordering and home expansion**: Global `permissions` apply before `agents.<id>.permissions`. Last matching rule wins (broad denies/asks before narrow allows). `~` and `$HOME` expand for `read`, `edit`, `external_directory` resources. `shell` resources match raw command text without home expansion.
- **Root idle can precede background child delivery**: Parent session can become idle while background subagent still runs or before completion message wakes parent inbox. Never treat single root-idle event or root stop call as proof descendant family settled.
- **Child `#max` variant inheritance trap (`subagent.ts:187`)**: Child spawns without variant override inherited Root `#max` variant (`effort: "max"`, `-1` unbounded `<think>`) → spiral into `32,768`-token `finish="length"` cliffs. In `subagent.ts:187`, child spawns (`!!parentID`) without overrides default to `#subagent-high` (`effort: "high"` [75], `reasoning_budget_tokens: 4096`), fallback `#high` (`effort: "high"`, `reasoning_budget_tokens: 8192`).
- **Dual-layer `explore` `"shell": "deny"` lockdown (`config/plugin/agent.ts:83-91`)**: Setting `"shell": "deny"` only in built-in `packages/core/src/plugin/agent.ts:82` overridden if top-level `opencode.json` `permissions` has `{ "action": "shell", "effect": "allow" }` (top-level merges *after* built-in agent permissions; lastMatch wins). Mandatory dual-layer: lock `plugin/agent.ts:82` AND add terminal rule `{ "action": "shell", "resource": "*", "effect": "deny" }` in `agents.explore.permissions` in `opencode.json`.
- **3-Way security allowlist requirement for new built-in tools**: Hardened envs with default-deny policies (`tool.use: * -> deny`) and permissions (`*: * -> deny`): any new built-in tool (e.g. `request_synthesis`) requires explicit allow in 3 places:
  1. Top-level `permissions`
  2. Agent-level `agents.<id>.permissions` (both `general`, `explore`)
  3. Top-level `policies` (`{ "action": "tool.use", "resource": "request_synthesis:*", "effect": "allow" }`)
  Missing any blocks invocation.
