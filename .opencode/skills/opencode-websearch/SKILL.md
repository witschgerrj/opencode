---
name: opencode-websearch
description: Configure, permit, disable, and query OpenCode V2 web search across built-in search providers, random rate-limit failover, workspace cooldowns, and websearch API contracts. Use for the websearch tool, search provider credentials, HTTP 429 failover, and query-text permissions; use opencode-network for HTTP proxies and CA certificates, and opencode-tools for webfetch or browser tools.
---

# OpenCode Web Search and Failover

OpenCode V2 includes a built-in `websearch` capability that queries external search engines, reads snippets/content, and cites source URLs in responses, plus direct `@opencode/client` search endpoints.

## Boundaries with Neighbor Skills

- **Outbound `HTTP_PROXY` / `HTTPS_PROXY`, `NO_PROXY`, and `NODE_EXTRA_CA_CERTS`**: Use `opencode-network`.
- **Single-URL HTTP text retrieval (`webfetch`), Code Mode `fetch`, and Desktop browser tools**: Use `opencode-tools`.
- **Ordered permission rule precedence and interactive approval replies**: Use `opencode-permissions` and `opencode-human-input`.
- **Third-party MCP search servers**: Use `opencode-mcp`.

## Core Workflow

1. **Supply search provider credentials and choose a selection strategy**:
   - Connect any of the 5 built-in search providers (`exa`, `firecrawl`, `parallel`, `tavily`, or `tinyfish`) via `/connect` in the TUI, `opencode auth login`, or server startup environment variables (`EXA_API_KEY`, `FIRECRAWL_API_KEY`, `PARALLEL_API_KEY`, `TAVILY_API_KEY`, optional `TINYFISH_API_KEY`).
   - Pin `"websearch": { "provider": "tavily" }` in `opencode.json(c)` to skip the first-use provider prompt, or set `"websearch": { "provider": "random" }` for sticky per-session selection with automatic HTTP `429` failover.
   - Read [search providers, rate-limit cooldowns, permissions, and wire contracts](references/websearch-contracts.md) for exact failover timing and client schemas.
2. **Scope query permissions or disable the tool in offline environments**:
   - Gate model searches by query text using `{ "action": "websearch", "resource": "<query-pattern>", "effect": "allow" | "ask" | "deny" }`.
   - Set `"websearch": false` in `opencode.json(c)` on air-gapped or offline servers so OpenCode omits the `websearch` tool definition from model prompts entirely (saving context tokens and preventing futile tool calls).
3. **Call client search operations with exact V2 fields**:
   - Discover active engines via `websearch.providers({ location })` before calling `websearch.query({ query, providerID?, location })`, preserving returned `providerID`, URLs, titles, content, and optional `time.published`.

## Critical Invariants and Gotchas

- **Unconfigured first search prompts interactively**: Without a configured `websearch.provider` (or prior remembered choice), the first search pauses to ask the user to allow search and pick a provider—stalling unattended or headless runs unless preconfigured or disabled.
- **Sticky sessions and workspace-shared 429 cooldowns**: Under `"provider": "random"`, a session stays on its chosen engine until that provider returns HTTP `429`. The throttled provider enters a **workspace-shared** cooldown for its `Retry-After` duration (or **60 seconds** when absent/invalid) while OpenCode retries with another available provider; if *every* available provider is cooling down, the search fails immediately.
- **Restarts and moves reset remembered providers**: Moving a session to another location or restarting the OpenCode server clears the session's remembered search provider.
- **`websearch` permissions match query text, not URLs**: The `websearch` action matches `resource` against the **raw search query string** (whereas `webfetch` matches the target URL).
- **`"websearch": false` only removes the `websearch` tool**: Disabling `websearch` drops the search tool schema from model requests, but does **not** block `webfetch`, `shell` (`curl`), or Code Mode (`execute` `fetch`); enforce `permissions`, `policies`, and network egress controls separately when full isolation is required.
- **Strict client input schema**: `@opencode/client` `websearch.query` accepts only `{ query, providerID?, location? }`—never forward foreign `domain`, `recency`, `maxResults`, or date-filter fields, and do not assume `time.published` is populated on every result.
