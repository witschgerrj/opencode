---
name: opencode-mcp-servers
description: "Configure, authenticate, and integrate OpenCode V2 Model Context Protocol servers (`mcp.servers` local `stdio` and remote Streamable HTTP, `opencode mcp` CLI, OAuth PKCE/CIMD/DCR versus `oauth: false` headers, timeouts, `protocol` versions, tool/prompt normalization, Code Mode versus direct exposure, resource permissions, elicitation, session `_meta`, and `@opencode/client` `mcp.*` APIs). Use for MCP servers; use `opencode-tools` for built-in tools and `opencode-plugins` for native plugins."
---

# OpenCode MCP Servers

OpenCode V2 connects to local (`stdio`) and remote (Streamable HTTP) Model Context Protocol servers, exposing their tools, prompts, resources, and initialization instructions under session permissions and policies.

## Scope and Neighbor Boundaries

- **This skill owns**: `mcp.servers` and `mcp.timeout` configuration, `opencode mcp` CLI (`add`, `list`, `auth`, `logout`) and `/mcps`, OAuth registration modes (pre-registered, CIMD, DCR) vs `oauth: false`, `protocol` (`legacy`, `auto`, `2026-07-28`), `<server>_<tool>` and `/<server>:<prompt>` name normalization, `codemode` toggle, `list_mcp_resources` / `read_mcp_resource` rules, conditional `<mcp_instructions>`, mid-call elicitation, `_meta["ai.opencode/sessionID"]`, and `@opencode/client` `mcp.*` wire endpoints.
- **Use sibling skills for**:
  - `` `opencode-tools` `` — built-in model tools and the JavaScript `execute` Code Mode sandbox.
  - `` `opencode-permissions` `` and `` `opencode-policies` `` — permission evaluation order and `integration.use` (`mcp:<server>`) hard blocks.
  - `` `opencode-human-input` `` — interactive form validation and reply/cancel wire contracts when answering elicitation forms.
  - `` `opencode-plugins` `` — in-process OpenCode TypeScript/JavaScript plugins.

Read [MCP configuration, OAuth, and client wire contracts](references/mcp-config-oauth-wire.md) for complete schemas, OAuth tables, timeout defaults, and REST/SDK endpoints.

## Core Setup and Configuration Workflow

1. **Nest entries under `mcp.servers` (`opencode.jsonc`) or add via CLI**:
   - CLI remote: `opencode mcp add context7 [--global] --url https://mcp.context7.com/mcp [--header 'API_KEY={env:API_KEY}']`
   - CLI local: `opencode mcp add local-db [--global] --env LOG_LEVEL=info -- npx -y @example/db-mcp`
   - V2 requires nesting under `"mcp": { "servers": { "<name>": { ... } } }` (never top-level `mcp.<name>`), and uses `"disabled": true` (never `"enabled": false`) to keep a server configured without connecting.
2. **Choose OAuth vs static header authentication on remote servers**:
   - Remote Streamable HTTP servers enable OAuth PKCE + discovery + refresh by default; complete login via `/mcps` or `opencode mcp auth [server]`, and clear tokens via `opencode mcp logout <server>`.
   - Set `"oauth": false` **only** when authenticating exclusively with static headers (using `{env:VAR}` substitution, never `$VAR`).
   - Client registration priority: `oauth.client_id` (pre-registered, `snake_case` fields) -> Client ID Metadata Document (CIMD, when supported by auth server and `oauth.redirect_uri` is omitted) -> Dynamic Client Registration (DCR).
3. **Control tool exposure (`codemode`), resources, and permissions**:
   - By default (`"codemode": true`), MCP tools live inside `execute` at `tools.<normalized_server>.<normalized_tool>(...)` to save native tool-schema tokens. Set `"codemode": false` if the model needs direct native tool definitions or if `execute` Code Mode is denied.
   - Gate tools via `<server>_<tool>` (`resource: "*"`), and gate resources via `opencode_list_mcp_resources` (`<server>`) and `opencode_read_mcp_resource` (`<server>:<uri>`).

## Key Invariants and Gotchas

- **Higher-precedence configs replace the entire server object**: Overriding a same-name entry in a project config wipes omitted fields from global config rather than deep-merging them. Repeat all required fields (`type`, `command`/`url`, etc.) or choose a distinct server name.
- **No shell `$VAR` expansion in JSON strings**: Always write `"{env:MCP_API_KEY}"` (and single-quote `--header 'KEY={env:KEY}'` in shells).
- **`protocol: "auto"` can stall legacy `stdio` servers**: Default `"legacy"` speaks MCP up to `2025-11-25`. `"auto"` spawns an extra probe sending `server/discover` for `2026-07-28`, which can hang up to `startup` timeout (`30000` ms) if a legacy local process ignores unknown methods. Scope `"auto"` or `"2026-07-28"` only to servers that support it.
- **Custom `oauth.redirect_uri` disables CIMD**: `callback_port` works with CIMD (`https://opencode.ai/oauth/opencode/client.json`), whereas setting `redirect_uri` forces fallback to DCR (or requires a pre-registered `client_id`).
- **Name normalization collisions**: Characters outside `[A-Za-z0-9_-]` become `_` in `<server>_<tool>` and `/<server>:<prompt>`. Keep server names short and distinct after normalization.
- **Conditional `<mcp_instructions>` omission**: Server initialization instructions are omitted from the system prompt whenever all of that server's tools are denied, or when `execute` is denied while the server uses `codemode: true`.
- **Interactive disconnect is ephemeral & experimental REST paths**: Disconnecting in `/mcps` or via `POST /api/experimental/mcp/:server/disconnect` does not persist across restarts (`disabled: true` persists it). Note that `@opencode/client` `mcp.add`, `remove`, `connect`, and `disconnect` all target **`/api/experimental/mcp/:server...`**, and `McpServer.status` is a **tagged object** (`{ status: "connected" | "pending" | "disabled" }` or `{ status: "failed" | "needs_auth", error }`), not a plain string.
- **Session `_meta` privacy & security**: Session tool calls pass `CallToolRequest.params._meta["ai.opencode/sessionID"]` over both `stdio` and HTTP. Never treat it as authentication/authorization proof, and remember remote servers can log raw session IDs.
