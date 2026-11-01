---
name: opencode-inbox-delivery
description: "Implement and debug OpenCode V2 durable session inbox admission (`session.prompt`, `synthetic`, `compact`, `move`), `steer` versus `queue` delivery modes, `inbox.update` (`PATCH` 204/409), `inbox.cancel` (`DELETE` 204 withdrawal), and uncertain-send readback reconciliation without duplicate replay. Use for prompt delivery and queued guidance; use `opencode-session-lifecycle` for stopping active execution and `opencode-human-input` for form/permission replies."
---

# OpenCode Inbox Delivery

Manage OpenCode V2 durable prompt admission, `"steer"` versus `"queue"` follow-up guidance, pending delivery mode updates, pending item withdrawal, and idempotent uncertain-send reconciliation.

## Scope and Neighbor Boundaries

- **This skill owns**: `@opencode/client` `session.prompt`, `session.synthetic`, `session.inbox.list`, `session.inbox.update`, and `session.inbox.cancel` (plus inbox behavior of `session.compact` and `session.move`), `"steer"` vs `"queue"` delivery semantics, `SessionInboxInfo` discriminated union, `session.inbox.*` events, `PATCH` `204`/`409` race handling, and uncertain-submission recovery.
- **Use sibling skills for**:
  - `` `opencode-session-lifecycle` `` — `session.interrupt` to stop active execution **after** an inbox item has already been delivered, and `session.switchModel` / `switchAgent`.
  - `` `opencode-attachments` `` — `files` attachment URIs (`file:` / `data:`), magic-byte checks, and 20 MiB limits.
  - `` `opencode-human-input` `` — interactive form answers and permission decisions (`session.form.*`, `permission.reply`).
  - `` `opencode-compaction` `` — compaction token budgets and `session.context`.
  - `` `opencode-event-streams` `` — SSE `event.subscribe` and `session.log` transport.

Read [durable inbox wire contracts and reconciliation](references/inbox-wire-and-reconciliation.md) for exact SDK payloads, response types, and race-condition state machines.

## Core Admission and Delivery Workflow

1. **Persist identity before dispatching `session.prompt`**:
   - Generate and persist a deterministic prompt/inbox `id` (e.g., `msg_...`) alongside your application checkpoint **before** sending `POST /api/session/:id/prompt`.
   - Call `client.session.prompt({ sessionID, text, id?, files?, agents?, skills?, metadata?, delivery?, resume? })` (`200`, returns `SessionInboxUser`).
   - Choose explicit `delivery`:
     - `"steer"` — interrupts/steers the active loop at the next step boundary to inject immediate guidance.
     - `"queue"` — waits in FIFO enqueue order until current work finishes. *(Do not invent third priority tiers.)*
2. **Distinguish admission (`200`) from delivery and completion**:
   - An HTTP `200` from `session.prompt` or `session.synthetic` confirms **inbox admission** only.
   - Track `sending -> accepted (enqueued) -> delivered | cancelled` (plus `uncertain` on lost responses) by pairing `session.inbox.enqueued` / `delivered` / `cancelled` / `delivery.changed` events with authoritative `session.inbox.list` and `message.list` reads.
3. **Reconcile uncertain sends via readback—never auto-replay**:
   - If `POST .../prompt` times out or drops the connection, **do not automatically re-POST**.
   - Query `session.inbox.list({ sessionID })` and `message.list({ sessionID })` for the persisted `id` to determine whether OpenCode admitted or already delivered the turn. Keep drafts visible while uncertain rather than risking duplicate side effects.
4. **Update delivery mode (`PATCH`) or withdraw (`DELETE`) cleanly**:
   - Switch a pending item between `"steer"` and `"queue"` via `session.inbox.update({ sessionID, inboxID, delivery })` (`PATCH /api/session/:id/inbox/:inboxID` body `{ delivery }` -> `204`). On `409 Conflict`, read back `inbox.list` and `message.list` to verify whether the item already holds the requested `delivery` or was just delivered.
   - Withdraw a pending item via `session.inbox.cancel({ sessionID, inboxID })` (`DELETE /api/session/:id/inbox/:inboxID` -> `204`).

## Key Invariants and Gotchas

- **`SessionPromptInput` has NO `model`, `providerID`, or `variant` field**: Prompts always execute on the session's current model. Switch models separately via `session.switchModel` (`opencode-session-lifecycle`) when idle.
- **Native inbox `PATCH` cannot edit prompt text**: `session.inbox.update` accepts `{ delivery }` **only**. To edit a queued prompt's text or attachments, withdraw it via `session.inbox.cancel` first (confirming it was not already delivered), then submit a revised prompt.
- **`DELETE` on an already-delivered item is a `204` no-op**: `session.inbox.cancel` returns `204` (or `404`) without error if the item already left the inbox—and **never stops running execution**. Always check `message.list` / `session.inbox.delivered` versus `session.inbox.cancelled` to know whether the turn ran, and use `session.interrupt` to stop active execution.
- **Background child results wake idle parents via `synthetic` inbox items**: When settling or stopping a session tree, check `session.inbox.list` across all family members—a parent that looks momentarily idle can wake up when a background subagent enqueues a `synthetic` completion item! Only cancel inbox IDs owned by the specific request being withdrawn, never arbitrary system/child synthetic deliveries.

## Inter-Agent Synthetic Inbox Delivery (`send_message`)

- When an agent calls `send_message({ action: "send", recipient, message, delivery, wake })`, OpenCode admits a `type: "synthetic"` item (`metadata.source === "agent-message"`) into the recipient session's durable inbox:
  - `delivery: "steer"` (default): Promoted at the next step boundary if the recipient session is currently running.
  - `delivery: "queue"`: Waits until the recipient session completes its active turn.
  - `wake: true` (default): Immediately wakes/resumes the recipient session if it is currently idle; `wake: false` deposits the message passively without starting an inference turn.
