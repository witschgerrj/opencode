---
name: opencode-compaction
description: Configure trigger reconcile OpenCode V2 context compaction budgets slot leases and unleased inference prevention
---

# OpenCode Compaction

Compaction keeps long sessions running past model context windows by replacing older turns with handoff summaries (or provider-native checkpoints) while retaining exact recent history.

## Scope & Neighbor Boundaries

- **Skill owns**: `compaction` config (`auto`, `keep.tokens`, `buffer`), `agents.compaction.model`, `experimental.background_compaction`, provider/model `settings.compaction.type` (`summary` vs `native`), manual `POST /api/session/:id/compact`, model-visible `GET /api/session/:id/context`, and slot lease wrapping for local GPU compaction.
- **Sibling skills**:
  - `opencode-session-lifecycle` — session creation, `Session.remove` child vs root release, unleased `:8080` call prevention.
  - `opencode-agents` — agent profiles, Buddy slot allocator (`SUBAGENT_SLOT_PREFERENCE`).
  - `opencode-messages-parts` — durable transcript hydration (`message.list`), retaining old turns post-compaction.
  - `opencode-snapshots` — undo/revert turns and workspace file edits.
  - `opencode-inbox-delivery` — `steer` vs `queue` inbox mechanics.
  - `opencode-event-streams` — subscribe to `session.compaction.*` SSE events.
  - `opencode-instructions` — baseline reload and nested instruction re-injection.
  - `opencode-models` / `opencode-providers` — declare model context and input token limits.

Read `references/compaction-contracts.md` for config tables, background/native rules, and SDK contracts.

## Core Workflow

1. **Tune auto compaction budget (`opencode.jsonc`)**:
   - Enabled by default (`compaction.auto: true`). Reserve free `buffer` (`15%` model ctx limit, min `16000` tokens). Preserve `keep.tokens` (default `15000` tokens) exact recent history beside summary.
   - Increase `compaction.keep.tokens` on large-ctx model when exact recent diff / tool output priority over headroom.
   - Route summary gen via `agents.compaction.model` (fallback session model).
2. **Trigger manual compaction**:
   - CLI: `opencode api post /api/session/<sessionID>/compact --data '{"id":"msg_compact_1"}'`
   - SDK: `client.session.compact({ sessionID, id, delivery })` (`delivery`: `"steer"` or `"queue"`).
   - Works when `compaction.auto: false` or history short. Exec at next safe boundary before queued prompt. Duplicate request merge into pending.
   - Explicit `id` for idempotent retry. Reusing `id` with diff payload returns `409 Conflict`.
3. **Track completion & inspect ctx**:
   - HTTP `200` from `/compact` = inbox admission, NOT completion.
   - Watch `session.compaction.started`, `delta`, `ended`, `failed` events (`SessionMessageCompactionRunning` / `Completed` / `Failed`). `delta` chunk != terminal.
   - Call `client.session.context({ sessionID })` (`GET /api/session/:id/context`) verify model-visible turn.

## Compaction Slot Lease Wrapping & Finding 11 Fix (`packages/core/src/session/compaction.ts`)

Compaction requests targeting `:8080` (`deepseek-local`) must run within an active slot lease without dropping in-flight turn slots:

```typescript
// packages/core/src/session/compaction.ts
const existingSlot = localSlotBudgeted ? SessionSlotLease.isActivelyHeld(context.session.id) : undefined
const wasAlreadyHeldByTurn = existingSlot !== undefined && existingSlot >= 0
// resolveCompactionLeaseOrFail reuses active slot or queues/acquires dedicated slot:
const leasedSlot = localSlotBudgeted
  ? (wasAlreadyHeldByTurn ? existingSlot : await resolveCompactionLeaseOrFail(context.session.id, Boolean(context.session.parentID)))
  : undefined
```

| In-Flight Turn State | Compaction Slot Acquisition | Teardown Action (`Effect.ensuring`) | KV Prefix Protection |
| :--- | :--- | :--- | :--- |
| **Slot Already Held by Turn** (`wasAlreadyHeldByTurn === true`) | Reuses `existingSlot` (`0..8`) | **No-op**. Does NOT call `SessionSlotLease.release(sessionID)`. | Turn retains its allocated slot; zero KV loss. |
| **No Active Turn Lease** (`wasAlreadyHeldByTurn === false`) | Acquires queued slot lease via `withSubagentLease` or `acquireCompactionSlotEffect` | Calls `SessionSlotLease.release(sessionID)` only if `!wasAlreadyHeldByTurn && leasedSlot >= 0`. | Slot cleanly returned to Buddy Arena immediately. |

### Exported Compaction Slot & Turnstile Helpers (`compaction.ts`)

- **`extractCompactionSlot(sessionOrInput, requestArg?, optionsArg?, leasedSlotArg?)`** (alias `resolveCompactionRequestSlot`):
  Resolves the active slot ID from `ExtractCompactionSlotInput` wrapper objects (`{ sessionId, request, options, leasedSlot }`), request/options carrier bodies (`options.httpBody.id_slot`, `request.httpBody.id_slot`), or live `SessionSlotLease.isActivelyHeld(sessionID)`.
- **`withCompactionLeaseAndTurnstile(input, use)`**:
  High-order Effect wrapper managing the complete compaction lifecycle. Polls until the target slot/session is free in the turnstile, acquires `SessionSlotLease` only if unheld by an active turn, runs the callback `use(leasedSlot, turnstileKey)` covering prompt preparation AND streaming, and releases the slot in `Effect.ensuring` only if compaction acquired it.
- **`attachSlotToRequest(request, slot)`**:
  Pure immutable helper that injects `id_slot: slot` into `request.http.body` (and top-level `request.httpBody`), ensuring requests targeting `:8080` carry the valid leased slot.
- **`attachSlotToOptions(options, slot)`**:
  Pure immutable helper that injects `id_slot: slot` into `options.httpBody` and `options.requestOptions.httpBody`.

### Zero Unleased `:8080` Invariant
- `:8080` inference routes (`/v1/chat/completions`, `/completion`, `/slots`) require an explicit `id_slot` in `0..8` and Bearer token `--api-key-file /run/deepseek-flash-admin/inference.key`.
- Requests with `id_slot: -1` or missing `id_slot` fail closed with `HTTP 400 Bad Request`. Compaction never issues unleased `:8080` calls.

### Learning 1: Reusing Actively Held Turn Slot vs Releasing in `Effect.ensuring` (`compaction.ts`)
- **Symptom / Issue**: When compaction runs mid-turn while the session already holds a slot (`SessionSlotLease.isActivelyHeld(sessionID)`), acquiring/releasing unconditionally in `Effect.ensuring` prematurely released the parent turn's active slot lease, evicting the active turn's KV cache.
- **Root Cause**: Mid-turn compaction was wrapped in an unconditional `Effect.ensuring(Effect.sync(() => SessionSlotLease.release(context.session.id)))` finalizer without checking whether the slot was already owned by the parent turn.
- **Verified Fix**: Track `wasAlreadyHeldByTurn = true` when reusing an already-held slot (`resolveCompactionLeaseOrFail`), and only call `SessionSlotLease.release` in `Effect.ensuring` when `!wasAlreadyHeldByTurn && leasedSlot !== undefined && leasedSlot >= 0`.
- **Prevention Rule**: Whenever a nested operation (like mid-turn compaction) borrows a session-scoped resource lease that may already be held by an outer turn scope, track ownership (`wasAlreadyHeldByTurn`) so inner finalizers (`Effect.ensuring` / `finally`) never release the outer turn's lease.

### Learning 2: Finding 11 — Nullish Coalescing on `-1` Sentinel & Fail-Closed Compaction Slots
- **Symptom / Issue**: Synchronous `SessionSlotLease.acquire(...)` returns `-1` when all 9 Buddy slots are busy. Code using `const idSlot = leasedSlot ?? 0` evaluated to `-1` and sent `id_slot: -1` to `:8080`, triggering HTTP 400 Bad Request errors.
- **Root Cause**: In JavaScript/TypeScript, `-1` is a valid number, neither `null` nor `undefined`, so `(-1) ?? 0` evaluates to `-1`. Furthermore, calling synchronous `acquire()` during compaction fails under full-arena load instead of queueing behind active turns.
- **Verified Fix**: Exported `COMPACTION_SLOT_UNAVAILABLE_ERROR`, `resolveCompactionLeaseOrFail`, `resolveCompactionSlotOrFail`, and `acquireCompactionSlotEffect`. When slots are contended, subagents queue via `SessionSlotLease.withSubagentLease`, and leads fail closed with `ERR_COMPACTION_SLOT_UNAVAILABLE` rather than defaulting to slot `0` or sending `-1`.
- **Prevention Rule**: Never apply `??` or truthiness checks to functions returning `-1` as an error/busy sentinel; always assert `slot !== undefined && slot >= 0` and use async queued lease helpers for background LLM tasks like compaction.

### Learning 3: Background Compaction Turnstile & Slot Contention (`GPU-019`)
- **Symptom / Issue**: Speculative background compaction (`experimental.background_compaction: true` or summary precomputations) executing concurrently with foreground turns competed for the active slot or compute streams, causing KV cache pollution, compute turnstile starvation, or unleased inference bypass.
- **Root Cause**: `compaction.ts` contained an inverted gate `if (!isDeepSeekLocal && (!settings.precompute || !settings.auto)) return`, causing local GPU sessions (`isDeepSeekLocal === true`) to launch speculative summary fibers EVEN WHEN `precompute: false` was configured! Furthermore, background fibers lacked lifecycle tracking and were not interrupted when foreground turns started.
- **Verified Fix**: Enforce `if (!settings.precompute || !settings.auto) return` universally. Add `activePrecomputeFibers` tracking map, `interruptPrecompute(sessionID)`, and `awaitPrecompute(sessionID)`. In `llm.ts`, call `yield* compaction.interruptPrecompute(sessionID)` before turn execution and during turn finalization so background fibers never compete with active foreground turns or leak slot leases.
- **Prevention Rule**: Speculative or background LLM tasks (compaction, title generation) must always respect disabled precomputation flags (`precompute: false`) across all provider types, execute within `withComputeTurnstile`, and register interrupt/await lifecycle hooks called at every foreground turn boundary.

### Learning 4: Proportional Compaction Threshold Scaling via Live Backend Capacity (`GPU-031`)
- **Symptom / Issue**: Compaction thresholds remained statically anchored to `327,680` tokens (`393,216 - 65,536`), failing to trigger before hardware buffer overflow when the active backend slot was configured with reduced context allocation (e.g. `98,304 / 65,536 / 32,768` tokens), leading to inference failures (`context length exceeded`).
- **Root Cause**: Compaction watermarks were calculated from static configuration (`limit.context`) rather than reconciling with authoritative per-slot capacity (`n_ctx`) reported by the live inference backend (`/slots`, `/props`).
- **Verified Fix**: In `packages/core/src/session/compaction.ts`, compute effective window using `SessionSlotLease.getEffectiveSlotContextLimit(slotId, tier, rawWindow)` and apply tiered compaction watermarks:
  - `window <= 32,768` (32k subagent): `buffer = 8,192` → ceiling = `24,576`
  - `window <= 65,536` (64k slot): `buffer = 12,288` → ceiling = `53,248`
  - `window <= 98,304` (96k Lead): `85%` floor clamp → ceiling = `83,558` (buffer = `14,746`)
  - `window <= 131,072` (128k quantum): `buffer = 32,768` → ceiling = `98,304`
  - `window <= 262,144` (256k tier): `buffer = 38,144` → ceiling = `224,000`
  - `window <= 393,216` (384k Lead): `buffer = 65,536` → ceiling = `327,680`
  Additionally, `compaction.ts:1082` passes `SessionSlotLease.getEffectiveSlotContextLimit` as `limit.context` into LLM summary generation runners, ensuring compaction turns respect active slot allocations.
- **Prevention Rule**: Never evaluate compaction thresholds against static architectural maximums; reconcile with live backend slot capacity (`/slots`, `/props`) and scale compaction watermarks proportionally to active `n_ctx`.

### Learning 5: Holding Slot Lease & Compute Turnstile Across Preparation AND Streaming (`GPU-019`)
- **Symptom / Issue**: Releasing the Buddy slot lease after compaction context preparation and before `summarize()` streaming leaves the actual LLM streaming call running outside the turnstile and slot lease, risking turnstile starvation, KV cache corruption, or unleased inference bypass.
- **Root Cause**: The slot lease was acquired only for the initial turn slice preparation and released prematurely before invoking `llm.stream()`, separating turn context assembly from inference execution.
- **Verified Fix**: Wrap a single unified `withCompactionLeaseAndTurnstile` scope across the entire lifecycle: both context preparation AND the `summarize()` streaming call (`compaction.ts:1010-1090`, `1122-1150`). Resolve `id_slot` flexibly via `extractCompactionSlot`, and attach the resolved slot to outgoing payloads via `attachSlotToRequest(request, leasedSlot)` and `attachSlotToOptions(options, leasedSlot)`.
- **Prevention Rule**: Resource leases and compute turnstiles for multi-stage inference workflows (compaction, synthesis) must encompass both prompt preparation and the full streaming response until final stream termination, using `withCompactionLeaseAndTurnstile` and immutable carrier slot injection (`attachSlotToRequest`, `attachSlotToOptions`).

### Learning 6: Reconciled 32k Subagent Auto-Compaction Trap (`S04`)
- **Symptom / Issue**: Subagents allocated on a `32,768`-token Buddy quantum stall for ~90 seconds in auto-compaction after only `~1,100` tokens of conversation, even when abundant slot headroom remains.
- **Root Cause**: The static system prompt, skill headers, and tool schemas consume `~23,496` tokens (`cache.read`). For a `32,768`-token slot with compaction ceiling `24,576` (`32,768 - 8,192`), `total(estimatePrompt)` crosses `24,576` after just `~1,100` tokens of conversation (`23,496 + 1,100 = 24,596 > 24,576`). Because compaction only summarizes dynamic conversation turns and cannot free static system instructions, auto-compaction fires prematurely on an un-compactable static payload.
- **Verified Fix**: In `packages/core/src/session/compaction.ts`, guard `due()` so `reason: "auto"` compaction does not trigger on a `32k` subagent slot (`ceiling <= 24,576`) when conversation message tokens are `< 4,096` and total prompt tokens are `< 28,672` (`promptTotal < ceiling + 4,096`).
- **Prevention Rule**: Small-context subagent slots with heavy static prefix overhead must never trigger automatic compaction until conversation messages exceed the minimal viable compaction threshold (`4,096` tokens) and total prompt tokens approach slot headroom (`28,672`), preventing ~90s compaction stalls on un-compactable system prompts.

## Local Multi-Slot GPU KV Budgeting (`3 × 384k`)

On local multi-slot setups (`llama-server --parallel 3` across 3 Buddy Blocks):
- **Per-Slot Limit**: Set `limit.context = 393216` (`384k` per slot) in every `opencode.json` (root, agent worktrees). Never set total pool size (`1,179,648`).
- **Watermark Alignment**:
  ```jsonc
  "compaction": {
    "auto": true,
    "buffer": 65536,
    "keep": { "tokens": 12288 }
  }
  ```
  Triggers compaction at `327,680` tokens (`393,216 - 65,536`), leaving `65,536` token safety buffer.
- **Object Schema Invariant (`normalize.ts:374`)**: `"keep"` must be an object (`"keep": { "tokens": 12288 }`). A bare integer (`"keep": 12288`) fails validation and reverts to defaults.
- **Disable Background Compaction**: Keep `experimental.background_compaction = false` on local GPU to prevent speculative background compaction from contending with active slots on compute/memory bandwidth.

## Key Invariants & Gotchas

- **Prompt-cache reuse & incremental checkpoint**: Summary req sends full conversation (`[system prompt][older][recent][summary instructions]`) → provider reuses normal turn prefix cache. Subsequent compactions update prior summary checkpoints incrementally using turns since checkpoint.
- **Lossy summary & tail shorten**: Summary keeps objective, decision, active/done work, blocker, next move, file path. Shortens tool output, replaces attachment bytes with description in kept tail. Old messages stay intact in durable store (`message.list`).
- **Instruction baseline refresh**: Post-compaction, ambient instruction file version becomes baseline. Evicted nested `AGENTS.md` re-injects if directory is read again.
- **Fixed-overhead floor**: Compaction only replaces old conversation turns. Cannot free context taken by huge system prompts, `AGENTS.md`, or MCP/tool schemas.
- **Single overflow retry**: Provider rejects prompt too long → OpenCode compacts & retries **once**. Second consecutive overflow errors out.
- **32k subagent auto-compaction guard (`S04`)**: `compaction.ts` guards `due()` against premature auto-compaction when static system prompts (`~23.5k` tokens) fill small slots, requiring `messages >= 4096` tokens or `promptTotal >= 28672` before auto-compacting.
- **`keep.tokens = 12288` vs `6144` under `--reasoning-preserve`**: `recent-text.ts` accounts for `{ type: "reasoning" }` (`<think>`) + tool output + tool-call boundaries. `#high`/`#max` turns with file reads consume `5K–9K` tokens. `keep.tokens: 6144` retains `~1` turn → risk summarizing active patch context. `keep.tokens: 12288` preserves `2–4` verbatim turns.
- **Historical `reasoning` prefix immutability & SWA ring buffer (`to-llm-message.ts:156-184`)**: Stripping `{ type: "reasoning" }` on `sameModel` error/interrupt turns mutates historical BPE token offsets → invalidates `llama_kv_cache_dsv4` SWA ring buffers (`cache = 0` full wipe). Preserve `{ type: "reasoning" }` on `sameModel` turns; never alter token `#0` system prompt prefix during compaction.
