---
name: opencode-policies
description: "Author and audit OpenCode V2 `policies` (`provider.use`, `tool.use`, `integration.use` with binary `allow`/`deny`), inverted broad-to-narrow config precedence (MDM and system overriding OpenCode Console, global, and project files), Console 1-minute workspace sync, and non-disableable built-in policy plugins. Use for hard organizational or host containment restrictions; use `opencode-permissions` for per-agent `allow`/`ask`/`deny` tool prompts."
---

# OpenCode Policies

Policies enforce binary (`allow` or `deny`), non-prompting restrictions across providers, tools, and integrations, evaluated with **inverted broad-to-narrow precedence** so system, MDM, and OpenCode Console rules cannot be weakened by user or repository config files.

## Scope and Neighbor Boundaries

- **This skill owns**: Top-level `policies` statements (and legacy `experimental.policies` merging), `provider.use`, `tool.use`, and `integration.use` resource patterns, binary `allow`/`deny` tightening semantics, partial-validation warning behavior, inverted 6-tier precedence (macOS MDM -> System -> OpenCode Console -> Global -> Direct project -> `.opencode` project), Console 1-minute sync & offline retention, and protected policy/Console plugins.
- **Use sibling skills for**:
  - `` `opencode-permissions` `` — per-agent `{action, resource, effect}` rules supporting `ask` prompts and saved `"Allow always"` grants.
  - `` `opencode-providers` `` — configuring provider endpoints, models, and credentials (policies restrict provider usage; they never configure endpoints or credentials).
  - `` `opencode-mcp-servers` ``, `` `opencode-skills` ``, and `` `opencode-plugins` `` — configuring integrations gated by `integration.use`.

Read [policy actions, inverted precedence, and Console sync](references/policy-precedence-and-console.md) for full resource syntax, authority rankings, and Console lifecycle tables.

## Core Configuration Workflow

1. **Author ordered `{ action, resource, effect }` statements (`opencode.jsonc`)**:
   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "policies": [
       // 1. Allowlist specific model providers
       { "action": "provider.use", "resource": "*", "effect": "deny" },
       { "action": "provider.use", "resource": "anthropic", "effect": "allow" },

       // 2. Hard-block dangerous tool checks (even after saved approvals)
       { "action": "tool.use", "resource": "shell:git push *", "effect": "deny" },
       { "action": "tool.use", "resource": "read:*/.ssh/*", "effect": "deny" },

       // 3. Restrict loaded MCP servers, skills, or plugins
       { "action": "integration.use", "resource": "mcp:*", "effect": "deny" },
       { "action": "integration.use", "resource": "mcp:github", "effect": "allow" }
     ]
   }
   ```
   - Put broad statements first and exceptions after them: **last matching statement wins** (no specificity rule). If nothing matches, policy allows normal evaluation to proceed.
2. **Place restrictions at the right authority tier**:
   - Unlike normal settings where project configs win, **broader policy tiers evaluate later and override narrower tiers**:
     1. macOS Managed Preferences (`/Library/Managed Preferences/[<user>/]ai.opencode.managed.plist`) — *highest*
     2. System `opencode.json(c)` (`/Library/Application Support/opencode`, `/etc/opencode`, `%ProgramData%\opencode`)
     3. Connected OpenCode Console workspace
     4. Global `~/.config/opencode/opencode.json(c)`
     5. Direct `opencode.json(c)` (outer directories beat inner subdirectories)
     6. `.opencode/opencode.json(c)` (outer directories beat inner subdirectories) — *lowest*
3. **Check server logs after editing `deny` statements**:
   - Invalid policy statements (for example, using `"effect": "ask"` or an unknown `action`) are **dropped with a server log warning** while remaining valid statements apply! Always inspect logs so a typo never silently drops a security boundary.

## Key Invariants and Gotchas

- **Policy `allow` ONLY lifts an earlier policy `deny`**: Policies only ever tighten access. `{ "action": "tool.use", "resource": "shell:git status *", "effect": "allow" }` never grants `shell` execution on its own—it merely lifts an earlier `"shell:*"` policy `deny`, leaving the active agent's `` `opencode-permissions` `` rules to allow, ask, or deny.
- **`provider.use` hides providers completely**: Denied providers vanish from catalogs and model pickers even if valid API keys, OAuth accounts, environment variables, or built-in plugins exist. Replaces V1 `enabled_providers` / `disabled_providers`.
- **`tool.use` overrides `"Allow always"` grants without prompting**: Runs **after** agent permissions and saved project approvals, failing immediately with `Blocked by configuration policy` (or `Blocked by <Workspace>'s policy` for Console denials). Trailing ` *` patterns also match bare commands (`"shell:git push *"` blocks `"git push"`).
- **`integration.use` unloads MCP, skills, and plugins**: Matches `mcp:<server>`, `skill:<id>`, and `plugin:<unversioned-package-or-abs-path>`, preventing denied integrations from loading regardless of how they were discovered.
- **No runtime sandboxing of already-loaded plugin code**: Denying a provider blocks OpenCode's normal provider/model pipeline, and `integration.use` can block loading a plugin—but policies do **not** sandbox raw network calls inside an allowed custom plugin's JavaScript code.
- **Protected built-in plugins & Console offline persistence**: Neither the built-in policy enforcement plugin nor the OpenCode Console plugin can be disabled via `plugins`. Console policies refresh roughly **once per minute** and **remain enforced from cache if Console becomes unreachable** (cleared only on explicit disconnect or replaced on workspace switch).
- **The 3-way allowlist trap for new built-in tools**:
  - In hardened host environments (such as `/etc/aquanox-security/opencode/opencode.json`), `policies` defaults to `{ "action": "tool.use", "resource": "*", "effect": "deny" }` and `permissions` defaults to `*: * -> deny`.
  - When introducing a new built-in control tool (such as `request_synthesis`), granting permissions in top-level `permissions` and `agents.<id>.permissions` is **insufficient**: the policy layer evaluates after permissions and immediately blocks the tool with `Blocked by configuration policy` unless an explicit policy statement is included:
    `{ "action": "tool.use", "resource": "request_synthesis:*", "effect": "allow" }`.
  - To authorize any new tool in hardened environments, the tool must be allowed across all 3 tiers: (1) top-level `policies`, (2) top-level `permissions`, and (3) per-agent `agents.<id>.permissions` (for both `general` and `explore`).
- **Policy tier vs agent-level permissions boundary**:
  - Policies enforce global non-prompting containment across providers, tools, and integrations, but they do not distinguish between agent personas (such as `general` vs `explore`).
  - To enforce agent-specific containment—such as preventing `explore` from invoking `shell` while allowing `general` to run commands—pair top-level policies with **dual-layer agent permissions** (`plugin/agent.ts` + `agents.explore.permissions` in `opencode.json`) so top-level permission merging does not override agent-level security boundaries.
