---
name: opencode-session-lifecycle
description: Manage native session lifecycle tree settlement fork archive config precedence buddy leases and unleased call prevention
---

# OpenCode Session Lifecycle and Config Precedence

Manage OpenCode V2 native session creation, exec control, descendant-tree settlement, forking, archiving, import/export, and foundational `opencode.json(c)` config layering governing every session.

## Scope and Neighbor Boundaries

- **This skill owns**: `@opencode/client` `session.*` lifecycle operations (`list`, `create`, `get`, `active`, `update`, `switchAgent`, `switchModel`, `move`, `interrupt`, `background`, `wait`, `fork`, `remove`, `export`, `import`, `view`, `environment`, `stats`), parent/child session-family discovery, descendant settlement, Buddy slot leases, `Session.remove` child vs root release, general `opencode.json(c)` discovery/precedence, `{env:...}`/`{file:...}` macros, `config.get`/`shells`/`update`, and `experimental.*` flags.
- **Sibling skills**:
  - `opencode-agents` — agent profiles, subagent delegation, Buddy slot preference profiles.
  - `opencode-compaction` — context compaction budgets, slot lease wrapping during compaction.
  - `opencode-tools` — cgroup leaf isolation, environment scrubbing, GPU tools.
  - `opencode-inbox-delivery` — `session.prompt` / `synthetic` admission, `steer` vs `queue`.
  - `opencode-messages-parts` — paginated `message.list` hydration, part/tool state projection.
  - `opencode-event-streams` — SSE `event.subscribe`, `session.log` replay.
  - `opencode-human-input` — pending form/question, permission req replies.

Read `references/lifecycle-and-config.md` for complete `@opencode/client` method/HTTP table, SDK unwrap rules, config merge hierarchy.

## Core Session Lifecycle Workflow

1. **Create, configure, switch session agent/model explicitly**:
   - Create: `client.session.create({ id?, parentID?, title?, agent?, model?, location?, metadata?, permissions? })` where runtime `model` is `{ providerID, id, variant? }`, `location` is `{ directory }`.
   - Switch active agent: `session.switchAgent({ sessionID, agent })` (`POST /api/session/:id/agent` body `{ agent }`).
   - Switch model: `session.switchModel({ sessionID, model })` (`POST /api/session/:id/model` body `{ model }`). Submitting prompt never switches model; switching agents never changes model.
2. **Track activity and settle child-session families**:
   - Check live activity: `session.active()` (`GET /api/session/active`, map keyed by active `sessionID`; stale `SessionInfo.time.idle` or old `outcome` does not prove activity/idleness).
   - Enumerate descendants: paginated `session.list({ parentID, cursor })`. Verify authoritative `session.get({ sessionID }).parentID` before trusting membership (reject cycles, spoofed IDs; re-read `session.active()` after child discovery).
   - Settle family: require **two consecutive identical observations** showing 0 active family sessions, 0 pending forms/permissions, 0 pending inbox items, 0 undelivered background subagent wakes.
3. **Stop, fork, archive, transfer cleanly**:
   - **Stop**: Cancel owned pending inbox IDs (`inbox.cancel`) → call `session.interrupt({ sessionID, resume? })` across active family → await `session.wait({ sessionID })` (`/api/experimental/session/:id/wait`) → watch background child wakes / new children before releasing locks.
   - **Fork**: Require idle state → `session.fork({ sessionID, before? })` (`POST /api/session/:id/fork` body `{ before? }` → new `SessionInfo` excluding `before` message boundary).
   - **Rename / Archive**: `session.update({ sessionID, title?, archived? })` (`PATCH /api/session/:id` with `archived: true | false`; no `/archive` routes).
   - **Export / Import**: `session.export({ sessionID, sanitize? })`, `session.import({ info, messages, location? })`. Inspect exported payloads directly; `sanitize` not guaranteed to strip all domain secrets.

## Child vs Root Session Teardown (`Session.remove` in `packages/core/src/session.ts`)

`Session.remove` executes a complete deterministic resource teardown cascade and branches on `info.parentID` to prevent destroying parent Lead conversation leases:

| Teardown Stage | Check / Target | Implementation / Function Called | Behavior / Invariant |
| :--- | :--- | :--- | :--- |
| **1. Background Shells** | Owned shells (`shell.list({ sessionID })`) | `Shell.Service` `shell.stop(s.id)` | Terminates all active/background shell processes owned by `sessionID` before removing DB rows. |
| **2a. Child Slot Lease** | `if (info.parentID)` | `SessionSlotLease.releaseSubagentSession(sessionID, { purge: true })` | Releases child's `128k` quantum, clears sticky slot mapping, wakes queued subagents. **Leaves parent Lead's `384k` conversation lease 100% untouched**. |
| **2b. Root Slot Lease** | `else` (`!info.parentID`) | `SessionSlotLease.releaseConversation(boundConvId, sessionID)` | Releases root conversation `384k` block lease across all child associations. |
| **3. Epoch Prefix & Turn Reminder SQLite Rows** | `session_epoch_prefix`, `session_turn_reminder` | `InstructionState.clear(sessionID)` + `DELETE FROM session_v2` | Cascades deletion of durable instruction epoch baselines, turn reminder snapshots, messages, parts, and session rows. |
| **4. Active Schedules (`ScheduleTool`)** | `session.deleted` event + lazy check in `schedule.ts` | `cancelSchedulesForSession(sessionID)` (`packages/core/src/tool/plugin/schedule.ts`) | Eagerly cancels all active one-shot timers and recurring cron jobs targeting the deleted `sessionID` on `session.deleted`, and lazily guards `list` / `fireSchedule` if `sessions.get(entry.sessionID)` is missing. |
| **5. Propose → Approve Cross-Conversation Deletion** | `send_message({ action: "delete" })` | `executeDelete` (`packages/core/src/tool/plugin/send-message.ts`) | Enforces owner isolation (`aquanoxOwnerUserId`), skips current/active/stopping/revert/pending-inbox conversations, requests single-use `conversation_delete_proposal` approval (`save` omitted), and removes descendant subagent sessions before root sessions. |

## Zero Unleased `:8080` Inference Policy

To eliminate cross-slot KV cache corruption and unauthorized inference bypass:
1. **Title Derivation (`packages/core/src/session/title.ts`)**:
   - When `model.ref.providerID === "deepseek-local"`, derives title locally via `deriveFallbackTitle(text)` from conversation/message text.
   - Never sends unleased `id_slot: -1` requests to `:8080` while root turn is active.
2. **Context Window Discovery (`packages/core/src/tool/plugin/subagent.ts`)**:
   - `resolveLlamaSlotContextWindow(input)` requires explicit `idSlot` in `0..8`.
   - If `idSlot === undefined || idSlot < 0 || idSlot > 8`, immediately returns `fallbackContextWindow` (`131072`) without querying `:8080/slots`.
3. **Server-Side Enforcement**:
   - `llama-server` rejects completion requests omitting `id_slot` or with `id_slot < 0` (`HTTP 400 Bad Request`).
   - All `/v1/*` inference endpoints require Bearer auth (`--api-key-file /run/deepseek-flash-admin/inference.key`).
4. **Fail-Closed Lease Validation & Async Queuing (`Finding 11`)**:
   - *Symptom / Issue*: Synchronous `SessionSlotLease.acquire(...)` returns `-1` when all 9 Buddy slots are busy. Expressions like `const idSlot = leasedSlot ?? 0` evaluated to `-1` and forwarded `id_slot: -1` to `:8080`. Additionally, releasing unconditionally in `Effect.ensuring` during mid-turn compaction prematurely dropped the outer turn's lease.
   - *Root Cause*: In JavaScript/TypeScript, `-1` is neither `null` nor `undefined`, so `(-1) ?? 0` evaluates to `-1`. Furthermore, synchronous `acquire()` during background tasks fails under full-arena load, and inner finalizers that do not track outer turn ownership release the outer turn's lease prematurely.
   - *Verified Fix*: Use `resolveCompactionLeaseOrFail` / `resolveCompactionSlotOrFail` / `acquireCompactionSlotEffect` with asynchronous queued slot acquisition (`withLeadLease` / `withSubagentLease`) + Plane-2 `withComputeTurnstile`. Track `wasAlreadyHeldByTurn = true` when reusing an actively held turn slot (`SessionSlotLease.isActivelyHeld`), and only call `SessionSlotLease.release` in finalizers when `!wasAlreadyHeldByTurn && leasedSlot !== undefined && leasedSlot >= 0`. Hold a unified slot lease + compute turnstile scope across both context preparation AND `summarize()` streaming (`GPU-019`).
   - *Prevention Rule*: Never apply `??` or truthiness checks to functions returning `-1` as an error/busy sentinel. When a nested operation borrows a session-scoped resource lease that may already be held by an outer turn scope, track ownership (`wasAlreadyHeldByTurn`) so inner finalizers (`Effect.ensuring` / `finally`) never release the outer turn's lease, and ensure turnstiles span both preparation and response streaming.
5. **Admin IPC Directory Group Inheritance (`setgid 2750`)**:
   - `/run/deepseek-flash-admin` must be provisioned with setgid `chmod 2750 rjwits:aquanox-broker` (via `/etc/tmpfiles.d/aquanox-gpu-broker.conf`) so all dynamically created inference keys (`inference.key`) and admin sockets (`admin.sock`) inherit group ownership, enabling unprivileged broker and CLI processes to authenticate without ambient root privilege.

6. **Live Backend Slot Capacity Reconciliation (`GPU-031`)**:
   - `SessionSlotLease.reconcileBackendSlotCapacities(baseUrl?, options?)` queries `GET /slots` (1500ms timeout) or system backend config to read active per-slot `n_ctx` allocations.
   - `SessionSlotLease.getEffectiveSlotContextLimit(slotId?, tier?, configuredContext?)` clamps slot limits against `backendLeadBlockTokens`, `backendQuantumTokens`, and per-slot `backendSlotCapacities[s]`.
   - `SessionSlotLease.getResourceSnapshot()` flags `capacityMismatch: true` whenever `configuredModelContextTokens !== backendLeadBlockTokens`, surfacing a capacity reconciliation warning in `inspect_system_resources`.
   - `model-request.ts` dynamically clamps `maxOutputForWindow` based on `effectiveContext`: `<= 32,768` caps output at `8,192`; `<= 65,536` caps output at `16,384`, calculating available room as `effectiveContext - inputTokens.measured - estimated` to eliminate KV buffer overflows.
   - Downstream compaction ceilings scale down proportionally (e.g. `98,304` lead with compaction at `81,920`, `32,768` subagent with compaction at `24,576`).

## Sticky Buddy Block Affinity & Allocation (`slot-lease.ts`)

- **Buddy Blocks**: Block 0 (`0..2`), Block 1 (`3..5`), Block 2 (`6..8`). Total 9 quanta (`1,179,648` tokens).
- **Preference Order**: `SUBAGENT_SLOT_PREFERENCE = [2, 5, 8, 1, 4, 7, 0, 3, 6] as const`.
- **Packing Invariant**: `tryAcquireSubagentSync` fills open slots in active `split_128k` blocks before splitting an `"idle"` block.
  - **Profile A (`2L + 3S = 9Q`)**: Leads in Blocks 0 and 1; 3 subagents pack into `8, 7, 6` in Block 2.
  - **Single-Lead Packing**: Lead in Block 0; 3 subagents pack into `5, 4, 3` in Block 1; Block 2 stays `"idle"` for a 2nd Lead.

## Key Invariants and Gotchas

- **Config `ModelSelector` vs runtime `ModelRef` key mismatch**: `opencode.json(c)` model objects use `{ providerID, model, variant? }` (root `"model": "provider/model"` drops `#variant`). Runtime SDK `ModelRef` uses `{ providerID, id, variant? }`. Never pass object unchanged across boundaries.
- **`.opencode/opencode.json(c)` outranks direct `opencode.json(c)`**: OpenCode merges direct `opencode.json(c)` farthest-to-closest first, then merges `.opencode/opencode.json(c)` farthest-to-closest. `.opencode/opencode.json(c)` overrides every direct `opencode.json(c)` in dir tree. System config (`/etc/opencode`, `/Library/Application Support/opencode`, `%ProgramData%\opencode`) and macOS MDM (`ai.opencode.managed`) outrank user/project files.
- **Silent empty-string macro expansion**: Missing `{env:VAR}` and missing `{file:path}` expand silently to `""` inside JSON strings.
- **`config.get` vs `config.update` trap**: `client.config.get({ location? })` returns `ConfigEntry[]` (layered docs, not single merged object to PATCH). `client.config.update({ shell })` (`PATCH /api/experimental/config`) updates **only `shell`**; not general config editor.
- **`session.wait` vs family settlement & observer abort**: `session.wait` waits for single session loop only (parent idle while background subagent runs, wakes parent later). Local HTTP/SSE observer abort != native execution interrupt.
- **Two-stage `request_synthesis({})` control, `computeCausalReasoningBudget`, & `withComputeTurnstile` (`llm.ts:223-350`, `slot-lease.ts:973-997`)**:
  - Autonomous `general` agents (`steps: undefined`): mutating tool definition array on final step busts KV prefix cache at token `~2K`. Zero-arg `request_synthesis({})` transitions next step to `toolChoice: "none"` while keeping `tools: loaded.tools` 100% byte-identical → 100% KV prefix hit.
  - `computeCausalReasoningBudget` dynamically assigns `reasoning_budget_tokens` per step: **Tier 1** (`1024..2048` turn entry / error diagnosis), **Tier 2** (`512` multi-file fan-in `>=3` tools or `>=2` exploratory steps), **Tier 3** (`1024` clean mutating continuation / synthesis), **Tier 4** (`256` single exploratory read/grep/glob), with `think_temp: 0.85` on error/diagnostic vs `0.55` normal (`think_min_p: 0.01`).
  - **Live Reconciled Reasoning Budget Cap (`capLiveReconciledReasoningBudget` / `S05`)**: Under 3-stream concurrent decode (`~9.4–12.5 t/s` per slot), an uncapped `2048` reasoning budget causes sessions to spend `130–170s` drafting rough essays inside `<think>`. Capping live reconciled reasoning budgets (`512` Lead turn-entry, `256` Lead continuation, `384` Subagent) keeps reasoning focused and prevents 200s+ turn timeouts.
  - Plane-2 Stride-Aligned Compute Turnstile (`SessionSlotLease.withComputeTurnstile` around `steps.attempt` in `runner/index.ts`) caps concurrent active forward passes at `K = 3` default (`MAX_ACTIVE_COMPUTE_STREAMS = 4`) across the 9 persistent Plane-1 KV slots, using modulo-3 residue & `128k_split` block affinity (`15s` / 2-wave starvation guard).
- **Dual-Home Config Synchronization (`S05`)**: Always sync config updates (`opencode.json`) to `/var/lib/aquanox-runner/home/.config/opencode/opencode.json` in addition to `/home/rjwits/.config/opencode/opencode.json` because `aquanox-opencode.service` runs with `HOME=/var/lib/aquanox-runner/home`.
- **32k Subagent Auto-Compaction Guard (`S04`)**: `due()` in `compaction.ts` guards against auto-compaction on `32k` subagent slots when dynamic conversation messages are `< 4,096` tokens and total prompt tokens are `< 28,672`, preventing ~90s compaction stalls on un-compactable static system prompts (`~23.5k` tokens).
- **`CONTINUE_AFTER_OUTPUT_LIMIT` runaway loop fix in child sessions (`llm.ts:38-40, 502-545`)**:
  - Default OpenCode continuation prompt (`"Break the remaining work into smaller pieces"`) triggers multi-turn tool-call loops in token-limited subagents.
  - Child sessions (`!!parentID`) req single-pass terminal directive: `"Synthesize and complete your final deliverable immediately. Do not call any further tools."` → guaranteed clean settlement.
- **60-minute location activity watchdog & long reasoning runs (`location-activity.ts`)**:
  - Long deep `<think>` turns (multi-minute synthesis under `#max`) or long background subagent runs trigger idle location shutdown if untracked.
  - `location-activity.ts` must call `touch` on incoming streaming deltas, register active child subagents in `owners`, pair with `experimental: { todo: true, location_idle_timeout: false }` in config.
- **Prefix immutability and SWA ring buffer protection (`to-llm-message.ts:156-184`)**:
  - Historical `{ type: "reasoning" }` blocks from `sameModel` turns (including err/interrupted) must persist in message history. Stripping reasoning parts alters token offsets, wipes `llama_kv_cache_dsv4` SWA ring buffers (`cache = 0`). Token `#0` system prompts strictly immutable across compactions.
