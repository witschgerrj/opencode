---
name: opencode-messages-parts
description: "Hydrate, project, and persist OpenCode V2 session transcripts (`message.list` pagination with `order`, `cursor`, and `type`, terminal empty-page rules, `SessionMessageInfo` variants, `text`/`reasoning`/`tool` part schemas, millisecond tool timers, live-tail reconciliation, and `experimental.media.get` output media retrieval). Use for reading transcripts and tool output media; use `opencode-attachments` for prompt attachment inputs and `opencode-event-streams` for SSE transport."
---

# OpenCode Messages, Parts, and Output Media

Hydrate paginated OpenCode V2 transcripts, project typed message/part states and millisecond tool execution timestamps, reconcile live streaming tails against durable reads, and safely download tool-produced output media.

## Scope and Neighbor Boundaries

- **This skill owns**: `client.message.list` cursor pagination and `type` filtering, `client.session.message.get`, `SessionMessageInfo` union variants (`user`, `assistant`, `compaction`, `synthetic`, `system`, `skill`, `shell`, `agent-switched`, `model-switched`, `location-switched`, `idle`), `text`/`reasoning`/`tool` content part schemas, tool `state.status` lifecycle & millisecond timestamps (`created`, `ran`, `completed`), live-tail vs snapshot projection rules, and output media download (`experimental.media.get` / `media:<64-hex>`).
- **Use sibling skills for**:
  - `` `opencode-attachments` `` — prompt/command attachment input syntax (`file:`/`data:`), magic-byte checks, 20 MiB limits, and `media.image` normalization.
  - `` `opencode-event-streams` `` — SSE subscription, subscribe-before-hydrate race closure, and `session.log` replay.
  - `` `opencode-compaction` `` — active model-visible `session.context` versus full historical `message.list`.
  - `` `opencode-snapshots` `` — `snapshot.start/end/files` Git code snapshot hashes and turn rollback.

Read [transcript schemas, pagination, and output media contracts](references/transcript-and-media-contracts.md) for exact TypeScript shapes, projection keys, and media security guards.

## Core Hydration and Projection Workflow

1. **Page `message.list` to true cursor termination**:
   - Call `client.message.list({ sessionID, limit?, order?, cursor?, type? })` (`GET /api/session/:sessionID/message` -> `{ data: SessionMessageInfo[], cursor: { previous?, next? } }`).
   - **Terminal page rule**: Continue following `cursor.next` until `data.length === 0` **or** `cursor.next` is absent—**never stop merely because a page returned fewer items than `limit`**!
   - Guard against repeated cursors, deduplicate message IDs across pages, enforce explicit memory/message bounds for UI views, and reverse descending pages when hydrating recent-first slices.
2. **Decode `SessionMessageInfo` variants and tool states accurately**:
   - `SessionMessageUser` has top-level `text`, optional `files`, `agents`, `skills`, `metadata`, and `time.created` (not `content: [{ type: "text" }]`).
   - `SessionMessageAssistant.content` holds `{ type: "text" }`, `{ type: "reasoning" }`, and `{ type: "tool", id, name, state, time, executed?, native? }`, plus assistant-level `time` (`created`, `streamed?`, `completed?`), `finish`, `rawFinish`, structured `error`, `tokens`, `cost`, and `snapshot`.
   - Handle all four `tool.state.status` phases: `"streaming"` (`input` is an unfinished raw `string`—do **not** parse as completed JSON arguments!), `"running"` (structured `input` map + `metadata`), `"completed"` (`input` map + `content: ToolContent[]`), and `"error"` (structured `error` + optional `content`).
3. **Reconcile live streaming tails with durable snapshots**:
   - Key text and reasoning fragments by `(sessionID, assistantMessageID, kind, ordinal)` (ordinals are per-kind, distinct from tool `id`).
   - Treat `ended` text as an **authoritative replacement** (not another delta to append), ignore late deltas after `ended`, and never reopen a `completed` or `error` tool on late `called` or `progress` events (though a late `called` event may backfill a missing `ran` timestamp).
4. **Retrieve tool output media safely**:
   - Resolve `{ type: "file", uri, mime, name? }` from an authorized session/message/tool snapshot first.
   - Fetch `media:<64-lowercase-hex>` blobs via `client.experimental.media.get({ hash })` (`GET /api/experimental/media/:hash` -> `Uint8Array`) or decode bounded canonical Base64 `data:` URIs with sanitized `Content-Disposition` filenames.

## Key Invariants and Gotchas

- **No generic message or part mutation API**: OpenCode V2 exposes `message.list` and `session.message.get` as read-only endpoints; do **not** invent V1 `message.part.updated` or standalone message edit/delete REST endpoints.
- **True tool execution duration uses `time.ran`**: Native tool timestamps (`created`, `ran?`, `completed?`) are epoch milliseconds. Elapsed execution time runs from `ran` to `completed` (or `now` while running)—message creation, argument streaming start, or UI mount time is **not** execution start!
- **Truncated UI views != full session history**: Bounding a UI view to the latest *N* messages does not mean older turns vanished or that descendant sessions have settled.
- **Assistant `snapshot` is Git state, not media**: `assistant.snapshot` (`{ start, end, files }`) records step code-snapshot hashes for `` `opencode-snapshots` `` undo/revert, not downloadable image attachments.
- **Never proxy arbitrary tool/client URLs as media downloads**: Only dereference verified `media:<64-hex>` hashes via `experimental.media.get` or validated inline `data:` URIs; never fetch `http://`, `https://`, or raw host `file://` URIs supplied in tool output or browser requests.
