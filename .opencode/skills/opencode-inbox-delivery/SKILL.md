---
name: opencode-inbox-delivery
description: Implement debug OpenCode V2 durable session inbox admission steer queue
  delivery reconciliation without duplicate replay
---

# OpenCode Inbox Delivery

Manage OpenCode V2 durable prompt admission, `"steer"` vs `"queue"` guidance, delivery mode updates, item withdrawal, idempotent uncertain-send reconciliation.

## Scope & Boundaries

- **Owns**: `@opencode/client` `session.prompt`, `session.synthetic`, `session.inbox.list`, `session.inbox.update`, `session.inbox.cancel` (plus inbox behavior `session.compact`, `session.move`), `"steer"` vs `"queue"` semantics, `SessionInboxInfo` union, `session.inbox.*` events, `PATCH` `204`/`409` races, uncertain-submission recovery.
- **Sibling skills**:
  - `opencode-session-lifecycle`: `session.interrupt` stopping active exec **after** delivery; `session.switchModel` / `switchAgent`.
  - `opencode-attachments`: `files` URIs (`file:` / `data:`), magic bytes, 20 MiB limit.
  - `opencode-human-input`: Form answers, permissions (`session.form.*`, `permission.reply`).
  - `opencode-compaction`: Token budgets, `session.context`.
  - `opencode-event-streams`: SSE `event.subscribe`, `session.log`.

Read `references/inbox-wire-and-reconciliation.md` for SDK payloads, types, race state machines.

## Core Admission & Delivery Workflow

1. **Persist ID before dispatch**:
   - Generate & persist deterministic prompt/inbox `id` (`msg_...`) with app checkpoint **before** `POST /api/session/:id/prompt`.
   - Call `client.session.prompt({ sessionID, text, id?, files?, agents?, skills?, metadata?, delivery?, resume? })` (`200`, ret `SessionInboxUser`).
   - Explicit `delivery`:
     - `"steer"`: Interrupts/steers active loop at next step boundary for immediate guidance.
     - `"queue"`: FIFO enqueue order until work finishes. (No third tier).
2. **Admission (`200`) != delivery/completion**:
   - HTTP `200` confirms **inbox admission only**.
   - Lifecycle: `sending -> accepted (enqueued) -> delivered | cancelled` (`uncertain` on lost res).
   - Pair events `session.inbox.enqueued` / `delivered` / `cancelled` / `delivery.changed` with authoritative `session.inbox.list` and `message.list`.
3. **Reconcile uncertain sends via readback — never auto-replay**:
   - On timeout/disconnect on `POST .../prompt`, **do not auto re-POST**.
   - Query `session.inbox.list({ sessionID })` and `message.list({ sessionID })` using persisted `id`. Verify admission/delivery status. Keep draft visible; prevent duplicate side-effects.
4. **Update delivery mode (`PATCH`) or withdraw (`DELETE`)**:
   - Switch mode: `session.inbox.update({ sessionID, inboxID, delivery })` (`PATCH /api/session/:id/inbox/:inboxID` body `{ delivery }` → `204`). On `409 Conflict`, read back `inbox.list` + `message.list` to verify state.
   - Withdraw: `session.inbox.cancel({ sessionID, inboxID })` (`DELETE /api/session/:id/inbox/:inboxID` → `204`).

## Key Invariants & Gotchas

- **`SessionPromptInput` lacks `model`, `providerID`, `variant`**: Prompts execute on session current model. Switch models via `session.switchModel` (`opencode-session-lifecycle`) when idle.
- **Native inbox `PATCH` cannot edit prompt text**: `session.inbox.update` accepts `{ delivery }` **only**. To edit text/attachments: `session.inbox.cancel` first (confirm undelivered) → submit revised prompt.
- **`DELETE` on delivered item is `204` no-op**: `session.inbox.cancel` ret `204` (or `404`) if item left inbox; **never stops running exec**. Check `message.list` / `session.inbox.delivered` vs `session.inbox.cancelled`. Call `session.interrupt` to stop running exec.
- **Background child results wake idle parents via `synthetic` items**: Parent looks idle → subagent enqueues `synthetic` completion → parent wakes. Cancel only inbox IDs owned by specific withdrawn req; never cancel arbitrary system/child synthetic items.

## Inter-Agent Synthetic Inbox Delivery (`send_message`)

- `send_message({ action: "send", recipient, message, delivery, wake })` admits `type: "synthetic"` item (`metadata.source === "agent-message"`) into recipient inbox:
  - `delivery: "steer"` (default): Promoted next step boundary if recipient running.
  - `delivery: "queue"`: Waits until recipient finishes active turn.
  - `wake: true` (default): Wakes/resumes recipient if idle. `wake: false`: Deposits message passively without starting turn.
