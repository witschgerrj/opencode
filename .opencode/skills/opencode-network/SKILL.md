---
name: opencode-network
description: Configure OpenCode V2 proxy TLS loopback NO_PROXY NODE_EXTRA_CA_CERTS
  background service troubleshooting
---

# OpenCode Networking, Proxies, Private CA Trust

OpenCode V2 separates local CLI-to-service loopback HTTP from outbound provider/search/plugin/Git traffic. Requires loopback exclusions, proc-aware env config for proxies and private CAs.

## Neighbor Skills

- Provider `baseURL`, API keys, timeouts, compression, WebSockets: `opencode-providers`.
- Web search providers, rate-limit failover, `websearch` permissions: `opencode-websearch`.
- `@opencode/client` init, Basic auth (`opencode` + `OPENCODE_PASSWORD`), SSE streams: `opencode-server-client`.
- Remote Streamable HTTP MCP server connections, OAuth: `opencode-mcp`.

## Core Workflow

1. **Identify failed proc and hop**:
   - **Hop A**: CLI/client -> local OpenCode background service over loopback.
   - **Hop B**: OpenCode server -> local GPU/inference runtime on loopback or LAN.
   - **Hop C**: OpenCode server -> external HTTPS providers, search APIs, registries.
   - Inspect exact proc env. CLI shell export does **not** update running background service. `opencode service set env` does **not** affect `opencode --standalone`, `opencode serve`, or `systemd`/`launchd` units.
2. **Apply proxy, loopback bypass, CA settings to target proc**:
   - Set `HTTP_PROXY`, `HTTPS_PROXY` (plain `http://` URLs valid for both), `NO_PROXY=localhost,127.0.0.1,::1`.
   - Persist vars for managed background service: `opencode service set env <KEY> <VALUE>` (remove: `opencode service unset env <KEY>`) → run `opencode service start`.
   - Trust private TLS root/intermediate certs at startup: `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.
   - Read `references/network-and-proxy.md` before mutating service state.
3. **Verify reachability and TLS**:
   - Run `opencode api get /api/info` → verifies local CLI-to-service reachability (Hop A).
   - Exec real model or search req → verifies outbound proxy auth and CA trust (Hop B/C).

## Critical Invariants & Gotchas

- **Missing `NO_PROXY=localhost,127.0.0.1,::1` breaks local OpenCode and local inference**:
  - Missing in CLI shell → CLI routes local service HTTP via external proxy → fails.
  - Missing in server env → local Ollama (`:11434`), LM Studio (`:1234`), vLLM (`:8000`), custom loopback calls fail.
  - Keep `NO_PROXY` set in **both** envs when proxies active.
- **`opencode service set env` stops running service**: Updating/unsetting service env halts active background daemon. Run `opencode service start` (or trigger auto-start via CLI cmd).
- **Foreground and supervisor procs ignore `opencode service set env`**: `opencode --standalone`, `opencode serve`, `systemd`/`launchd` read launch env directly. Pass `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS` in proc/unit env.
- **Percent-encode inline proxy passwords**: Raw `@`, `:`, `/`, `#`, `?`, `%` in `http://user:pass@proxy:8080` break URL parsing (`@` → `%40`, `:` → `%3A`, `/` → `%2F`). `opencode service get env` prints cleartext URLs; never paste unredacted output in logs/reports.
- **`NODE_EXTRA_CA_CERTS` loads once at startup**: Modifying PEM bundle or exporting var post-startup has no effect until proc restart. Never disable TLS verification (`NODE_TLS_REJECT_UNAUTHORIZED=0`).
- **`/api/info` success != outbound TLS success**: Healthy `opencode api get /api/info` confirms only local loopback connectivity (Hop A), not upstream proxy traversal or CA trust.
