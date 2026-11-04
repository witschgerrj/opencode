---
name: opencode-commands
description: Author config exec OpenCode V2 slash commands Markdown JSON API
---

# OpenCode Slash Commands

OpenCode V2 slash commands convert Markdown files / JSON templates to `/command` calls. Expands args + optional shell output into prompt.

## Boundaries With Neighbor Skills

- Instruction docs + `references/` / `scripts/` via `skill` or `@skill-id`: `opencode-skills` (author via `create-skill`).
- Programmatic plugins registering commands/tools/hooks/RPC: `opencode-plugins`.
- Agent definitions, permissions, child sessions: `opencode-agents`.
- Model catalog + `#variant`: `opencode-models`.
- Inbox delivery + SSE transcript sync: `opencode-inbox-delivery`, `opencode-event-streams`.

## Core Workflow

1. **Define commands in Markdown or JSONC**:
   - Put `.md` in `~/.config/opencode/commands/` (global), system `commands/`, or `.opencode/commands/` (project upward search; nested dirs = slash names: `.opencode/commands/team/review.md` → `/team/review`), or `"commands"` key in `opencode.json(c)`.
   - Markdown commands take template from trimmed body (optional YAML frontmatter: `description`, `agent`, `model`, `subagent`). JSON commands require `template` string.
   - Schema details: `references/commands-reference.md`.
2. **Design arg + shell expansion**:
   - `$ARGUMENTS`: raw arg string.
   - `$1`, `$2`, ...: quote-aware positional args (highest index gets rest of trailing text).
   - Omit placeholders: appends non-empty args after blank line.
   - Pre-submission shell exec: `` !`<cmd>` ``. Keep untrusted user input out of shell blocks.
3. **Select foreground vs background exec + API dispatch**:
   - Default: run in current session (switches active agent if `agent` set, unless target agent has `mode: "subagent"`).
   - `subagent: true` → background child session. `subagent: false` → foreground session.
   - Discovery: `command.list({ location })`. Dispatch: `session.command({ sessionID, name, text, ... })`. Monitor events/messages for completion.

## Critical Invariants and Gotchas

- **Inline `` !`...` `` blocks bypass agent tool permissions**: Argument placeholders expand *first* → executes `` !`...` `` in project dir via configured `shell` outside agent tool permission check. Never put untrusted `$ARGUMENTS` or `$1` inside `` !`...` `` (command injection risk).
- **Foreground `agent` switches session agent permanently**: Command with `agent: plan` switches active session agent to `plan` before submit. Background commands (`subagent: true` or `mode: subagent` default) leave parent session agent + model unchanged.
- **Model precedence `command > agent > session` (config-only)**: Command `model` (with `#variant`) overrides command agent `model` → overrides session model. `POST /api/session/:id/command` accepts no `model` or `variant` param; set on command definition.
- **`@path` in template = literal text**: `@README.md` inside command template submits literal string `@README.md`, does not attach file. Runtime attachments (`files` in API/composer) preserved.
- **HTTP `204` = admission only**: `session.command` returns `204 No Content` on admission, not finish. Sync transcript / child sessions / event stream for completion.
- **No `template` key in Markdown frontmatter**: Markdown template always read from file body. Command file + `opencode.json(c)` edits hot-reload automatically without restart.
