---
name: opencode-network
description: Configure and troubleshoot OpenCode V2 HTTP/HTTPS proxies, mandatory NO_PROXY loopback exclusions, managed background service vs foreground process environments, percent-encoded proxy credentials, and NODE_EXTRA_CA_CERTS private CA trust. Use for transport, proxy, and TLS layers; use opencode-providers for provider endpoints/auth, opencode-websearch for search engines, and opencode-server-client for API client construction.
---

# OpenCode Networking, Proxies, and Private CA Trust

OpenCode V2 separates local CLI-to-service loopback HTTP connections from the server's outbound provider, search, plugin, and Git traffic—requiring explicit loopback exclusions and process-aware environment configuration whenever proxies or private CAs are in play.

## Boundaries with Neighbor Skills

- **Provider `baseURL`, API keys, timeouts, body compression, and WebSockets**: Use `opencode-providers`.
- **Web search providers, rate-limit failover, and `websearch` permissions**: Use `opencode-websearch`.
- **`@opencode/client` instantiation, Basic auth (`opencode` + `OPENCODE_PASSWORD`), and SSE streams**: Use `opencode-server-client`.
- **Remote Streamable HTTP MCP server connections and OAuth**: Use `opencode-mcp`.

## Core Workflow

1. **Identify which process and hop failed**:
   - Separate **Hop A** (CLI/client -> local OpenCode background service over loopback) from **Hop B** (OpenCode server -> local GPU/inference runtime on loopback or LAN) and **Hop C** (OpenCode server -> external HTTPS providers, search APIs, or registries).
   - Inspect the exact environment of the process making the failing request: CLI shell exports do **not** reconfigure an already-running background service, and `opencode service set env` does **not** affect `opencode --standalone`, `opencode serve`, or OS-managed `systemd`/`launchd` units.
2. **Apply proxy, loopback bypass, and CA settings to the right process**:
   - Set `HTTP_PROXY`, `HTTPS_PROXY` (plain `http://` proxy URLs are valid for both), and **`NO_PROXY=localhost,127.0.0.1,::1`**.
   - Persist variables for the managed background service with `opencode service set env <KEY> <VALUE>` (and remove with `opencode service unset env <KEY>`), then run `opencode service start`.
   - Trust private TLS root/intermediate certificates at startup via `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.
   - Read [proxy configuration, managed service lifecycle, credentials, CA bundles, and verification](references/network-and-proxy.md) before mutating service state.
3. **Verify local reachability and outbound TLS separately**:
   - Run `opencode api get /api/info` to verify local CLI-to-service reachability (Hop A), then execute a real model or search request to verify outbound proxy auth and CA trust (Hop B/C).

## Critical Invariants and Gotchas

- **Missing `NO_PROXY=localhost,127.0.0.1,::1` breaks local OpenCode and local inference**: Without loopback exclusions in the CLI shell, the CLI routes local background-service HTTP calls through the external proxy and fails. Without loopback exclusions in the server environment, local Ollama (`:11434`), LM Studio (`:1234`), vLLM (`:8000`), and custom loopback inference calls also fail. Keep `NO_PROXY` set in **both** environments whenever proxies are active.
- **`opencode service set env` immediately stops the running service**: Updating or unsetting any managed service environment variable halts the active background daemon. Explicitly run `opencode service start` (or trigger auto-start on the next CLI command) during an authorized maintenance window.
- **Foreground and supervisor processes ignore `opencode service set env`**: `opencode --standalone`, `opencode serve`, and `systemd`/`launchd` service units read strictly from their own launch environment—pass `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and `NODE_EXTRA_CA_CERTS` directly in their process/unit environment.
- **Percent-encode special characters in inline proxy passwords**: Raw `@`, `:`, `/`, `#`, `?`, or `%` inside `http://user:pass@proxy:8080` break URL parsing (encode `@` as `%40`, `:` as `%3A`, `/` as `%2F`). Because `opencode service get env` prints persisted URLs in cleartext, **never** paste unredacted `service get env` output into logs or reports.
- **`NODE_EXTRA_CA_CERTS` loads once at process startup**: Editing the PEM bundle or exporting the variable after startup has no effect until the OpenCode process restarts. Always configure `NODE_EXTRA_CA_CERTS` rather than disabling TLS verification (`NODE_TLS_REJECT_UNAUTHORIZED=0`).
- **`/api/info` passing never proves outbound TLS works**: A healthy `opencode api get /api/info` response proves only local loopback connectivity to the OpenCode server, not upstream proxy traversal or CA certificate trust.
