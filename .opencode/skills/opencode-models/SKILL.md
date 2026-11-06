---
name: opencode-models
description: Select config troubleshoot OpenCode V2 models variants reasoning metadata
  aliases API compatibility flags discovery catalog wire contracts.
---

# OpenCode Models, Variants, Compatibility

OpenCode V2 builds project-scoped model catalog: merges `models.dev` metadata, active provider integrations, local runtime discovery, `opencode.json(c)` overrides.

## Boundaries With Neighbor Skills

- **Provider auth (`/connect`, `opencode auth`), custom endpoints, timeouts, retries, body encoding, WebSockets, standalone generation/voice APIs**: Use `opencode-providers`.
- **Agent model prefs (`agents.<id>.model`)**: Use `opencode-agents`.
- **Command model overrides/precedence**: Use `opencode-commands`.
- **Session creation or switching active session model**: Use `opencode-session-lifecycle`.

## Core Workflow

1. **Discover project-scoped availability**:
   - Query `/models` in TUI or `model.list({ location, types })` and `model.default({ location })` via `@opencode/client` for target working dir.
   - Availability location-scoped: model visible only when `disabled: false`, `type` matches (`"chat"` interactive sessions), provider active in project.
   - Pair `providerID`, catalog model `id`, optional `#variant` (`provider/model#variant`). Never use display `name` or upstream wire `modelID` as selection key.
   - Client UIs and catalog resolvers normalize case-insensitive shorthand aliases (`"med" -> "medium"`, `"deep" -> "high"`) against canonical variant IDs from `GET /api/model`.
2. **Config defaults, variants, reasoning controls**:
   - Set top-level `"model": "provider/model"` for new sessions, `--model provider/model#variant` for one-off `opencode run`, or agent/command `model` fields.
   - Define custom `variants` arrays (`settings`, `headers`, `body`) or auto-generate package variants from `capabilities.reasoning` (`supported`, `toggle`, `effort`: `["low", "medium", "high", "max"]`, `budget`).
   - Read `references/models-reference.md` for merge order and schema details.
3. **Set explicit capabilities, limits, API compatibility**:
   - Custom or proxied models: declare `capabilities` (`tools`, `input`, `output`), `limit` (`context`, `input`, `output`), `compatibility` flags (`reasoningField`, `requireReasoning`, `maxTokensField`, `cacheFormat`).

## Critical Invariants and Gotchas

- **Root `model` drops `#variant`**: Top-level `"model"` in `opencode.json(c)` retains only `provider` and `model` for catalog default. Attach `#variant` on session, `opencode run --model`, `agents.<id>.model`, or `commands.<id>.model`.
- **Three model ID key names across layers**:
  - Config selector objects (`model` in root/agent/command): `{ providerID, model, variant? }`.
  - Provider catalog config (`providers.<p>.models.<key>`): `<key>` = selectable ID, `modelID` = upstream wire model/deployment name.
  - Runtime client `ModelRef` payloads: `{ providerID, id, variant? }`.
- **Optimistic fallbacks on unknown custom models**: Unknown model ID not in `models.dev` defaults to `tools: true`, `input: ["text", "image"]`, `output: ["text"]`, `limit.context: 200000`, `limit.output: 32000`. Override `capabilities` and `limit` explicitly to prevent sending image payloads or oversized prompts to text-only/small-context servers.
- **vLLM auto-discovery disables tools and vision**: Unlike Ollama and LM Studio, vLLM `/v1/models` omits `--enable-auto-tool-choice` and `--tool-call-parser`. Auto-discovered `vllm/*` models init with `tools: false` and text-only modalities unless overridden in config.
- **Free-model server disablement**: `OPENCODE_DISABLE_FREE_MODELS=1` (or `true`) on server proc hides zero-input-cost `opencode` and `opencode-go` models from catalogs and defaults. Explicit selection throws `Model unavailable`.
- **In-flight turns survive live reloads**: Config edits reload automatically; active running req completes with init settings. Switching session model in UI/TUI never mutates `opencode.json(c)`.
- **Causal Reasoning Budget Floor (`Math.max(budget, 50)`) & Expanded Causal Regex**:
  - Explanatory/causal/diagnostic prompts matched by `/\b(why|because|cause|reason|explain|how does|how do|root cause|investigate|diagnose|analyze)\b/i` enforce reasoning budget floor `Math.max(budget, 50)` (`2,048`-tok thinking ceiling), preventing `minimal` (`0`) variant from bypassing thinking on causal/diagnostic queries.
  - **Tail-of-System KV Checkpointing (`pre_effort_sys_pos`)**: `Reasoning Effort: {budget}` renders at tail of `<｜System｜>` right before `<｜User｜>` → dynamically lifting budget to `50` preserves 100% of preceding static `<｜System｜>` + `<tools>` KV prefix cache (`<0.05s` prefill).
- **Reasoning effort, temperature, budget calibration**:
  - High reasoning effort (`variant: "high"`, `effort=75`) + `temperature: 1.0` + `effective_drop = false` on tool sessions → `1,200–2,166`-token `<think>` spirals on simple bash/write/inspection steps.
  - Pair `"low"`/`"medium"` effort + `temperature: 0.2–0.3` + `--reasoning-budget 256` → bounds `<think>` output, cuts decode latency `>85%`. Pair `--reasoning-budget 256` with `--reasoning-budget-message ""` (zero token injection).
  - **4-Tier reasoning effort scale**: 4 tiers (`"low"`, `"medium"`, `"high"`, `"max"`). `@opencode/ai/providers/openai-compatible` forwards string to wire `reasoning_effort` (`"low"=50`, `"medium"=62`, `"high"=75`, `"max"=100` in DeepSeek V4.1 Jinja templates).
  - **`body.reasoning_budget_tokens: -1` sentinel collision trap**: Per-variant `body: { "reasoning_budget_tokens": -1 }` on `llama-server`: verify upstream treats explicit `-1` as unlimited. If unpatched (`json_value(body, "reasoning_budget_tokens", -1) == -1 -> opt.reasoning_budget`), explicit `-1` collides with missing-key sentinel → clamps thinking to CLI default (`--reasoning-budget 256`). Server parser must check key existence via `body.contains("reasoning_budget_tokens")`.
  - **Preset string vs numeric string HTTP `500` trap**: DeepSeek V4.1 Jinja templates reject numeric strings `"50"` / `"62"` with HTTP `500`. `llama-server` C++ JSON logging (`deepseek.cpp:125`) rejects raw integers (`type_error.302`). Pass preset strings `"low"`, `"medium"`, `"high"`, `"max"` (verify `common/parsers/deepseek.cpp:121` maps `"medium"` to `"medium"`, not `nullptr` which defaults to `"high"` 75).
  - **Jinja template tool continuity (`effective_drop = false`)**: DeepSeek V4.1 Flash `effective_drop = drop_thinking and not state.has_tools` retains `<think>` blocks across tool steps → 100% intra-session KV prefix cache reuse (`f_keep = 1.000`). Mutating or stripping prior assistant `<think>` blocks invalidates KV cache.
  - **4-Variant single-token (`index 8`) Jinja prefix geometry & `last_user_pos` checkpoints**: 4 DeepSeek V4.1 variants (`"low" -> 50`, `"medium" -> 62`, `"high" -> 75`, `"max" -> 100`) render byte-identical Jinja prefixes except single BPE token at index `8`. Shares `<｜System｜>` (`[0..last_user_pos-1]`) and same-day/same-dir `<｜User｜><system-reminder>...</system-reminder>\n\n` via `llama-server` `last_user_pos` checkpoint (`LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY` on `llama_kv_cache_dsv4` where `seq_pos_min() == seq_pos_max()`; see `opencode-warming`).
- **OpenAI Chat `mapUsage` `tokens.reasoning = 0` omission & `finish_reason: "stop"` termination**:
  - `openai-chat.ts` `mapUsage` reads `usage.completion_tokens_details?.reasoning_tokens`. `llama-server` omits `completion_tokens_details.reasoning_tokens` → `tokens_reasoning` records `0` in `opencode.db` even when `content` stores `"type": "reasoning"` via `delta.reasoning_content`.
  - Assistant turn finalizes (`needsContinuation = false`, `idle_outcome = "succeeded"`) when `finish_reason === "stop"` arrives with `0` structured `delta.tool_calls` (including when model emits raw XML `<tool_call>` / `<tool_input>` / `<parameter>` in `delta.content` instead of native `<｜DSML｜function_calls>`).
- **`3 × 384K` (`393,216` tok/agent) schema & calibrated variants**:
  - Production DeepSeek-V4.1-Flash config: `limit: { context: 393216, output: 32768 }`, aligns with `--parallel 3` (`1,179,648` unified `FP16` KV cells).
  - Active calibrated variants:
    - `#max`: `effort: "max"` (100), `reasoning_budget_tokens: 12288` (orchestrator exploration, architecture).
    - `#high`: `effort: "high"` (75), `reasoning_budget_tokens: 8192` (standard dev turns).
    - `#subagent-high`: `effort: "high"` (75), `reasoning_budget_tokens: 4096` (bounded subagent exec).
- **HTTP body forwarding trap (`openai-chat.ts:774` vs `http.ts:35-41`)**: Custom `llama-server` fields (`id_slot`, dynamic per-step `reasoning_budget_tokens`) stripped by AI SDK OpenAI provider (`openai-chat.ts:774`) if passed via `providerOptions`. Merge custom params into `request.http.body` in `packages/ai/src/route/transport/http.ts:35-41` (`{ ...parsed, ...request.http.body }`).
- **Child `#max` inheritance & multi-slot pinning (`subagent.ts:187`)**: Spawning child subagent without override inherited Root `#max` (`-1` unbounded `<think>`) → runaway `32,768`-token `finish="length"` cliffs. `subagent.ts:187` defaults child spawns (`!!parentID`) to `#subagent-high` (fallback `#high`, effort 75). Root pinned to `id_slot: 0`, leases `id_slot: 1, 2` across concurrent children to eliminate cross-slot KV eviction.
- **Concurrent decode reasoning budget cap (`S05`) & dual-home config**:
  - Under 3-stream concurrent decode (`~9.4–12.5 t/s` per slot), uncapped `2048` reasoning budget causes sessions to spend `130–170s` drafting rough essays inside `<think>`. Live reconciled reasoning budgets are capped in `llm.ts:capLiveReconciledReasoningBudget` to **`512` Lead turn-entry**, **`256` Lead continuation**, and **`384` Subagent**, eliminating 200s+ turn timeouts.
  - Always sync config updates (`opencode.json`) to `/var/lib/aquanox-runner/home/.config/opencode/opencode.json` in addition to `/home/rjwits/.config/opencode/opencode.json` because `aquanox-opencode.service` runs with `HOME=/var/lib/aquanox-runner/home`.
- **Historical `reasoning` prefix immutability (`to-llm-message.ts:156-184`)**: Stripping `{ type: "reasoning" }` from `sameModel` errored/interrupted turns shifts token offsets → clears `llama_kv_cache_dsv4` SWA ring buffers (`cache = 0`). Preserve `{ type: "reasoning" }` on `sameModel` turns to guarantee `f_keep = 1.000` KV prefix reuse.
