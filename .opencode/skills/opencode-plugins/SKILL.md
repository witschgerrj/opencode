---
name: opencode-plugins
description: Configure, discover, manage, and integrate OpenCode V2 plugins across server, TUI, Desktop GUI, and typed RPC parts. Use for opencode.jsonc and cli.json plugin arrays, auto-discovery folders, wildcard disablement, CLI plugin management, hot reload, and plugin/RPC client contracts; use opencode-commands for static slash commands and opencode-mcp for MCP servers.
---

# OpenCode Plugins and Typed RPC

OpenCode V2 plugins extend the server (tools, hooks, integrations, commands, agents, worktree strategies), terminal UI (`./tui`), OpenCode Desktop (`./gui-experimental`), and client/plugin communication (`./rpc`) from a single `@opencode/plugin` package or local directory.

## Boundaries with Neighbor Skills

- **Declarative Markdown/JSON slash commands**: Use `opencode-commands`.
- **External stdio or Streamable HTTP MCP servers**: Use `opencode-mcp`.
- **Built-in model tools and Code Mode (`execute`)**: Use `opencode-tools`.
- **System and organization policies enforced by protected plugins**: Use `opencode-policies`.

## Core Workflow

1. **Configure or auto-discover plugins in the right scope**:
   - Place single `.ts`/`.js` files or package folders inside `.opencode/plugins/`, `~/.config/opencode/plugins/`, or system `plugins/` for automatic discovery.
   - Add npm packages, Git specs, or local plugin **directories** (with optional `{ package, options }` objects) to `"plugins": [...]` in `opencode.json(c)`, or put TUI-only plugins in `~/.config/opencode/cli.json` (which stay active even when attached to a remote server).
   - Read [plugin configuration, CLI management, multi-part exports, and RPC contracts](references/plugins-reference.md) for exact path resolution, wildcard ordering, and wire schemas.
2. **Control activation order and manage global packages via CLI**:
   - Use ordered wildcard directives (`"*"`, `"-opencode.provider.*"`, `"opencode.provider.openai"`, `"-acme.reviewer"`) across composed config files to disable or re-enable plugins.
   - Manage global package plugins via `opencode plugin add`, `list [--builtin]`, `check [target]`, `update [target]`, and `remove`.
3. **Inspect catalog state and invoke RPC safely**:
   - Query `plugin.list({ location })` to inspect `source` (`builtin`, `package`, `local`, `sdk`), `features` (`server`, `tui`, `rpc`, `gui`), and `state` (`active` vs `failed` with `error`/`ref`).
   - Call `rpc.call` or typed `client.rpc(portableDefinition)` only with a known `rpcID` and method schema; a plugin advertising `features.rpc: true` does not expose an untyped universal invoke schema.

## Critical Invariants and Gotchas

- **Configured local plugin paths must be directories**: In `opencode.json(c)` `"plugins"`, passing a path to a single `.ts` or `.js` file is **silently skipped**. Wrap configured local plugins in a directory (e.g., `./plugins/local/index.ts` configured as `"./plugins/local"`), whereas direct `.ts`/`.js` files work inside auto-discovered `.opencode/plugins/`.
- **Root `<project>/plugins/` is not auto-discovered**: Only `.opencode/plugins/` (plus legacy `.opencode/plugin/`), `~/.config/opencode/plugins/`, and system `plugins/` auto-discover. A `plugins/` folder beside root `opencode.json(c)` must be listed explicitly in `"plugins"`.
- **Relative plugin paths resolve from the containing config file**: Unlike `"skills"` (which resolves from active CWD), relative paths in `"plugins"` resolve from the directory of the `opencode.json(c)` or `cli.json` file declaring them.
- **Two policy plugins cannot be disabled**: `opencode.config.policy` and `opencode.provider.opencode` (Console policy sync) ignore `-` removal directives so repositories cannot turn off policy enforcement.
- **HTTP hooks disable provider WebSockets**: Registering `http.request` or `http.response` hooks on a provider plugin forces sessions off per-session WebSocket transport onto HTTP so requests remain observable.
- **V1 plugins do not run in V2, and GUI bundles are executable code**: V1 `"plugin"` tuples must be ported to the V2 `@opencode/plugin` API (`"plugins"` + `{ package, options }`). Never evaluate `plugin.gui` bundles from untrusted servers in browser contexts without explicit sandboxing.
