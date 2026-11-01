---
name: opencode-permissions
description: "Author and audit OpenCode V2 `permissions` rules (`{action, resource, effect}` with `allow`, `ask`, `deny`), last-match-wins and multi-resource evaluation, wildcards, global versus per-agent rule order, independent subagent rulesets, `external_directory` and `~`/`$HOME` expansion, `portable_shell_scanner`, and saved project approval precedence. Use for permission configuration and evaluation; use `opencode-policies` for binary non-prompting `policies` and `opencode-human-input` for runtime pending approval reply/saved-grant APIs."
---

# OpenCode Permissions

Permissions control whether an OpenCode V2 agent may execute an `action` on a `resource` automatically (`allow`), block it (`deny`), or pause and ask the client (`ask`).

## Scope and Neighbor Boundaries

- **This skill owns**: Ordered `permissions` rule authoring in `opencode.json(c)` and `agents.<id>.permissions`, last-match-wins & multi-resource (`deny > ask > allow`) evaluation, `*`/`?` & trailing ` *` wildcard matching, built-in + plugin action/resource mappings, base & shipped agent defaults, `external_directory` boundary checks, `~`/`$HOME` expansion rules, `experimental.portable_shell_scanner`, and approval/saved-grant interaction with configured `deny` and `policies`.
- **Use sibling skills for**:
  - `` `opencode-policies` `` — binary non-prompting `policies` (`provider.use`, `tool.use`, `integration.use`) with inverted broad-to-narrow authority that override permissions and saved approvals.
  - `` `opencode-human-input` `` — live pending permission wire endpoints (`permission.list`, `permission.reply`, `permission.saved.*`) and UI approval handling.
  - `` `opencode-agents` `` — defining primary and subagent profiles.

Read [permission actions, defaults, and matching rules](references/actions-defaults-matching.md) for the complete action/resource table, shipped agent policies, and evaluation order.

## Core Configuration Workflow

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
   - Use V2 names: `permissions`, `shell`, and `subagent` (**never** V1 `permission`, `bash`, `task`, `doom_loop`, or `lsp`).
2. **Trace the complete rule stack**:
   - Rules append in order: **base defaults -> shipped agent defaults -> lower-to-higher precedence global `permissions` -> `agents.<id>.permissions`**.
   - **Last matching rule wins**; if zero rules match, OpenCode falls back to **`ask`**.
   - When one tool call checks multiple resources (e.g., multi-file `patch` or compound `shell` commands), **any `deny` denies; else any `ask` asks; else `allow`**.
3. **Lock down `external_directory` explicitly when isolation is needed**:
   - Base defaults allow `*` on `*` (only asking on `*.env` / `*.env.*`, while allowing `*.env.example`). Because `external_directory` defaults to `allow`, outside paths do **not** prompt unless you add an `external_directory` `ask` or `deny` rule.

## Key Invariants and Gotchas

- **Tool-schema token budgeting via `deny`**: For read-only, research, or audit agents, configuring `deny` on unused mutating tools (`execute`, `write`, `edit`, `patch`, `todowrite`) removes their tool definitions from the system prompt (`## Tools` / `<｜Tools｜>`), trimming up to `~2,890` DSML tool schema tokens per turn.
- **The Double-Subtraction Trap & Exact Verification Protocol**:
  - Never estimate tool-schema token savings with character-based heuristics (`bytes / 4`).
  - *Redundant Denies*: Checking whether tools like `webfetch` and `websearch` were already `"deny"` in live base configuration; denying an already-denied tool saves zero tokens.
  - *Bundled Code Mode Tools*: Auxiliary tools inside `core/codemode` (`opencode_models`, `opencode_session_rename`, `opencode_worktree_list`) do not emit individual top-level schemas; they live in a unified `709`-token Markdown catalog. Subtracting individual tool schemas for them is a false double-subtraction.
  - *Verification*: Always verify effective prompt token counts by querying the model server's `/apply-template` and `/tokenize` endpoints against the live rendered prompt.
- **Agent rules append; subagents do NOT inherit parent restrictions**: `agents.<id>.permissions` appends after global `permissions`. A child subagent evaluates **its own** permission ruleset—parent rules gate `subagent` (`<target-agent-id>`) launch, not the child's internal tools!
- **Trailing space-star (` *`) matches bare commands**: `"resource": "git status *"` matches both `"git status"` and `"git status --short"`. In general wildcards, `*` matches zero or more characters **including `/`**, and `?` matches one character (backslashes normalized to `/`, case-insensitive on Windows).
- **`~` and `$HOME` NEVER expand in `shell` rules**: Leading `~`, `~/`, `$HOME`, or `$HOME/` expands at config load time **only** for `external_directory`, `read`, and `edit`. `shell` resources match raw scanner-extracted command strings literally, and shell directory inference is best-effort—prefer narrow `shell` allowlists over blocklists.
- **`grep` matches regex pattern, NOT directory path**: `grep` checks `action: "grep"` against the requested search pattern, never the target `path`.
- **Portable shell scanner errors != denials**: Setting `experimental.portable_shell_scanner: true` replaces `tree-sitter` completely (no fallback); unanalyzable shell syntax returns a **scanner error** rather than a permission denial.
- **Approval scopes & `reject` blast radius**:
  - `once` approves the single request.
  - `always` saves the tool's proposed allow pattern (e.g. `*`, shell command prefix, or skill/subagent ID) **across the entire project**, but **never overrides a configured `deny`**.
  - `reject` rejects that request **and cancels every other pending permission request in the same session**.
- **Policies always run last**: After permissions and saved `"Allow always"` grants resolve to `allow` or `ask`, `` `opencode-policies` `` `tool.use` statements run last and can turn either into an immediate non-prompting `deny`.
- **Autonomous broad workspace operation & OS-level secret isolation**:
  - When configuring an autonomous top-level agent operating across a broad multi-directory workspace (such as a user home root containing `github/`, `work/`, `worktrees/`, `models/`, `environments/`), grant `"action": "external_directory", "resource": "*", "effect": "allow"` alongside native file, shell, subagent, and skill actions to avoid disruptive prompts during cross-directory navigation.
  - **Avoid application-layer filename blocklists**: Do not inject blanket `deny` rules for `*.env*` or `*opencode.json*` in permission config. Such rules break legitimate developer tasks (such as inspecting `.env.example`, generating workspace configs, or reviewing project templates).
  - Enforce real secret isolation at the OS layer (e.g., using systemd mount namespaces with `InaccessiblePaths=` for `~/.ssh`, `~/.gnupg`, `~/.aws`, and production credential vaults) rather than relying on brittle filename pattern matching.
- **Dual-layer `explore` `"shell": "deny"` enforcement (`config/plugin/agent.ts:83-91`)**:
  - Setting `"shell": "deny"` only in built-in agent defaults (`packages/core/src/plugin/agent.ts:82`) is completely undermined when top-level `permissions` contains `{ "action": "shell", "effect": "allow" }`. OpenCode's configuration loader merges top-level permissions *after* built-in agent permissions (`lastMatch` wins!), which silently re-enables shell execution for `explore` agents and can waste hundreds of seconds in rogue shell execution (e.g. `node -e` scripts in `/tmp/opencode`).
  - Enforce **dual-layer** denial: keep `plugin/agent.ts:82` locked AND explicitly configure `{ "action": "shell", "resource": "*", "effect": "deny" }` as the final rule inside `agents.explore.permissions` in `opencode.json`.
- **3-Way allowlist mandatory for any new built-in tool**:
  - Under hardened system configurations (`/etc/aquanox-security/opencode/opencode.json`), `"policies"` defaults to `tool.use: * -> deny` and `"permissions"` defaults to `*: * -> deny`.
  - Any new built-in tool (such as `request_synthesis`) MUST be explicitly permitted in **all 3 places**:
    1. Top-level `permissions`: `{ "action": "request_synthesis", "resource": "*", "effect": "allow" }`
    2. Agent-level `agents.<agent>.permissions`: allowed under both `general` and `explore` profiles
    3. Top-level `policies`: `{ "action": "tool.use", "resource": "request_synthesis:*", "effect": "allow" }`
  - If any of the three is missing, the tool call fails immediately with an authorization or policy denial.
