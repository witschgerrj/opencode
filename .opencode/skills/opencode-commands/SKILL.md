---
name: opencode-commands
description: Author, configure, and execute OpenCode V2 slash commands across Markdown command files, JSON config entries, and the session.command API. Use for prompt templates, $ARGUMENTS and positional parsing, inline ! shell blocks, foreground agent switching vs background subagent runs, and command wire contracts; use opencode-skills for on-demand agent skills and opencode-plugins for plugin development.
---

# OpenCode Slash Commands

OpenCode V2 slash commands turn reusable Markdown files or JSON templates into `/command` invocations that expand arguments and optional shell outputs into a durable user prompt.

## Boundaries with Neighbor Skills

- **On-demand agent instructions and bundled `references/` / `scripts/` loaded via `skill` or `@skill-id`**: Use `opencode-skills` (or `create-skill` to author skills).
- **Programmatic plugins registering commands, tools, hooks, or RPC**: Use `opencode-plugins`.
- **Agent definitions, permissions, and child-session family settlement**: Use `opencode-agents`.
- **Model catalog and `#variant` definitions**: Use `opencode-models`.
- **Steer/queue inbox delivery and SSE transcript reconciliation**: Use `opencode-inbox-delivery` and `opencode-event-streams`.

## Core Workflow

1. **Define commands in Markdown or JSONC**:
   - Place `.md` files in `~/.config/opencode/commands/` (global), system `commands/`, or `.opencode/commands/` (project upward discovery; nested folders become slash-separated names like `.opencode/commands/team/review.md` -> `/team/review`), or under `"commands"` in `opencode.json(c)`.
   - Markdown commands take their template from the trimmed file body (with optional YAML frontmatter for `description`, `agent`, `model`, `subagent`); JSON commands require a `template` string.
   - Read [command fields, argument/shell expansion, execution rules, and wire contracts](references/commands-reference.md) for complete schemas and precedence.
2. **Design safe argument and shell expansion**:
   - Use `$ARGUMENTS` for raw argument text, `$1`, `$2`, ... for quote-aware positional slots (where the highest-numbered slot consumes all trailing words), or omit placeholders to append non-empty arguments after a blank line.
   - Wrap trusted pre-submission shell commands in `` !`<cmd>` `` only when needed, keeping untrusted user input out of shell blocks.
3. **Select foreground vs background execution and reconcile via API**:
   - By default, commands run in the current session (switching the session's active agent if `agent` is set, unless the target agent has `mode: "subagent"`). Set `subagent: true` to force a background child session or `subagent: false` to force the current foreground session.
   - Programmatic callers discover via `command.list({ location })` and dispatch via `session.command({ sessionID, name, text, ... })`, then monitor session events/messages for completion.

## Critical Invariants and Gotchas

- **Inline `` !`...` `` shell blocks bypass agent tool permissions**: OpenCode expands argument placeholders *first* and then executes `` !`...` `` blocks in the active project directory using the configured `shell` **outside** the agent's `shell` permission flow. Never interpolate untrusted `$ARGUMENTS` or `$1` values inside `` !`...` `` blocks (command injection risk), and only run commands from trusted sources.
- **Foreground `agent` commands permanently switch the session agent**: Running a foreground command configured with `agent: plan` switches the active session to `plan` before submitting the prompt. Background commands (`subagent: true` or `mode: subagent` when `subagent` is omitted) leave the parent session's agent and model untouched.
- **Model precedence is `command > agent > session`, and config-only**: A command's `model` (including `#variant`) overrides the command agent's `model`, which overrides the active/parent session's model. Runtime `session.command` (`POST /api/session/:id/command`) accepts **no** `model` or `variant` field—model overrides must live on the command definition.
- **Stored `@path` mentions are literal text**: Writing `@README.md` inside a command template does **not** attach the file; it submits `@README.md` as plain prompt text. File attachments added through the composer/API at invocation time (`files`) are preserved.
- **HTTP `204` proves admission, not completion**: `session.command` returns `204 No Content` as soon as the command is accepted; reconcile transcript turns, child sessions, and stream events to confirm execution outcome.
- **Never put `template` in Markdown frontmatter**: Markdown command templates always come from the document body. Edits to command files and `opencode.json(c)` hot-reload automatically without restarting OpenCode.
