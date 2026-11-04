---
name: opencode-messages-parts
description: Hydrate, project, and persist OpenCode V2 session transcripts, message
  parts, tool states, and output media retrieval.
---

# OpenCode Messages, Parts, and Output Media

Hydrate paginated OpenCode V2 transcripts, project typed message/part states, track ms tool exec timestamps, reconcile live streaming tails vs durable reads, download tool output media safely.

## Scope & Boundaries

- **Owns**: `client.message.list` cursor pagination + `type` filtering, `client.session.message.get`, `SessionMessageInfo` union (`user`, `assistant`, `compaction`, `synthetic`, `system`, `skill`, `shell`, `agent-switched`, `model-switched`, `location-switched`, `idle`), `text`/`reasoning`/`tool` content part schemas, tool `state.status` lifecycle + ms timestamps (`created`, `ran`, `completed`), live-tail vs snapshot projection, output media download (`experimental.media.get` / `media:<64-hex>`).
- **Sibling skills**:
  - `opencode-attachments` — prompt/command attachment input syntax (`file:`/`data:`), magic-byte checks, 20 MiB limits, `media.image` normalization.
  - `opencode-event-streams` — SSE subscription, subscribe-before-hydrate race closure, `session.log` replay.
  - `opencode-compaction` — active model-visible `session.context` vs full historical `message.list`.
  - `opencode-snapshots` — `snapshot.start/end/files` Git code snapshot hashes, turn rollback.

Read `references/transcript-and-media-contracts.md` for exact TS shapes, projection keys, media security guards.

## Core Hydration & Projection Workflow

1. **Page `message.list` to cursor termination**:
   - Call `client.message.list({ sessionID, limit?, order?, cursor?, type? })` (`GET /api/session/:sessionID/message` → `{ data: SessionMessageInfo[], cursor: { previous?, next? } }`).
   - **Terminal page rule**: Follow `cursor.next` until `data.length === 0` **or** `cursor.next` absent. **Never stop merely because page items < `limit`**.
   - Guard against repeated cursors, dedup message IDs across pages, enforce explicit mem/message bounds for UI views, reverse descending pages when hydrating recent-first slices.
2. **Decode `SessionMessageInfo` variants & tool states**:
   - `SessionMessageUser`: top-level `text`, optional `files`, `agents`, `skills`, `metadata`, `time.created` (not `content: [{ type: "text" }]`).
   - `SessionMessageAssistant.content`: `{ type: "text" }`, `{ type: "reasoning" }`, `{ type: "tool", id, name, state, time, executed?, native? }`, plus assistant-level `time` (`created`, `streamed?`, `completed?`), `finish`, `rawFinish`, structured `error`, `tokens`, `cost`, `snapshot`.
   - Tool `state.status` phases:
     - `"streaming"`: `input` raw `string` — do **not** parse as JSON args!
     - `"running"`: structured `input` map + `metadata`.
     - `"completed"`: `input` map + `content: ToolContent[]`.
     - `"error"`: structured `error` + optional `content`.
3. **Reconcile live streaming tails vs durable snapshots**:
   - Key text/reasoning fragments by `(sessionID, assistantMessageID, kind, ordinal)` (ordinals per-kind, distinct from tool `id`).
   - Treat `ended` text as **authoritative replacement** (not delta to append). Ignore late deltas after `ended`. Never reopen `completed` or `error` tool on late `called`/`progress` events (late `called` may backfill missing `ran` timestamp).
4. **Retrieve tool output media**:
   - Resolve `{ type: "file", uri, mime, name? }` from authorized session/message/tool snapshot.
   - Fetch `media:<64-lowercase-hex>` blobs via `client.experimental.media.get({ hash })` (`GET /api/experimental/media/:hash` → `Uint8Array`) or decode bounded canonical Base64 `data:` URIs with sanitized `Content-Disposition` filenames.

## Invariants & Gotchas

- **No generic message/part mutation API**: `message.list` and `session.message.get` read-only. Do **not** invent V1 `message.part.updated` or standalone message edit/delete REST endpoints.
- **Tool exec duration uses `time.ran`**: Native tool timestamps (`created`, `ran?`, `completed?`) epoch ms. Elapsed exec time = `ran` → `completed` (or `now` while running). Message creation, arg streaming start, or UI mount time != exec start.
- **Truncated UI views != full session history**: Bounding UI view to latest *N* messages != older turns vanished or descendant sessions settled.
- **Assistant `snapshot` is Git state, not media**: `assistant.snapshot` (`{ start, end, files }`) records step code-snapshot hashes for `opencode-snapshots` undo/revert, not image attachments.
- **Zero arbitrary URL proxying for media**: Only deref verified `media:<64-hex>` via `experimental.media.get` or validated inline `data:` URIs. Never fetch `http://`, `https://`, or host `file://` URIs from tool output or browser reqs.
