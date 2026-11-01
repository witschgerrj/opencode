---
name: opencode-providers
description: Connect, configure, and troubleshoot OpenCode V2 model providers, credentials, custom endpoints, runtime packages, timeouts, body compression, WebSockets, cloud auth, secret macros, and generation/voice/credential APIs. Use for provider connectivity and account contracts; use opencode-models for model selection, variants, and compatibility flags, and opencode-network for HTTP proxies and CA certificates.
---

# OpenCode Providers, Credentials, and Generation APIs

OpenCode V2 connects built-in catalog providers (`models.dev`), cloud platforms, gateways, local runtimes, and custom runtime packages to power session turns and standalone text, image, decision, and voice APIs.

## Boundaries with Neighbor Skills

- **Model selection (`/models`, `--model`), `#variant` definitions, `capabilities.reasoning`, and `compatibility` flags**: Use `opencode-models`.
- **Outbound `HTTP_PROXY` / `HTTPS_PROXY`, `NO_PROXY`, and `NODE_EXTRA_CA_CERTS`**: Use `opencode-network`.
- **Hard provider allow/deny rules (`provider.use` policies)**: Use `opencode-policies`.
- **Context compaction token budgets (`compaction.keep` / `buffer`)**: Use `opencode-compaction`.

## Core Workflow

1. **Authenticate and verify provider activation**:
   - Connect accounts interactively via `/connect` in the TUI or `opencode auth login [provider] [--method key|<id>]` in the CLI, or supply server-process environment variables / cloud credential chains (Azure Entra CLI, AWS Bedrock chain, Google Vertex ADC, GitHub Copilot device OAuth).
   - Inspect `opencode auth list` or `@opencode/client` `provider.list({ location })` (`ProviderInfo.activation`: `"auto" | "enabled" | "disabled"`). Saved SQLite accounts take precedence over `environment` variables for the same integration.
   - Read [cloud authentication, account CLI, and client generation/credential contracts](references/client-and-cloud-auth.md) for Azure, Bedrock, Vertex, Copilot, OpenRouter, and standalone APIs.
2. **Configure custom providers, endpoints, timeouts, encoding, and WebSockets**:
   - Define or override providers under `"providers"` in `opencode.json(c)` with `package`, `canonical`, `env`, `settings` (`baseURL`, `headerTimeout`, `chunkTimeout`, `timeout`, `encoding`, `transport`, `compaction`), `headers`, `body`, and `models`.
   - Reference secrets via `{env:VAR_NAME}` or `{file:path/to/secret}` macros inside JSON strings—never commit raw API keys.
   - Read [provider configuration, packages, timeouts, compression, WebSockets, and error diagnosis](references/providers-config.md) before changing transport settings.

## Critical Invariants and Gotchas

- **Three automatic retries multiply long timeouts**: HTTP requests default to `headerTimeout: 300000` (5 min) and `chunkTimeout: 900000` (15 min; 30 min on WebSockets), with `timeout` unset. Timed-out requests automatically retry **up to 3 times** (4 total attempts), multiplying large custom timeout values.
- **Request body compression breaks most gateways and local servers**: `settings.encoding` supports `"zstd"`, `"gzip"`, or `"none"`. OpenAI defaults to `"zstd"` on ChatGPT sign-in without a custom `baseURL` (API keys send `"none"`). Explicitly set `"encoding": "none"` when routing through proxies or local servers that do not decode compressed request bodies.
- **ChatGPT plan sign-ins apply default context caps**: Signing in with ChatGPT Plus/Pro caps usable input limits (`500,000` tokens for GPT-6.1 Sol and newer; `272,000` for older models) to preserve plan quota. Opt out with `"plugins": ["-opencode.provider.openai-context-caps"]`.
- **Missing `{env:...}` and `{file:...}` macros expand silently to `""`**: Unset environment macros or missing secret files evaluate to empty strings without syntax errors, whereas an unresolved `${NAME}` template inside `baseURL` fails initialization with `NAME is required to resolve the provider endpoint`.
- **Cloud activation prerequisites**: Vertex requires **both** ADC and a resolvable project (`settings.project` or `GOOGLE_CLOUD_PROJECT`); Bedrock requires a credential source (`profile`, `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, web identity, container URI, or `AWS_BEARER_TOKEN_BEDROCK`—`AWS_REGION` alone never activates it); Azure requires `settings.resourceName` (or `AZURE_RESOURCE_NAME` / complete `baseURL`).
- **Retired V1 provider IDs fail directly**: Replace `azure-cognitive-services/*` with `azure/*` and `google-vertex-anthropic/*` with `google-vertex/*`. Also note `credential.update` changes an account `label` only—never treat it as a secret PATCH endpoint.
