---
name: opencode-session-lifecycle
description: Manage native session lifecycle tree settlement fork archive import config
  precedence
---

# OpenCode Session Lifecycle and Config Precedence

Manage OpenCode V2 native session creation, exec control, descendant-tree settlement, forking, archiving, import/export, and foundational `opencode.json(c)` config layering governing every session.

## Scope and Neighbor Boundaries

- **This skill owns**: `@opencode/client` `session.*` lifecycle operations (`list`, `create`, `get`, `active`, `update`, `switchAgent`, `switchModel`, `move`, `interrupt`, `background`, `wait`, `fork`, `remove`, `export`, `import`, `view`, `environment`, `stats`), parent/child session-family discovery and settlement invariants, general `opencode.json(c)` file discovery/precedence, `{env:...}`/`{file:...}` substitution macros, `config.get`/`shells`/`update`, and `experimental.*` flags.
- **Sibling skills**:
  - `opencode-inbox-delivery` — `session.prompt` / `synthetic` admission, `steer` vs `queue`, `inbox.update`, `inbox.cancel`.
  - `opencode-messages-parts` — paginated `message.list` hydration, part/tool state projection.
  - `opencode-event-streams` — SSE `event.subscribe`, `session.log` replay.
  - `opencode-human-input` — pending form/question, permission req replies.
  - `opencode-agents`, `opencode-models`, `opencode-providers`, `opencode-policies` — feature-specific config schemas, inverted policy precedence.
  - `opencode-server-client` — daemon discovery, Basic/pairing auth, `location.reload`, shell/PTY transports.

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

## Key Invariants and Gotchas

- **Config `ModelSelector` vs runtime `ModelRef` key mismatch**: `opencode.json(c)` model objects use `{ providerID, model, variant? }` (root `"model": "provider/model"` drops `#variant`). Runtime SDK `ModelRef` uses `{ providerID, id, variant? }`. Never pass object unchanged across boundaries.
- **`.opencode/opencode.json(c)` outranks direct `opencode.json(c)`**: OpenCode merges direct `opencode.json(c)` farthest-to-closest first, then merges `.opencode/opencode.json(c)` farthest-to-closest. `.opencode/opencode.json(c)` overrides every direct `opencode.json(c)` in dir tree. System config (`/etc/opencode`, `/Library/Application Support/opencode`, `%ProgramData%\opencode`) and macOS MDM (`ai.opencode.managed`) outrank user/project files.
- **Silent empty-string macro expansion**: Missing `{env:VAR}` and missing `{file:path}` expand silently to `""` inside JSON strings.
- **`config.get` vs `config.update` trap**: `client.config.get({ location? })` returns `ConfigEntry[]` (layered docs, not single merged object to PATCH). `client.config.update({ shell })` (`PATCH /api/experimental/config`) updates **only `shell`**; not general config editor.
- **`session.wait` vs family settlement & observer abort**: `session.wait` waits for single session loop only (parent idle while background subagent runs, wakes parent later). Local HTTP/SSE observer abort != native execution interrupt.
- **Two-stage `request_synthesis({})` control & zero-KV-bust synthesis transition (`llm.ts:387-425`)**:
  - Autonomous `general` agents (`steps: undefined`): runtime cannot predict prior to model invocation whether turn emits tool calls or final res. Mutating tool definition array on final step changes system/tools prefix at token `~2K`, bust KV cache.
  - Zero-arg `request_synthesis({})` tool call deterministically signals completion: session runner transitions next step to `toolChoice: "none"`, elevates reasoning budget to `2048..2560` tokens, keeps `tools: loaded.tools` 100% byte-identical → 100% KV prefix hit.
- **`CONTINUE_AFTER_OUTPUT_LIMIT` runaway loop fix in child sessions (`llm.ts:38-40, 502-545`)**:
  - Default OpenCode continuation prompt (`"Break the remaining work into smaller pieces"`) triggers multi-turn tool-call loops in token-limited subagents (observed up to 29 redundant DSML turns).
  - Child sessions (`!!parentID`) req single-pass terminal directive: `"Synthesize and complete your final deliverable immediately. Do not call any further tools."` → guaranteed clean settlement.
- **60-minute location activity watchdog & long reasoning runs (`location-activity.ts`)**:
  - Long deep `<think>` turns (multi-minute synthesis under `#max`) or long background subagent runs trigger idle location shutdown if untracked.
  - `location-activity.ts` must call `touch` on incoming streaming deltas, register active child subagents in `owners`, pair with `experimental: { todo: true, location_idle_timeout: false }` in config.
- **Prefix immutability and SWA ring buffer protection (`to-llm-message.ts:156-184`)**:
  - Historical `{ type: "reasoning" }` blocks from `sameModel` turns (including err/interrupted) must persist in message history. Stripping reasoning parts alters token offsets, wipes `llama_kv_cache_dsv4` SWA ring buffers (`cache = 0`). Token `#0` system prompts strictly immutable across compactions.
- **Sticky Parent-to-Child Buddy Block Affinity in Slot Leasing (`getPreferredBuddyBlock` in `packages/core/src/session/slot-lease.ts` / `packages/opencode/src/session/slot-lease.ts`)**:
  - 9-quantum dual-tier Buddy Arena (`9Q = 1,179,648` unified pure-`FP16` MLA+DSA tok) partitions slots across 3 Buddy Blocks: Block 0 (`0, 1, 2`), Block 1 (`3, 4, 5`), Block 2 (`6, 7, 8`).
  - Lead agents (`general`) default to `256k` (`2Q = 262,144` tok) on slots `0, 3, 6` (sub-slots `0, 1`), leaving tail sibling slots `2, 5, 8` (`sib = 2`) 100% immune to Lead ctx expansion.
  - On subagent spawn, `getPreferredBuddyBlock` maps parent Lead slot to owning block (`block = Math.floor(parentSlot / 3)`) and prioritizes immune tail sibling (`slot = 3 * block + 2` → `2, 5, 8`) before fallback `[2, 5, 8, 1, 4, 7]`.
- **Compaction object schema and watermark alignment**:
  - `3 × 384K` env (`limit.context = 393216`): configure `"compaction": { "auto": true, "buffer": 65536, "keep": { "tokens": 12288 } }` (`327,680` watermark). `"keep"` must be object (`keep: { tokens: ... }`); bare number fails validation in `normalize.ts:374`, silently ignored.
