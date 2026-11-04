---
name: opencode-event-streams
description: Implement and debug OpenCode V2 SSE subscriptions, subscribe-before-hydrate
  races, durable session-log replay, reconnect reconciliation, and safe reader teardown.
---

# OpenCode Event Streams and Log Replay

Sync live OpenCode V2 session state via global SSE (`GET /api/event`), experimental durable event logs (`GET /api/experimental/session/:id/log`), and REST snapshots without race windows or dropped turns.

## Scope and Boundaries

- **This skill owns**: `client.event.subscribe` (`GET /api/event`) vs `client.session.log` (`GET /api/experimental/session/:id/log`), subscribe-before-hydrate race closure, SSE framing/keepalive liveness vs execution state, V2 event routing keys, sequence/snapshot reconnect recovery, deadlock-free reader teardown.
- **Sibling skills**:
  - `opencode-messages-parts` — `SessionMessageInfo` schemas, part state machines, `message.list` cursor pagination.
  - `opencode-session-lifecycle` — `session.active`, `interrupt`, `wait`, descendant settlement.
  - `opencode-inbox-delivery` — `session.inbox.*` delivery mode changes, uncertain prompt readback.
  - `opencode-human-input` — answer `form.*` and `permission.*` reqs.
  - `opencode-server-client` — client construction, auth headers, `ClientError` types.

Read `references/events-and-replay.md` for dual-stream comparison, V2 event table, parser/teardown details.

## Core Subscription and Recovery Workflow

1. **Close startup race via Subscribe-Before-Hydrate** (`GET /api/event`):
   - Open `GET /api/event` (`event.subscribe`), await `server.connected`, immediately pump incoming events into bounded in-memory queue.
   - Concurrently hydrate snapshot: `session.get`, `session.active`, `form.list`, `permission.list`, `inbox.list`, paginated `message.list`.
   - Replay queued events onto snapshot (dedup by event `id`) → transition to live event stream + periodic/targeted refreshes (after terminal execution, inbox, form, permission, compaction transitions).
2. **Durable sequence replay via `session.log`**:
   - Call `client.session.log({ sessionID, after?, follow? }, { signal? })` (`GET /api/experimental/session/:sessionID/log`).
   - `after` must be **exclusive numeric aggregate sequence (`durable.seq`)**—never event `id` string or millisecond timestamp; set `follow: true` for live stream catch-up (`{ type: "log.synced", aggregateID, seq? }`).
   - Validate `durable.aggregateID`, dedup `seq`, advance checkpoint **only after** applying state update. Ephemeral `*.delta` events omit `durable` metadata (`started`/`ended` events and snapshots provide durable state).
3. **Transport liveness vs session execution**:
   - Reset SSE stall timers on every chunk, including `: keepalive` frames (counts as transport liveness, no domain event).
   - Abort/disconnect terminates **observation only**; never cancels or fails server execution.
4. **Deadlock-free reader teardown**:
   - Cancel active stream reader (`await reader.cancel()`) **before** awaiting pump promise.
   - Abort `AbortController`, clear liveness/reconnect timers → prevent hang on pending reads.

## Key Invariants and Gotchas

- **No `Last-Event-ID` on global `/api/event`**: `EventSubscribeInput` accepts only `{ types? }`. Dropped connection → run fresh snapshot reconciliation (or replay via `session.log` with numeric `after` seq). Missed deltas never replay on `/api/event` reconnect.
- **Generated vs public `event.subscribe` signatures**:
  - Generated: `event.subscribe({ types? }, { signal?, onActivity? })` (2 args).
  - `@opencode/client` wrapper: `{ types?, signal?, onActivity? }` (1 options arg; retains `server.connected` even when filtered).
- **`log.synced` != execution complete**: Indicates historical log caught up to live tail; session may still execute tools or await forms.
- **Event payload key asymmetries**:
  - `form.created` nests form object at `data.form` (contains `sessionID`).
  - `form.replied` / `form.cancelled` use `data.sessionID` and `data.id`.
  - `permission.replied` identifies req at **`data.requestID`** (and `data.reply`), **not** `data.id`.
  - `session.created` = candidate child hint only. Fetch `session.get({ sessionID })` and verify `parentID` before admitting to session family.
  - V2 omits V1 `message.part.*` events; `session.message.content.updated` may appear in `session.log` even if absent from global `EventSubscribeInput`.
