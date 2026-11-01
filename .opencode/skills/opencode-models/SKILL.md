---
name: opencode-models
description: Select, configure, and troubleshoot OpenCode V2 models, variants, structured reasoning metadata, aliases, API compatibility flags, local discovery, and model catalog wire contracts. Use for model capabilities, limits, variants, and compatibility quirks; use opencode-providers for provider authentication, endpoints, timeouts, compression, and generation APIs.
---

# OpenCode Models, Variants, and Compatibility

OpenCode V2 builds a project-scoped model catalog by combining `models.dev` metadata, active provider integrations, local runtime discovery, and `opencode.json(c)` overrides.

## Boundaries with Neighbor Skills

- **Provider authentication (`/connect`, `opencode auth`), custom endpoints, timeouts, retries, body encoding, WebSockets, and standalone generation/voice APIs**: Use `opencode-providers`.
- **Agent-specific model preferences (`agents.<id>.model`)**: Use `opencode-agents`.
- **Command-level model overrides and precedence**: Use `opencode-commands`.
- **Creating sessions or switching an active session's model**: Use `opencode-session-lifecycle`.

## Core Workflow

1. **Discover project-scoped availability before selecting**:
   - Query `/models` in the TUI or `model.list({ location, types })` and `model.default({ location })` via `@opencode/client` for the target working directory.
   - Availability is strictly location-scoped: a model appears only when not `disabled: true`, its `type` matches (`"chat"` for interactive sessions), and its provider is active in that project.
   - Keep `providerID`, catalog model `id`, and optional `#variant` together (`provider/model#variant`). Never use display `name` or upstream wire `modelID` as a selection key.
   - Client UIs and catalog resolvers should normalize case-insensitive shorthand aliases (e.g. `"med" -> "medium"`, `"deep" -> "high"`) against the canonical variant IDs returned by `GET /api/model`.
2. **Configure defaults, variants, and reasoning controls**:
   - Set top-level `"model": "provider/model"` for new sessions, `--model provider/model#variant` for one-off `opencode run` invocations, or agent/command `model` fields for scoped variants.
   - Define custom `variants` arrays (`settings`, `headers`, `body`) or auto-generate package variants from `capabilities.reasoning` (`supported`, `toggle`, `effort`: `["low", "medium", "high", "max"]`, `budget`).
   - Read [model configuration, compatibility, local discovery, and wire contracts](references/models-reference.md) for exact merging order and schema details.
3. **Set explicit capabilities, limits, and API compatibility for custom or proxied models**:
   - Declare real `capabilities` (`tools`, `input`, `output`), `limit` (`context`, `input`, `output`), and `compatibility` flags (`reasoningField`, `requireReasoning`, `maxTokensField`, `cacheFormat`, etc.) whenever adding custom models or routing through OpenAI-compatible proxies.

## Critical Invariants and Gotchas

- **Root `model` silently drops `#variant`**: Top-level `"model"` in `opencode.json(c)` retains only `provider` and `model` for the catalog default. Attach `#variant` on a session, `opencode run --model`, `agents.<id>.model`, or `commands.<id>.model` instead.
- **Three distinct model ID key names across layers**:
  - Config selector objects (`model` in root/agent/command) use `{ providerID, model, variant? }`.
  - Provider catalog config (`providers.<p>.models.<key>`) uses `<key>` as the selectable ID and `modelID` for the upstream wire model/deployment name.
  - Runtime client `ModelRef` payloads use `{ providerID, id, variant? }`.
- **Optimistic fallbacks on unknown custom models**: If a model ID is not in `models.dev`, OpenCode assumes `tools: true`, `input: ["text", "image"]`, `output: ["text"]`, `limit.context: 200000`, and `limit.output: 32000`. Always override `capabilities` and `limit` explicitly so text-only or smaller-context servers do not receive unsupported image payloads or oversized prompts.
- **vLLM auto-discovery disables tools and vision**: Unlike Ollama and LM Studio, vLLM `/v1/models` does not expose `--enable-auto-tool-choice` or `--tool-call-parser`, so auto-discovered `vllm/*` models start with `tools: false` and text-only modalities unless overridden in config.
- **Free-model server disablement**: Setting `OPENCODE_DISABLE_FREE_MODELS=1` (or `true`) on the server process hides zero-input-cost `opencode` and `opencode-go` models from catalogs and defaults, failing explicit selection with `Model unavailable`.
- **In-flight turns survive live reloads**: Config edits reload automatically, but an already-running model request finishes with the settings it started with. Switching a session's model in UI/TUI never rewrites `opencode.json(c)`.
- **Reasoning effort, temperature & budget calibration (4-tier envelope & sentinel collision trap)**:
  - Running high reasoning effort (`variant: "high"`, `effort=75`) with `temperature: 1.0` and `effective_drop = false` on tool-enabled sessions triggers `1,200–2,166`-token `<think>` spirals on simple bash/write/inspection steps.
  - Pairing `"low"`/`"medium"` effort with `temperature: 0.2–0.3` and `--reasoning-budget 256` bounds `<think>` output and cuts reasoning decode latency by `>85%` without sacrificing synthesis quality. Always pair `--reasoning-budget 256` with `--reasoning-budget-message ""` to inject zero extra tokens.
  - **4-Tier reasoning effort scale**: Support 4 calibrated tiers (`"low"`, `"medium"`, `"high"`, `"max"`). `@opencode/ai/providers/openai-compatible` forwards arbitrary `reasoningEffort` strings unchanged to the wire request `reasoning_effort` (`"low"=50`, `"medium"=62`, `"high"=75`, `"max"=100` on DeepSeek V4.1 Jinja templates).
  - **Critical `body.reasoning_budget_tokens: -1` sentinel collision pitfall**: When configuring per-variant `body: { "reasoning_budget_tokens": -1 }` for unrestricted `high` and `max` modes against `llama-server`, verify that the upstream `llama-server` handles explicit `-1` in `body` as "unlimited" rather than colliding with its missing-key fallback sentinel (`json_value(body, "reasoning_budget_tokens", -1) == -1 -> opt.reasoning_budget`). An unpatched server mistakenly treats explicit `-1` as missing and falls back to the server CLI default (`--reasoning-budget 256`), silently clamping `high` and `max` thinking to 256 tokens! The server parser must explicitly check key existence (`body.contains("reasoning_budget_tokens")`) to honor `-1` as unlimited.
  - **Preset string vs numeric string HTTP `500` trap**: DeepSeek V4.1 Jinja templates reject numeric strings `"50"` / `"62"` with HTTP `500` while `llama-server` C++ JSON logging (`deepseek.cpp:125`) rejects raw integers with `type_error.302: type must be string, but is number`—always pass preset strings `"low"`, `"medium"`, `"high"`, or `"max"` (and ensure `common/parsers/deepseek.cpp:121` maps `"medium"` to `"medium"` rather than `nullptr`, which silently defaults to `"high"` 75).
  - **Jinja template tool continuity (`effective_drop = false`)**: In DeepSeek V4.1 Flash, `effective_drop = drop_thinking and not state.has_tools` retains prior `<think>` blocks across tool steps. Preserving this retains 100% intra-session KV prefix cache reuse (`f_keep = 1.000`), whereas mutating or stripping prior assistant `<think>` blocks invalidates the KV cache.
  - **4-Variant single-token (`index 8`) Jinja prefix geometry & `last_user_pos` checkpoints**: Across OpenCode's 4 calibrated DeepSeek V4.1 variants (`"low" -> 50`, `"medium" -> 62`, `"high" -> 75`, `"max" -> 100`), rendered Jinja prefixes are byte-identical except for a **single BPE token at index `8`**, sharing `<｜System｜>` (`[0..last_user_pos-1]`) plus same-day/same-directory `<｜User｜><system-reminder>...</system-reminder>\n\n` via `llama-server`'s `last_user_pos` context checkpoint (`LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY` on `llama_kv_cache_dsv4` where `seq_pos_min() == seq_pos_max()`; see `` `opencode-warming` ``).
- **OpenAI Chat `mapUsage` `tokens.reasoning = 0` omission & `finish_reason: "stop"` turn termination**:
  - OpenCode's `mapUsage` (`openai-chat.ts`) populates `tokens.reasoning` from `usage.completion_tokens_details?.reasoning_tokens`. Because `llama-server` omits `completion_tokens_details.reasoning_tokens`, `tokens_reasoning` records `0` in `opencode.db` even when `content` stores full `"type": "reasoning"` parts captured via `delta.reasoning_content`.
  - OpenCode finalizes an assistant turn (`needsContinuation = false`, `idle_outcome = "succeeded"`) whenever `finish_reason === "stop"` arrives with `0` structured `delta.tool_calls` (including when a misconfigured or corrupt-KV model emits raw `<tool_call>` / `<tool_input>` / `<parameter>` XML in `delta.content` instead of native `<｜DSML｜function_calls>` parsed into `delta.tool_calls`).
- **`3 × 384K` (`393,216` tok/agent) model schema & calibrated variants**:
  - Production DeepSeek-V4.1-Flash configuration uses `limit: { context: 393216, output: 32768 }` aligned with `--parallel 3` (`1,179,648` unified pure-`FP16` KV cells).
  - Active calibrated variants:
    - `#max`: `effort: "max"` (100), `reasoning_budget_tokens: 12288` (for lead orchestrator exploration and architecture synthesis).
    - `#high`: `effort: "high"` (75), `reasoning_budget_tokens: 8192` (standard high-reasoning development turns).
    - `#subagent-high`: `effort: "high"` (75), `reasoning_budget_tokens: 4096` (bounded subagent execution).
- **HTTP body forwarding trap (`openai-chat.ts:774` vs `http.ts:35-41`)**: Custom `llama-server` fields (such as `id_slot` for multi-slot affinity and dynamic per-step `reasoning_budget_tokens`) are silently stripped by the AI SDK OpenAI provider (`openai-chat.ts:774`) if passed via `providerOptions`. To ensure they reach `llama-server`, custom parameters **must** be merged into `request.http.body` in `packages/ai/src/route/transport/http.ts:35-41` (`{ ...parsed, ...request.http.body }`).
- **Child `#max` inheritance & multi-slot pinning (`subagent.ts:187`)**: Spawning a child subagent without an explicit override previously inherited the Root session's `#max` variant (`-1` unbounded `<think>`), triggering runaway `32,768`-token `finish="length"` cliffs. `subagent.ts:187` defaults child spawns (`!!parentID`) to `#subagent-high` (falling back to `#high`, both effort 75), while pinning Root to `id_slot: 0` and leasing `id_slot: 1, 2` across concurrent children to eliminate cross-slot KV eviction.
- **Historical `reasoning` prefix immutability (`to-llm-message.ts:156-184`)**: Stripping `{ type: "reasoning" }` from `sameModel` errored/interrupted turns mutates token offsets and wipes `llama_kv_cache_dsv4` SWA ring buffers (`cache = 0`). Always preserve `{ type: "reasoning" }` on `sameModel` turns to guarantee `f_keep = 1.000` KV prefix reuse.
