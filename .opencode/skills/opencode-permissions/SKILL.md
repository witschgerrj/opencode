---
name: opencode-permissions
description: Author audit OpenCode V2 permissions rules action resource effect allow
  ask deny last-match-wins multi-resource external_directory portable_shell_scanner
---

# OpenCode Permissions

Permissions control whether OpenCode V2 agent executes `action` on `resource` auto (`allow`), blocks (`deny`), or prompts client (`ask`).

## Scope & Boundaries

- **Skill owns**: Ordered `permissions` rules in `opencode.json(c)` + `agents.<id>.permissions`, last-match-wins & multi-resource (`deny > ask > allow`) eval, `*`/`?` & trailing ` *` matching, built-in + plugin action/resource maps, base + shipped agent defaults, `external_directory` checks, `~`/`$HOME` expansion, `experimental.portable_shell_scanner`, approval/saved-grant interaction with `deny` and `policies`.
- **Sibling skills**:
  - `opencode-policies` — binary non-prompting `policies` (`provider.use`, `tool.use`, `integration.use`) broad-to-narrow override permissions/saved approvals.
  - `opencode-human-input` — live wire endpoints (`permission.list`, `permission.reply`, `permission.saved.*`) + UI approval handling.
  - `opencode-agents` — primary and subagent profiles.

Full action/resource table: `references/actions-defaults-matching.md`.

## Core Config Workflow

1. **Write ordered `{ action, resource, effect }` rules (broad first, narrow exceptions last)**:
   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "permissions": [
       { "action": "external_directory", "resource": "*", "effect": "ask" },
       { "action": "shell", "resource": "*", "effect": "ask" },
       { "action": "shell", "resource": "git status *", "effect": "allow" },
       { "action": "shell", "resource": "git diff *", "effect": "allow" },
       { "action": "shell", "resource": "git push *", "effect": "deny" }
     ],
     "agents": {
       "reviewer": {
         "mode": "subagent",
         "permissions": [
           { "action": "edit", "resource": "*", "effect": "deny" }
         ]
       }
     }
   }
   ```
   - Use V2 names: `permissions`, `shell`, `subagent` (never V1 `permission`, `bash`, `task`, `doom_loop`, `lsp`).
2. **Trace rule stack**:
   - Rules append order: **base defaults -> shipped agent defaults -> low-to-high precedence global `permissions` -> `agents.<id>.permissions`**.
   - **Last matching rule wins**; zero match falls back to **`ask`**.
   - Multi-resource check (e.g. multi-file `patch`, compound `shell` commands): **any `deny` -> deny; else any `ask` -> ask; else `allow`**.
3. **Lock down `external_directory` explicitly for isolation**:
   - Base defaults allow `*` on `*` (prompts only on `*.env` / `*.env.*`, allows `*.env.example`).
   - `external_directory` defaults `allow` -> outside paths do not prompt unless explicit `ask`/`deny` rule added.

## Key Invariants & Gotchas

- **Tool-schema token budgeting via `deny`**: Setting `deny` on mutating tools (`execute`, `write`, `edit`, `patch`, `todowrite`) removes tool defs from prompt (`## Tools` / `<｜Tools｜>`), saving up to `~2,890` DSML schema tokens/turn.
- **Double-Subtraction Trap & Exact Verification Protocol**:
  - Never estimate schema token savings with heuristic (`bytes / 4`).
  - *Redundant Denies*: Denying tools already `"deny"` in live base config (`webfetch`, `websearch`) saves 0 tokens.
  - *Bundled Code Mode Tools*: Auxiliary tools in `core/codemode` (`opencode_models`, `opencode_session_rename`, `opencode_worktree_list`) omit individual schemas; bundled in single `709`-token Markdown catalog. Subtracting individually = false double-subtraction.
  - *Verification*: Verify prompt token count via model server `/apply-template` and `/tokenize` endpoints on live rendered prompt.
- **Agent rules append; subagents do NOT inherit parent restrictions**: `agents.<id>.permissions` appends after global `permissions`. Child subagent evaluates **own** ruleset. Parent rules gate `subagent` (`<target-agent-id>`) launch, not child tool exec.
- **Trailing space-star (` *`) matches bare commands**: `"resource": "git status *"` matches `"git status"` and `"git status --short"`. General wildcards: `*` matches 0+ chars **including `/`**; `?` matches 1 char. Backslashes normalized to `/`, case-insensitive on Windows.
- **`~` and `$HOME` NEVER expand in `shell` rules**: Leading `~`, `~/`, `$HOME`, `$HOME/` expands at config load time **only** for `external_directory`, `read`, `edit`. `shell` matches raw scanner strings literally. Shell dir inference best-effort; use narrow allowlists over blocklists.
- **`grep` matches regex pattern, NOT dir path**: Action checks pattern against search string, never target `path`.
- **Portable shell scanner errs != denials**: `experimental.portable_shell_scanner: true` replaces `tree-sitter` (no fallback). Unanalyzable syntax ret **scanner err**, not permission denial.
- **Approval scopes & `reject` blast radius**:
  - `once` approves single req.
  - `always` saves proposed allow pattern (`*`, shell prefix, skill/subagent ID) **project-wide**, but **never overrides configured `deny`**.
  - `reject` rejects req **and cancels all pending permission reqs in session**.
- **Policies run last**: Permissions/saved grants resolve `allow`/`ask` -> `opencode-policies` `tool.use` runs last, can enforce immediate non-prompting `deny`.
- **Autonomous broad workspace operation & OS-level secret isolation**:
  - Top-level agent across multi-dir workspace (e.g. root with `github/`, `work/`, `worktrees/`, `models/`, `environments/`): grant `"action": "external_directory", "resource": "*", "effect": "allow"` with native file, shell, subagent, skill actions to prevent navigation prompts.
  - **Avoid app-layer filename blocklists**: No blanket `deny` for `*.env*` or `*opencode.json*` (breaks legitimate inspection of `.env.example`, workspace config, templates).
  - Enforce secret isolation at OS layer (systemd mount namespaces with `InaccessiblePaths=` for `~/.ssh`, `~/.gnupg`, `~/.aws`, production vaults).
- **Dual-layer `explore` `"shell": "deny"` enforcement (`config/plugin/agent.ts:83-91`)**:
  - `"shell": "deny"` in built-in agent defaults (`packages/core/src/plugin/agent.ts:82`) overridden if top-level `permissions` has `{ "action": "shell", "effect": "allow" }` (`lastMatch` wins!).
  - Enforce **dual-layer**: keep `plugin/agent.ts:82` AND add `{ "action": "shell", "resource": "*", "effect": "deny" }` as final rule in `agents.explore.permissions` in `opencode.json`.
- **3-Way allowlist mandatory for new built-in tools**:
  - Under hardened config (`/etc/aquanox-security/opencode/opencode.json`), `"policies"` defaults `tool.use: * -> deny` and `"permissions"` defaults `*: * -> deny`.
  - New built-in tool (e.g. `request_synthesis`) MUST exist in **all 3 places**:
    1. Top-level `permissions`: `{ "action": "request_synthesis", "resource": "*", "effect": "allow" }`
    2. Agent-level `agents.<agent>.permissions`: allowed in `general` and `explore` profiles
    3. Top-level `policies`: `{ "action": "tool.use", "resource": "request_synthesis:*", "effect": "allow" }`
  - Missing any of 3 -> immediate auth/policy denial.
