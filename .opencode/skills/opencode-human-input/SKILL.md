---
name: opencode-human-input
description: "Implement and debug OpenCode V2 interactive pending questions/forms (`session.form.*`, `form.list`, `FormField` validation, fixed-point `when` conditions, uncertain-reply `form.get` readback) and runtime permission approval endpoints (`permission.list/get/create/reply` with `once`/`always`/`reject` and `permission.saved.*` project allow grants). Use for runtime human-in-the-loop wire protocols; use `opencode-permissions` for authoring `opencode.json(c)` permission rules."
---

# OpenCode Human Input (Forms, Questions, and Runtime Approvals)

Handle OpenCode V2 mid-turn human interactions—interactive `question` / MCP elicitation forms and runtime tool permission requests—including conditional field validation, session ownership checks, uncertain-send reconciliation, and saved project allow-grant CRUD.

## Scope and Neighbor Boundaries

- **This skill owns**: `@opencode/client` `session.form.*` (`list`, `create`, `get`, `reply`, `cancel`) and `form.list`, `FormField` schema validation (`string`, `number`, `integer`, `boolean`, `multiselect`, `external`) and fixed-point `when` dependency resolution, `permission.list`/`get`/`create`/`reply` (`once`, `always`, `reject`) and `permission.request.list`, `permission.saved.*` (`list`, `update`, `remove`), and post-timeout reply reconciliation.
- **Use sibling skills for**:
  - `` `opencode-permissions` `` — authoring ordered `{action, resource, effect}` rules in `opencode.json(c)` and understanding wildcard/default evaluation.
  - `` `opencode-policies` `` — non-prompting hard `policies` that override saved approvals.
  - `` `opencode-tools` `` and `` `opencode-mcp-servers` `` — how `question` and MCP elicitation trigger forms.
  - `` `opencode-inbox-delivery` `` — normal user prompt submission and `steer`/`queue` inbox items (keep form/permission replies strictly separate from prompt submissions!).

Read [forms and runtime permission wire contracts](references/forms-and-permissions-wire.md) for endpoint tables, field validation edge cases, and `SavedInfo` schema constraints.

## Core Interaction Workflow

1. **Verify exact `(sessionID, requestID / formID)` ownership before displaying or replying**:
   - Location-wide `form.list({ location? })` (`GET /api/form`) and `permission.request.list({ location? })` (`GET /api/permission/request`) return **all** pending items in that workspace, including unowned sessions or external integrations.
   - Always resolve the authorized session (or verified descendant session family), match **both** `sessionID` and `formID`/`requestID`, and verify `form.metadata.tool.sessionID === form.sessionID` when present.
2. **Validate `FormField` drafts with fixed-point `when` evaluation**:
   - Resolve `when: { key, op: "eq" | "neq", value }` dependencies iteratively to a fixed point so forward references activate properly and dependency cycles remain inactive.
   - **Unanswered controller rule**: When a controlling field is unanswered or inactive, **both `eq` and `neq` evaluate to `false`**.
   - Omit inactive fields (and hidden fields lacking defaults) from `answer`; keep partial numeric UI drafts as strings (empty input is **not** `0`, and require finite numbers); store field maps in null-prototype objects (`Object.create(null)`) so reserved keys (`__proto__`, `constructor`) cannot pollute prototypes.
   - Reply via `session.form.reply({ sessionID, formID, answer })` (`POST .../reply` -> `204`), or explicitly cancel via `session.form.cancel({ sessionID, formID, message? })` (`DELETE .../form/:formID` with `message` in **query** -> `204`; distinct from submitting an empty answer!).
3. **Execute runtime permission decisions with clear scope disclosure**:
   - Display exact `action`, `resources`, and proposed `save` patterns before sending `permission.reply({ sessionID, requestID, decision, message? })`:
     - `"once"` — approves only that single pending request.
     - `"always"` — approves and saves durable **project-wide** allow patterns (`permission.saved.*`), which can also resolve matching requests across shared project sessions (never overrides configured `deny` or `policies`).
     - `"reject"` — rejects that request **and cancels every other pending permission request in the same `sessionID`**.
4. **Reconcile uncertain replies without blind replay**:
   - If a form `reply` or `cancel` times out, read `session.form.get({ sessionID, formID })` (settled form details are retained briefly, ~10 minutes) and compare `state` (`"answered"` + exact `answer` values, or `"cancelled"` + `message`); `404`/`409` indicates stale/already-resolved state.

## Key Invariants and Gotchas

- **Disappearance != your decision won**: A form or permission vanishing from `list` proves only that *some* caller or cancellation resolved it—never claim a specific `once`/`always`/`reject` decision succeeded from disappearance alone.
- **Reply ACK != session turn complete**: A `204` from `form.reply` or `permission.reply` resumes the paused tool step; keep observing session events/activity for turn completion, and pause execution-timeout budgets separately from human-wait time where applicable.
- **`SavedInfo` has NO `effect` field**: `permission.saved.list({ projectID? })` returns `{ id, projectID, action, resource, time }[]` where `action` is the tool action (e.g. `"shell"`), **never** `"allow"`/`"ask"`/`"deny"`. Every saved entry is an allow grant; use `permission.saved.update({ id, action?, resource? })` to narrow matchers or `permission.saved.remove({ id })` to revoke.
- **External form fields require safe URL checks**: For `{ key, type: "external", url, title?, description? }`, verify `url` uses `http:` or `https:` without embedded credentials before opening links, and require boolean `true` acknowledgement in `answer[key]`.
