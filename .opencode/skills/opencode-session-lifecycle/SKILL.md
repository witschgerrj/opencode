---
name: opencode-session-lifecycle
description: "Implement and debug OpenCode V2 session lifecycle operations (`session.create`, `list`, `get`, `active`, `switchAgent`, `switchModel`, `move`, `interrupt`, `background`, `wait`, child-session family settlement, `fork` with `before`, `update` rename/archive, `remove`, `export`/`import`, `stats`) plus general `opencode.json(c)` file precedence and `{env:...}`/`{file:...}` config macros. Use for session execution lifecycle and top-level config layering; use `opencode-inbox-delivery` for prompt queueing and `opencode-messages-parts` for transcript hydration."
---

# OpenCode Session Lifecycle and Config Precedence

Manage OpenCode V2 native session creation, execution control, descendant-tree settlement, forking, archiving, import/export, and the foundational `opencode.json(c)` configuration layering that governs every session.

## Scope and Neighbor Boundaries

- **This skill owns**: `@opencode/client` `session.*` lifecycle operations (`list`, `create`, `get`, `active`, `update`, `switchAgent`, `switchModel`, `move`, `interrupt`, `background`, `wait`, `fork`, `remove`, `export`, `import`, `view`, `environment`, `stats`), parent/child session-family discovery and settlement invariants, and general `opencode.json(c)` file discovery/precedence, `{env:...}`/`{file:...}` substitution macros, `config.get`/`shells`/`update`, and `experimental.*` flags.
- **Use sibling skills for**:
  - `` `opencode-inbox-delivery` `` — `session.prompt` / `synthetic` admission, `steer` vs `queue`, `inbox.update`, and `inbox.cancel`.
  - `` `opencode-messages-parts` `` — paginated `message.list` hydration and part/tool state projection.
  - `` `opencode-event-streams` `` — SSE `event.subscribe` and `session.log` replay.
  - `` `opencode-human-input` `` — pending form/question and permission request replies.
  - `` `opencode-agents` ``, `` `opencode-models` ``, `` `opencode-providers` ``, `` `opencode-policies` `` — feature-specific config schemas and inverted policy precedence.
  - `` `opencode-server-client` `` — daemon discovery, Basic/pairing auth, `location.reload`, and shell/PTY transports.

Read [session lifecycle contracts and config precedence](references/lifecycle-and-config.md) for the complete `@opencode/client` method/HTTP table, SDK unwrap rules, and config merge hierarchy.

## Core Session Lifecycle Workflow

1. **Create, configure, and switch session agent/model explicitly**:
   - Create via `client.session.create({ id?, parentID?, title?, agent?, model?, location?, metadata?, permissions? })` where runtime `model` is `{ providerID, id, variant? }` and `location` is `{ directory }`.
   - Switch active agent via `session.switchAgent({ sessionID, agent })` (`POST /api/session/:id/agent` body `{ agent }`) and model via `session.switchModel({ sessionID, model })` (`POST /api/session/:id/model` body `{ model }`). **Submitting a prompt never switches the session's model, and switching agents never changes the session's model.**
2. **Track activity and settle entire child-session families**:
   - Check live activity via `session.active()` (`GET /api/session/active`, map keyed by active `sessionID`; stale `SessionInfo.time.idle` or old `outcome` does **not** prove current activity or idleness).
   - Enumerate descendants via paginated `session.list({ parentID, cursor })` and verify each child's authoritative `session.get({ sessionID }).parentID` before trusting membership (reject cycles and spoofed IDs, and re-read `session.active()` **after** child discovery).
   - Treat a session family as settled only after **two consecutive identical observations** show zero active family sessions, zero pending forms/permissions, zero pending inbox items, and zero undelivered background subagent wakes.
3. **Stop, fork, archive, or transfer cleanly**:
   - **Stop**: Cancel only owned pending inbox IDs (`inbox.cancel`), call `session.interrupt({ sessionID, resume? })` across active family members, await `session.wait({ sessionID })` (`/api/experimental/session/:id/wait`), and keep watching for background child wakes or newly spawned children before releasing locks.
   - **Fork**: Require idle state and call `session.fork({ sessionID, before? })` (`POST /api/session/:id/fork` body `{ before? }` -> new `SessionInfo` excluding the `before` message boundary).
   - **Rename / Archive**: Call `session.update({ sessionID, title?, archived? })` (`PATCH /api/session/:id` with `archived: true | false`—do not invent `/archive` routes).
   - **Export / Import**: Use `session.export({ sessionID, sanitize? })` and `session.import({ info, messages, location? })`; inspect exported payloads directly rather than assuming `sanitize` strips every domain secret.

## Key Invariants and Gotchas

- **Config `ModelSelector` vs runtime `ModelRef` key mismatch**: `opencode.json(c)` model objects use `{ providerID, model, variant? }` (and root `"model": "provider/model"` drops `#variant`), whereas runtime SDK `ModelRef` uses `{ providerID, id, variant? }`. Never pass one object unchanged to the other!
- **`.opencode/opencode.json(c)` outranks every direct `opencode.json(c)`**: OpenCode merges direct `opencode.json(c)` files farthest-to-closest first, **then** merges `.opencode/opencode.json(c)` files farthest-to-closest—so any `.opencode/opencode.json(c)` overrides every direct `opencode.json(c)` in the directory tree! System config (`/etc/opencode`, `/Library/Application Support/opencode`, `%ProgramData%\opencode`) and macOS MDM (`ai.opencode.managed`) outrank user and project files.
- **Silent empty-string macro expansion**: Missing `{env:VAR}` variables and missing `{file:path}` files expand silently to `""` inside JSON strings.
- **`config.get` vs `config.update` trap**: `client.config.get({ location? })` returns `ConfigEntry[]` (layered config documents, not a single merged object to PATCH back), and `client.config.update({ shell })` (`PATCH /api/experimental/config`) updates **only `shell`**—it is not a general config editor!
- **`session.wait` vs family settlement & observer abort**: `session.wait` waits for **one** session loop only (a parent can go idle while a background subagent runs and later wakes it). Never equate aborting a local HTTP/SSE observer with interrupting native execution.
- **Two-stage `request_synthesis({})` control & zero-KV-bust synthesis transition (`llm.ts:387-425`)**:
  - On autonomous `general` agents (`steps: undefined`), the runtime cannot predict prior to model invocation whether a turn will emit tool calls or generate the final response. Mutating the tool definition array on the final step changes the system/tools prefix at token `~2K`, completely invalidating the KV cache.
  - Calling the zero-argument `request_synthesis({})` tool deterministically signals completion: the session runner transitions the immediately following step to `toolChoice: "none"` and elevates the reasoning budget to synthesis levels (`2048..2560` tokens) while keeping `tools: loaded.tools` 100% byte-identical, achieving a **100% KV prefix hit**.
- **`CONTINUE_AFTER_OUTPUT_LIMIT` runaway loop fix in child sessions (`llm.ts:38-40, 502-545`)**:
  - The default OpenCode continuation prompt (`"Break the remaining work into smaller pieces"`) causes subagents that hit token limits to re-enter multi-turn tool-call loops (observed generating up to 29 redundant DSML turns).
  - Child sessions (`!!parentID`) must receive a single-pass terminal directive: `"Synthesize and complete your final deliverable immediately. Do not call any further tools."` to guarantee clean settlement without looping.
- **60-minute location activity watchdog & long reasoning runs (`location-activity.ts`)**:
  - During extended deep `<think>` reasoning turns (e.g. multi-minute synthesis under `#max`) or long background subagent runs, the server process can trigger an idle location shutdown if activity is not tracked.
  - `location-activity.ts` must call `touch` on incoming streaming deltas and register active child subagents in `owners`, paired with `experimental: { todo: true, location_idle_timeout: false }` in configuration to prevent premature execution termination.
- **Prefix immutability and SWA ring buffer protection (`to-llm-message.ts:156-184`)**:
  - Historical `{ type: "reasoning" }` blocks from `sameModel` turns (including errored or interrupted turns) must remain in the message history. Stripping reasoning parts alters token offsets and wipes `llama_kv_cache_dsv4` SWA ring buffers (`cache = 0`). Token `#0` system prompts must also remain strictly immutable across compactions.
- **Compaction object schema and watermark alignment**:
  - In `3 × 384K` environments (`limit.context = 393216`), configure `"compaction": { "auto": true, "buffer": 65536, "keep": { "tokens": 12288 } }` (`327,680` watermark). Note that `"keep"` must be an object (`keep: { tokens: ... }`); a bare number fails schema validation in `normalize.ts:374` and is silently ignored.
