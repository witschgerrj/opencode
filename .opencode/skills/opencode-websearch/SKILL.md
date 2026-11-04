---
name: opencode-websearch
description: Config, permit, disable, query OpenCode V2 web search, provider credentials,
  failover, API contracts.
---

# OpenCode Web Search and Failover

OpenCode V2 includes built-in `websearch` capability: query external search engines, read snippets/content, cite source URLs, plus direct `@opencode/client` search endpoints.

## Boundaries with Neighbor Skills

- **Outbound `HTTP_PROXY` / `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`**: Use `opencode-network`.
- **Single-URL HTTP text retrieval (`webfetch`), Code Mode `fetch`, Desktop browser tools**: Use `opencode-tools`.
- **Ordered permission rule precedence, interactive approval replies**: Use `opencode-permissions`, `opencode-human-input`.
- **Third-party MCP search servers**: Use `opencode-mcp`.

## Core Workflow

1. **Supply search provider credentials + choose selection strategy**:
   - Connect any of 5 built-in search providers (`exa`, `firecrawl`, `parallel`, `tavily`, `tinyfish`) via `/connect` in TUI, `opencode auth login`, or server startup env vars (`EXA_API_KEY`, `FIRECRAWL_API_KEY`, `PARALLEL_API_KEY`, `TAVILY_API_KEY`, optional `TINYFISH_API_KEY`).
   - Pin `"websearch": { "provider": "tavily" }` in `opencode.json(c)` → skip first-use prompt. Or set `"websearch": { "provider": "random" }` → sticky per-session selection + auto HTTP `429` failover.
   - Read `references/websearch-contracts.md` for exact failover timing + client schemas.
2. **Scope query permissions or disable tool in offline env**:
   - Gate model searches by query text via `{ "action": "websearch", "resource": "<query-pattern>", "effect": "allow" | "ask" | "deny" }`.
   - Set `"websearch": false` in `opencode.json(c)` on air-gapped/offline servers → OpenCode omits `websearch` tool definition from model prompts (saves context tokens, prevents futile calls).
3. **Call client search ops with exact V2 fields**:
   - Discover active engines via `websearch.providers({ location })` → call `websearch.query({ query, providerID?, location })`, preserving ret `providerID`, URLs, titles, content, optional `time.published`.

## Critical Invariants and Gotchas

- **Unconfigured first search prompts interactively**: Without configured `websearch.provider` (or remembered choice), first search pauses to prompt user → stalls unattended/headless runs unless preconfigured or disabled.
- **Sticky sessions + workspace-shared 429 cooldowns**: Under `"provider": "random"`, session stays on chosen engine until provider ret HTTP `429`. Throttled provider enters **workspace-shared** cooldown for `Retry-After` duration (or **60 seconds** when absent/invalid) → OpenCode retries with another available provider. All available providers cooling down → search fails immediately.
- **Restarts and moves reset remembered providers**: Moving session location or restarting OpenCode server clears remembered search provider.
- **`websearch` permissions match query text, not URLs**: `websearch` action matches `resource` against **raw search query string** (`webfetch` matches target URL).
- **`"websearch": false` only removes `websearch` tool**: Disabling drops search tool schema from model reqs, but does **not** block `webfetch`, `shell` (`curl`), or Code Mode (`execute` `fetch`). Enforce `permissions`, `policies`, network egress controls separately for full isolation.
- **Strict client input schema**: `@opencode/client` `websearch.query` accepts only `{ query, providerID?, location? }`. Never forward foreign `domain`, `recency`, `maxResults`, date-filter fields. Do not assume `time.published` populated on every ret.
