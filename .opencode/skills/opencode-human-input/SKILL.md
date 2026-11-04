---
name: opencode-human-input
description: Wire protocol runtime handler for OpenCode V2 interactive question forms,
  FormField validation, and permission approval requests
---

# OpenCode Human Input (Forms, Questions, Runtime Approvals)

Handle OpenCode V2 mid-turn human interactions: interactive `question` / MCP elicitation forms + runtime tool permission requests. Covers conditional field validation, session ownership checks, uncertain-send reconciliation, saved project allow-grant CRUD.

## Scope and Neighbor Boundaries

- **This skill owns**: `@opencode/client` `session.form.*` (`list`, `create`, `get`, `reply`, `cancel`), `form.list`, `FormField` schema validation (`string`, `number`, `integer`, `boolean`, `multiselect`, `external`), fixed-point `when` dep resolution, `permission.list`/`get`/`create`/`reply` (`once`, `always`, `reject`), `permission.request.list`, `permission.saved.*` (`list`, `update`, `remove`), post-timeout reply reconciliation.
- **Use sibling skills for**:
  - `opencode-permissions` — authoring ordered `{action, resource, effect}` rules in `opencode.json(c)`, wildcard/default evaluation.
  - `opencode-policies` — non-prompting hard `policies` overriding saved approvals.
  - `opencode-tools` + `opencode-mcp-servers` — trigger forms via `question` / MCP elicitation.
  - `opencode-inbox-delivery` — prompt submission, `steer`/`queue` inbox items (separate form/permission replies from prompt submissions).

Read `references/forms-and-permissions-wire.md` for endpoint tables, field validation edge cases, `SavedInfo` schema constraints.

## Core Interaction Workflow

1. **Verify exact `(sessionID, requestID / formID)` ownership before display/reply**:
   - `form.list({ location? })` (`GET /api/form`) + `permission.request.list({ location? })` (`GET /api/permission/request`) ret ALL pending items in workspace, including unowned sessions or external integrations.
   - Resolve auth session (or verified descendant session family) → match BOTH `sessionID` + `formID`/`requestID` → verify `form.metadata.tool.sessionID === form.sessionID` when present.
2. **Validate `FormField` drafts with fixed-point `when` eval**:
   - Resolve `when: { key, op: "eq" | "neq", value }` deps iteratively to fixed point: forward refs activate properly, dep cycles remain inactive.
   - **Unanswered controller rule**: controller field unanswered or inactive → **both `eq` and `neq` eval `false`**.
   - Omit inactive fields (and hidden fields lacking defaults) from `answer`. Keep partial numeric UI drafts as strings (empty input != `0`, require finite numbers). Store field maps in null-prototype objects (`Object.create(null)`) to prevent prototype pollution (`__proto__`, `constructor`).
   - Reply via `session.form.reply({ sessionID, formID, answer })` (`POST .../reply` → `204`). Explicit cancel via `session.form.cancel({ sessionID, formID, message? })` (`DELETE .../form/:formID` with `message` in query param → `204`; distinct from empty answer submission).
3. **Exec runtime permission decisions with scope disclosure**:
   - Display exact `action`, `resources`, proposed `save` patterns before `permission.reply({ sessionID, requestID, decision, message? })`:
     - `"once"` — approves single pending req.
     - `"always"` — approves + saves durable project-wide allow patterns (`permission.saved.*`) resolving matching reqs across shared project sessions (never overrides configured `deny` or `policies`).
     - `"reject"` — rejects req **AND cancels every other pending permission req in same `sessionID`**.
4. **Reconcile uncertain replies without blind replay**:
   - Form `reply` or `cancel` timeout → read `session.form.get({ sessionID, formID })` (settled form retained ~10 min) → compare `state` (`"answered"` + exact `answer` values, or `"cancelled"` + `message`). `404`/`409` = stale/already-resolved state.

## Key Invariants and Gotchas

- **Disappearance != decision won**: Form/permission vanishing from `list` proves only caller/cancellation resolved it; never claim specific `"once"`/`"always"`/`"reject"` succeeded from disappearance alone.
- **Reply ACK != session turn complete**: `204` from `form.reply` or `permission.reply` resumes paused tool step. Keep observing session events/activity for turn completion. Pause exec timeout budgets separately from human wait time.
- **`SavedInfo` has NO `effect` field**: `permission.saved.list({ projectID? })` ret `{ id, projectID, action, resource, time }[]`. `action` is tool action (e.g. `"shell"`), **never** `"allow"`/`"ask"`/`"deny"`. All saved entries = allow grants. Use `permission.saved.update({ id, action?, resource? })` to narrow matchers, `permission.saved.remove({ id })` to revoke.
- **External form fields require safe URL checks**: For `{ key, type: "external", url, title?, description? }`, verify `url` scheme `http:` or `https:` without embedded credentials before opening. Require boolean `true` ack in `answer[key]`.
