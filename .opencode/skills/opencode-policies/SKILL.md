---
name: opencode-policies
description: Author audit OpenCode V2 binary allow deny policies inverted broad narrow
  precedence Console sync
---

# OpenCode Policies

Policies enforce binary (`allow` or `deny`), non-prompting restrictions across providers, tools, integrations. Evaluated via inverted broad-to-narrow precedence: system, MDM, Console rules cannot be weakened by user/repo config.

## Scope & Boundaries

- **Owns**: Top-level `policies` (and legacy `experimental.policies` merging), `provider.use`, `tool.use`, `integration.use` resource patterns, binary `allow`/`deny` tightening, partial-validation warnings, 6-tier precedence, Console 1-minute sync/offline retention, protected policy/Console plugins.
- **Neighbor skills**:
  - `opencode-permissions` — per-agent `{action, resource, effect}` rules, `ask` prompts, saved `"Allow always"` grants.
  - `opencode-providers` — configure provider endpoints, models, credentials.
  - `opencode-mcp-servers`, `opencode-skills`, `opencode-plugins` — configure integrations gated by `integration.use`.

Read `references/policy-precedence-and-console.md` for full resource syntax, authority rankings, Console lifecycle.

## Core Config Workflow

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
   - Put broad statements first, exceptions after: **last matching statement wins** (no specificity rule). If no match → normal evaluation proceeds.
2. **Authority tier placement**:
   - Inverted precedence: broader policy tiers evaluate later, override narrower tiers:
     1. macOS Managed Preferences (`/Library/Managed Preferences/[<user>/]ai.opencode.managed.plist`) — *highest*
     2. System `opencode.json(c)` (`/Library/Application Support/opencode`, `/etc/opencode`, `%ProgramData%\opencode`)
     3. Connected OpenCode Console workspace
     4. Global `~/.config/opencode/opencode.json(c)`
     5. Direct `opencode.json(c)` (outer dirs override inner subdirs)
     6. `.opencode/opencode.json(c)` (outer dirs override inner subdirs) — *lowest*
3. **Verify server logs**:
   - Invalid statements (e.g. `"effect": "ask"`, unknown `action`) dropped with server log warning; valid statements still apply. Inspect logs to prevent silent drop of security boundary.

## Key Invariants & Gotchas

- **`allow` only lifts earlier policy `deny`**: Policies only tighten access. `{ "action": "tool.use", "resource": "shell:git status *", "effect": "allow" }` never grants `shell` exec directly — only cancels earlier `"shell:*"` policy `deny`. Active agent `opencode-permissions` still decides `allow`/`ask`/`deny`.
- **`provider.use` hides providers**: Denied providers disappear from catalogs/pickers despite valid API keys, OAuth, env vars, built-in plugins. Replaces V1 `enabled_providers` / `disabled_providers`.
- **`tool.use` overrides `"Allow always"`**: Runs **after** agent permissions and saved approvals. Fails immediately with `Blocked by configuration policy` (or `Blocked by <Workspace>'s policy`). Trailing ` *` pattern also matches bare command (`"shell:git push *"` blocks `"git push"`).
- **`integration.use` unloads MCP, skills, plugins**: Matches `mcp:<server>`, `skill:<id>`, `plugin:<unversioned-package-or-abs-path>`. Blocks integration load regardless of discovery path.
- **No runtime sandboxing of loaded plugin code**: Blocks provider pipeline and plugin loading, but does NOT sandbox raw network calls inside allowed plugin JS code.
- **Protected plugins & Console offline persistence**: Built-in policy plugin and Console plugin cannot be disabled via `plugins`. Console syncs ~1/min; offline cache stays enforced until explicit disconnect or workspace switch.
- **3-way allowlist trap for built-in tools**:
  - Hardened host env (e.g. `/etc/aquanox-security/opencode/opencode.json`): `policies` defaults to `{ "action": "tool.use", "resource": "*", "effect": "deny" }`, permissions default to `*: * -> deny`.
  - Adding new built-in tool (e.g. `request_synthesis`): permissions in top-level `permissions` and `agents.<id>.permissions` insufficient. Policy layer blocks with `Blocked by configuration policy` unless explicit policy present: `{ "action": "tool.use", "resource": "request_synthesis:*", "effect": "allow" }`.
  - Must allow across 3 tiers: (1) top-level `policies`, (2) top-level `permissions`, (3) per-agent `agents.<id>.permissions` (`general` and `explore`).
- **Policy tier vs agent permission boundary**:
  - Policies enforce global non-prompting containment; do not distinguish agent personas (`general` vs `explore`).
  - Agent-specific containment (e.g. block `shell` for `explore`, allow for `general`) reqs pairing top-level policies with dual-layer agent permissions (`plugin/agent.ts` + `agents.explore.permissions` in `opencode.json`).
