---
name: opencode-providers
description: Configure troubleshoot OpenCode V2 model providers credentials endpoints
  timeouts WebSockets cloud auth secret macros APIs
---

# OpenCode Providers, Credentials, and Generation APIs

OpenCode V2 connects catalog providers (`models.dev`), cloud platforms, gateways, local runtimes, custom runtime packages. Powers session turns, standalone text, image, decision, voice APIs.

## Boundaries Neighbor Skills

- **Model selection (`/models`, `--model`), `#variant` defs, `capabilities.reasoning`, `compatibility` flags**: Use `opencode-models`.
- **Outbound `HTTP_PROXY` / `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`**: Use `opencode-network`.
- **Hard provider allow/deny rules (`provider.use` policies)**: Use `opencode-policies`.
- **Context compaction token budgets (`compaction.keep` / `buffer`)**: Use `opencode-compaction`.

## Core Workflow

1. **Auth and verify provider activation**:
   - Connect accounts via `/connect` in TUI or `opencode auth login [provider] [--method key|<id>]` in CLI, or pass server proc env vars / cloud credential chains (Azure Entra CLI, AWS Bedrock chain, Google Vertex ADC, GitHub Copilot device OAuth).
   - Inspect `opencode auth list` or `@opencode/client` `provider.list({ location })` (`ProviderInfo.activation`: `"auto" | "enabled" | "disabled"`). Saved SQLite accounts take precedence over `environment` vars for same integration.
   - Read `references/client-and-cloud-auth.md` for Azure, Bedrock, Vertex, Copilot, OpenRouter, standalone APIs.
2. **Config custom providers, endpoints, timeouts, encoding, WebSockets**:
   - Define/override providers under `"providers"` in `opencode.json(c)` with `package`, `canonical`, `env`, `settings` (`baseURL`, `headerTimeout`, `chunkTimeout`, `timeout`, `encoding`, `transport`, `compaction`), `headers`, `body`, `models`.
   - Reference secrets via `{env:VAR_NAME}` or `{file:path/to/secret}` macros inside JSON strings—never commit raw API keys.
   - Read `references/providers-config.md` before changing transport settings.

## Critical Invariants and Gotchas

- **3 auto retries multiply long timeouts**: HTTP reqs default `headerTimeout: 300000` (5 min), `chunkTimeout: 900000` (15 min; 30 min on WebSockets), `timeout` unset. Timed-out reqs retry auto **up to 3 times** (4 total attempts) → multiplies large custom timeout values.
- **Req body compression breaks gateways and local servers**: `settings.encoding` supports `"zstd"`, `"gzip"`, `"none"`. OpenAI defaults `"zstd"` on ChatGPT sign-in without custom `baseURL` (API keys send `"none"`). Explicitly set `"encoding": "none"` when routing via proxies/local servers lacking compression decode.
- **ChatGPT plan sign-in applies default ctx caps**: ChatGPT Plus/Pro caps input (`500,000` tokens for GPT-6.1 Sol and newer; `272,000` for older models) to preserve quota. Opt out: `"plugins": ["-opencode.provider.openai-context-caps"]`.
- **Missing `{env:...}` and `{file:...}` macros expand silently to `""`**: Unset env macros or missing secret files evaluate empty string without err. Unresolved `${NAME}` template in `baseURL` fails init: `NAME is required to resolve the provider endpoint`.
- **Cloud activation prereqs**:
  - Vertex reqs **both** ADC and resolvable project (`settings.project` or `GOOGLE_CLOUD_PROJECT`).
  - Bedrock reqs credential source (`profile`, `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, web identity, container URI, or `AWS_BEARER_TOKEN_BEDROCK`—`AWS_REGION` alone never activates).
  - Azure reqs `settings.resourceName` (or `AZURE_RESOURCE_NAME` / complete `baseURL`).
- **Retired V1 provider IDs fail directly**: Replace `azure-cognitive-services/*` → `azure/*`, `google-vertex-anthropic/*` → `google-vertex/*`. `credential.update` changes account `label` only—never secret PATCH endpoint.
