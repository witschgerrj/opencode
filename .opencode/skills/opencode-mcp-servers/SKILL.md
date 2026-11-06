---
name: opencode-mcp-servers
description: Configure authenticate and sandbox OpenCode MCP servers stdio cgroup leaf units and environment scrubbing
---

# OpenCode MCP Servers

OpenCode V2 connects local (`stdio`) and remote (Streamable HTTP) Model Context Protocol servers under session permissions, policy gates, and systemd cgroup leaf isolation.

## Scope & Boundaries

- **Owns**: `mcp.servers`, `mcp.timeout` config, `opencode mcp` CLI (`add`, `list`, `auth`, `logout`), `/mcps`, OAuth registration modes (pre-registered, CIMD, DCR) vs `oauth: false`, `stdio` cgroup leaf units (`cgroup-wrap.ts`), stdio environment scrubbing (`env-scrub.ts`), `:8080` bypass prevention, `codemode` toggle, `list_mcp_resources` / `read_mcp_resource` rules, conditional `<mcp_instructions>`, `_meta["ai.opencode/sessionID"]`.
- **Sibling skills**:
  - `opencode-tools` — built-in model tools, two-tier leaf cgroup specs, JS `execute` Code Mode sandbox.
  - `opencode-agents` — agent definitions, Buddy slot leasing, GPU tool slot policies.
  - `opencode-session-lifecycle` — session creation, `Session.remove`, unleased inference prevention.
  - `opencode-permissions` + `opencode-policies` — permission eval order, `integration.use` (`mcp:<server>`) hard blocks.
  - `opencode-human-input` — interactive form validation, reply/cancel wire contracts for elicitation forms.

Read `references/mcp-config-oauth-wire.md` for schemas, OAuth tables, timeout defaults, REST/SDK endpoints.

## Core Setup & Config Workflow

1. **Nest entries under `mcp.servers` (`opencode.jsonc`) or add via CLI**:
   - Remote CLI: `opencode mcp add context7 [--global] --url https://mcp.context7.com/mcp [--header 'API_KEY={env:API_KEY}']`
   - Local CLI: `opencode mcp add local-db [--global] --env LOG_LEVEL=info -- npx -y @example/db-mcp`
   - V2 req nesting: `"mcp": { "servers": { "<name>": { ... } } }` (never top-level `mcp.<name>`).
   - Disable: `"disabled": true` (never `"enabled": false`).
2. **Choose auth mode (OAuth vs static headers) on remote servers**:
   - Remote Streamable HTTP defaults to OAuth PKCE + discovery + refresh. Login via `/mcps` or `opencode mcp auth [server]`; clear tokens via `opencode mcp logout <server>`.
   - Set `"oauth": false` ONLY for static headers (`{env:VAR}` substitution, never `$VAR`).
   - Client registration priority: `oauth.client_id` (pre-registered) → Client ID Metadata Document (CIMD) → Dynamic Client Registration (DCR).
3. **Control tool exposure (`codemode`), resources, permissions**:
   - Default (`"codemode": true`): MCP tools live inside `execute` at `tools.<normalized_server>.<normalized_tool>(...)` (saves tool-schema tokens).
   - Set `"codemode": false` if model reqs direct native tool defs or `execute` denied.
   - Gate tools via `<server>_<tool>` (`resource: "*"`). Gate resources via `opencode_list_mcp_resources` (`<server>`) + `opencode_read_mcp_resource` (`<server>:<uri>`).

## Stdio MCP Cgroup Containment & Credential Scrubbing (`mcp/stdio.ts`)

Every local stdio MCP server process spawned by `packages/core/src/mcp/stdio.ts` is sandboxed within a bounded systemd leaf unit:

| Isolation Layer | Implementation | Security / Resource Contract |
| :--- | :--- | :--- |
| **Two-Tier Cgroup Wrap** | `buildSystemdLeafWrapCommand` | Stdio servers default to **`build_test`** (`BUILD_TEST_SPEC`) tier under `aquanox-subprocs.slice` (`MemoryHigh=6144M`, `MemoryMax=8192M`, `MemorySwapMax=0`, `OOMPolicy=kill`, `OOMScoreAdjust=300`, `AllowedCPUs=32-63`, `--nice=10`). Prevents rogue or leaking MCP servers from destabilizing host RAM or inference CPUs (`0-31`). |
| **Credential Scrubbing** | `scrubChildEnvironment(options.environment)` | Strips `OPENCODE_SERVER_PASSWORD`, `AQUANOX_BROKER_SECRET`, `AQUANOX_LLM_API_KEY`, `AQUANOX_ADMIN_TOKEN`, `OPENCODE_CREDENTIAL_*`, `AQUANOX_SECRET_*` from MCP process environment. |
| **Direct `:8080` Bypass Block** | Server-side bearer key + explicit slot check | `:8080` requires Bearer token (`--api-key-file /run/deepseek-flash-admin/inference.key`) held only in dump-disabled `MainPID` memory. Rejects missing/negative `id_slot` with `HTTP 400 Bad Request`. MCP child processes cannot hijack inference slots. |

## Key Invariants & Gotchas

- **Precedence overrides entire server object**: Same-name entry in project config replaces global config completely (no deep merge). Repeat required fields (`type`, `command`/`url`, etc.) or choose distinct server name.
- **No shell `$VAR` expansion in JSON**: Write `"{env:MCP_API_KEY}"` (single-quote `--header 'KEY={env:KEY}'` in shell).
- **`protocol: "auto"` stall risk on legacy `stdio`**: Default `"legacy"` speaks MCP up to `2025-11-25`. `"auto"` spawns probe sending `server/discover` for `2026-07-28`; hangs up to `startup` timeout (`30000` ms) if local proc ignores unknown methods. Scope `"auto"` / `"2026-07-28"` only to supported servers.
- **Custom `oauth.redirect_uri` disables CIMD**: `callback_port` works with CIMD (`https://opencode.ai/oauth/opencode/client.json`). Setting `redirect_uri` forces fallback to DCR or reqs pre-registered `client_id`.
- **Name normalization collisions**: Non-`[A-Za-z0-9_-]` chars → `_` in `<server>_<tool>` and `/<server>:<prompt>`. Keep server names distinct after normalization.
- **Conditional `<mcp_instructions>` omission**: Server init instructions omitted from system prompt if all server tools denied, or if `execute` denied with `codemode: true`.
- **Ephemeral interactive disconnect & experimental REST paths**: Disconnect in `/mcps` or `POST /api/experimental/mcp/:server/disconnect` resets on restart (`disabled: true` persists). `@opencode/client` `mcp.add`, `remove`, `connect`, `disconnect` call `/api/experimental/mcp/:server...`. `McpServer.status` is tagged object (`{ status: "connected" | "pending" | "disabled" }` or `{ status: "failed" | "needs_auth", error }`), not string.
- **Session `_meta` security**: Calls pass `CallToolRequest.params._meta["ai.opencode/sessionID"]` over `stdio` + HTTP. Not auth proof; remote servers log raw session IDs.
