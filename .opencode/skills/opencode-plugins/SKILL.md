---
name: opencode-plugins
description: Configure discover manage integrate OpenCode V2 plugins across server
  TUI GUI RPC parts via opencode.jsonc CLI
---

# OpenCode Plugins and Typed RPC

OpenCode V2 plugins extend server (tools, hooks, integrations, commands, agents, worktree strategies), terminal UI (`./tui`), OpenCode Desktop (`./gui-experimental`), client/plugin communication (`./rpc`) via single `@opencode/plugin` pkg or local dir.

## Boundaries with Neighbor Skills

- Declarative Markdown/JSON slash commands: `opencode-commands`.
- External stdio or Streamable HTTP MCP servers: `opencode-mcp`.
- Built-in model tools, Code Mode (`execute`): `opencode-tools`.
- System/org policies enforced by protected plugins: `opencode-policies`.

## Core Workflow

1. **Config / Auto-discover Plugins**:
   - Single `.ts`/`.js` files or pkg dirs inside `.opencode/plugins/`, `~/.config/opencode/plugins/`, or system `plugins/` → auto-discovered.
   - Add npm pkgs, Git specs, or local plugin **dirs** (optional `{ package, options }` objects) to `"plugins": [...]` in `opencode.json(c)`.
   - Put TUI-only plugins in `~/.config/opencode/cli.json` (remain active when attached to remote server).
   - Read `references/plugins-reference.md` for path resolution, wildcard ordering, wire schemas.
2. **Control Activation / Manage Global Packages via CLI**:
   - Ordered wildcard directives (`"*"`, `"-opencode.provider.*"`, `"opencode.provider.openai"`, `"-acme.reviewer"`) across composed config files disable/re-enable plugins.
   - Global pkg plugins: `opencode plugin add`, `list [--builtin]`, `check [target]`, `update [target]`, `remove`.
3. **Inspect Catalog / Invoke RPC**:
   - Query `plugin.list({ location })` → inspect `source` (`builtin`, `package`, `local`, `sdk`), `features` (`server`, `tui`, `rpc`, `gui`), `state` (`active` vs `failed` with `error`/`ref`).
   - Call `rpc.call` or typed `client.rpc(portableDefinition)` only with known `rpcID` + method schema. `features.rpc: true` does NOT expose untyped universal invoke schema.

## Critical Invariants and Gotchas

- **Configured local plugin paths must be dirs**: In `opencode.json(c)` `"plugins"`, path to single `.ts`/`.js` file **silently skipped**. Wrap local plugins in dir (e.g. `./plugins/local/index.ts` configured as `"./plugins/local"`). Direct `.ts`/`.js` files work ONLY inside auto-discovered `.opencode/plugins/`.
- **Root `<project>/plugins/` not auto-discovered**: Only `.opencode/plugins/` (plus legacy `.opencode/plugin/`), `~/.config/opencode/plugins/`, system `plugins/` auto-discover. Folder `plugins/` beside root `opencode.json(c)` MUST be listed explicitly in `"plugins"`.
- **Relative plugin paths resolve from declaring config file**: Unlike `"skills"` (resolves from active CWD), relative paths in `"plugins"` resolve from dir of declaring `opencode.json(c)` or `cli.json`.
- **Protected policy plugins immune to disablement**: `opencode.config.policy`, `opencode.provider.opencode` (Console policy sync) ignore `-` removal directives. Repos cannot disable policy enforcement.
- **HTTP hooks force HTTP transport**: Registering `http.request` or `http.response` hooks on provider plugin forces session off per-session WebSocket transport onto HTTP for observability.
- **V1 incompatible with V2; GUI bundles executable code**: Port V1 `"plugin"` tuples to V2 `@opencode/plugin` API (`"plugins"` + `{ package, options }`). Never eval `plugin.gui` bundles from untrusted servers in browser ctx without sandboxing.
