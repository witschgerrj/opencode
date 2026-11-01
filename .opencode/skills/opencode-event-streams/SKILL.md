---
name: opencode-event-streams
description: "Implement and debug OpenCode V2 SSE subscriptions (`event.subscribe` / `GET /api/event`), subscribe-before-hydrate race closure, experimental durable session-log replay (`session.log` with exclusive numeric `after` sequence), reconnect reconciliation, and safe stream reader teardown. Use for event transport and state synchronization; use `opencode-messages-parts` for message/part schemas and `opencode-inbox-delivery` for prompt submission."
---

# OpenCode Event Streams and Log Replay

Synchronize live OpenCode V2 session state reliably across global SSE streams (`GET /api/event`), experimental per-session durable event logs (`GET /api/experimental/session/:id/log`), and authoritative REST snapshots without race windows or dropped turns.

## Scope and Neighbor Boundaries

- **This skill owns**: `client.event.subscribe` (`GET /api/event`) vs `client.session.log` (`GET /api/experimental/session/:id/log`), the subscribe-before-hydrate race-closure algorithm, SSE framing/keepalive liveness vs session execution state, V2 event family routing keys, sequence/snapshot reconnect recovery, and deadlock-free stream reader teardown.
- **Use sibling skills for**:
  - `` `opencode-messages-parts` `` — `SessionMessageInfo` schemas, part state machines, and `message.list` cursor pagination.
  - `` `opencode-session-lifecycle` `` — `session.active`, `interrupt`, `wait`, and descendant-tree settlement.
  - `` `opencode-inbox-delivery` `` — `session.inbox.*` delivery mode changes and uncertain prompt readback.
  - `` `opencode-human-input` `` — answering `form.*` and `permission.*` requests.
  - `` `opencode-server-client` `` — client construction, authentication headers, and `ClientError` types.

Read [event stream contracts, projection keys, and recovery](references/events-and-replay.md) for the dual-stream comparison, complete V2 event table, and parser/teardown details.

## Core Subscription and Recovery Workflow

1. **Close the startup race with Subscribe-Before-Hydrate** (when using `GET /api/event`):
   - Open `GET /api/event` (`event.subscribe`), await the initial `server.connected` event, and immediately begin pumping incoming events into a bounded in-memory queue.
   - While pumping into the queue, hydrate the authoritative session/family snapshot (`session.get`, `session.active`, `form.list`, `permission.list`, `inbox.list`, and paginated `message.list`).
   - Replay queued events onto the hydrated snapshot (deduplicating by event `id`), then transition to live event application plus periodic/targeted snapshot refreshes (after terminal execution, inbox, form, permission, or compaction transitions).
2. **Use `session.log` properly when durable sequence replay is required**:
   - Call `client.session.log({ sessionID, after?, follow? }, { signal? })` (`GET /api/experimental/session/:sessionID/log`).
   - Pass `after` as the **exclusive numeric aggregate sequence (`durable.seq`)**, never an event `id` string or millisecond timestamp; set `follow: true` to continue streaming live events after catching up (`{ type: "log.synced", aggregateID, seq? }`).
   - Validate `durable.aggregateID`, deduplicate `seq`, and advance your persisted sequence checkpoint **only after** applying the state update. Note that ephemeral `*.delta` events omit `durable` metadata (`started`/`ended` events and snapshots provide durable state).
3. **Separate transport liveness from session execution**:
   - Reset SSE stall timers on every chunk—including `: keepalive` comment frames, which count as transport liveness without producing domain events.
   - Disconnecting or aborting an SSE stream terminates **observation only**; it never cancels, fails, or completes native execution on the OpenCode server.
4. **Tear down stream readers without deadlocks**:
   - On cleanup, cancel the active stream reader (`await reader.cancel()`) **before** awaiting the pump promise, abort the `AbortController`, and clear liveness/reconnect timers so pending reads never hang indefinitely.

## Key Invariants and Gotchas

- **Global `/api/event` has NO `Last-Event-ID` or cursor replay**: `EventSubscribeInput` takes only `{ types? }`. Dropped global SSE connections **must** re-run fresh snapshot reconciliation (or replay via `session.log`'s numeric `after` sequence)—never assume missed `/api/event` deltas will replay on reconnect!
- **Generated vs public `event.subscribe` signature difference**: Generated client methods take `event.subscribe({ types? }, { signal?, onActivity? })` (two arguments), whereas `@opencode/client`'s shared public wrapper accepts `{ types?, signal?, onActivity? }` in a single options object (and retains `server.connected` even when `types` filters are active). Check which client surface is imported.
- **`log.synced` != execution complete**: Receiving `log.synced` on `session.log` only means historical log replay caught up to the live tail—the session may still be actively running tools or waiting on forms.
- **Event payload key asymmetries**:
  - `form.created` nests the form object at `data.form` (including `sessionID`), while `form.replied` / `form.cancelled` key by `data.sessionID` and `data.id`.
  - `permission.replied` identifies the request at **`data.requestID`** (and `data.reply`), **not** `data.id`!
  - `session.created` is only a candidate child hint—always fetch `session.get({ sessionID })` and verify `parentID` before admitting a child into an authorized session family.
  - V2 does **not** emit V1 `message.part.*` events, and `session.message.content.updated` can appear in `session.log` even when absent from global `EventSubscribeInput`.
