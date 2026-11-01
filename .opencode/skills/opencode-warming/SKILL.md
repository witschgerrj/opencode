---
name: opencode-warming
description: "Configure and evaluate OpenCode V2 session `warming` (`boolean` or `{prompt, interval, duration}`), 3-slot boot prefix warming, keep-alive timer resets, transient non-mutating model calls, quiet retry semantics, and cloud prompt-cache versus single- and multi-slot local GPU trade-offs. Use for periodic provider prompt-cache keep-alive pings; use `opencode-providers` for provider cache markers/WebSockets, `opencode-session-lifecycle` for `location_idle_timeout`, and `multi-agent-inference-benchmarking` for multi-slot local KV tuning and `1..N` concurrency benchmarking."
---

# OpenCode Warming

Session warming sends periodic transient keep-alive requests while a user pauses between prompts to keep short-lived upstream provider prompt caches alive. It is **disabled by default**.

## Scope and Neighbor Boundaries

- **This skill owns**: `warming` configuration (`false`, `true`, or `{ prompt, interval, duration }`), duration validation and `interval >= duration` skip behavior, idle/window timer reset rules, transient no-history/no-tool request execution, failure retry behavior, token/rate-limit/GPU-slot trade-offs, and local host 3-slot boot prefix pre-warming (`aquanox-prefix-warmup`).
- **Use sibling skills for**:
  - `` `opencode-providers` `` and `` `opencode-models` `` — provider prompt-cache marker formats, session WebSocket prefix reuse (`settings.transport: "websocket"`), and request timeouts.
  - `` `opencode-session-lifecycle` `` — `experimental.location_idle_timeout` (unloading idle project services in OpenCode, which is completely separate from session warming).
  - `` `opencode-compaction` `` — summarizing long conversations near context limits.
  - `` `multi-agent-inference-benchmarking` `` — multi-slot (`--parallel N --kv-unified`) local KV residency, full-stack single-user concurrency tuning, and `1..N` multi-agent throughput benchmarking.

Read [warming options, timer timeline, and cost trade-offs](references/warming-timing-and-costs.md) for complete field defaults, timeline examples, and local vs cloud guidance.

## Core Configuration Workflow

1. **Enable only when targeting providers with short prompt-cache TTLs**:
   - **Boolean shorthand** (uses `interval: "4 minutes"`, `duration: "30 minutes"`, and default no-work/no-tool `"OK"` prompt -> up to **7 calls** at minutes 4, 8, 12, 16, 20, 24, 28):
     ```jsonc
     {
       "$schema": "https://opencode.ai/config.json",
       "warming": true
     }
     ```
   - **Custom object** (partial objects preserve defaults for omitted fields):
     ```jsonc
     {
       "$schema": "https://opencode.ai/config.json",
       "warming": {
         "prompt": "Do not perform any work. Reply with exactly: OK",
         "interval": "4 minutes",
         "duration": "20 minutes"
       }
     }
     ```
2. **Disable explicitly when overriding lower-precedence configs or running single- or multi-slot local inference**:
   ```jsonc
   {
     "warming": false
   }
   ```

## Key Invariants and Gotchas

- **Starts only after a real model call; warming pings never extend `duration`**:
  - Timers start only after a **non-warming** model request completes.
  - Each warming call resets the `interval` countdown for the next ping **without extending `duration`** (the active window anchored to the latest real model request).
  - Any new normal (non-warming) model activity resets **both** `interval` and `duration`.
- **`interval >= duration` silently sends zero pings**: If `interval` equals or exceeds `duration` (for example, `interval: "30 minutes"` with default `duration: "30 minutes"`), the active window expires before the first warming call fires.
- **Invalid or zero duration strings fail open**: Both `interval` and `duration` must parse to finite durations `> 0`; invalid or zero values log a server warning and **skip warming** without failing config load.
- **Zero history mutation and zero tool execution**:
  - Warming reuses the session's current model, agent, instructions, and conversation context, appends `prompt` transiently, makes **one** model call, and **discards the reply**.
  - It never admits inbox items, never writes transcript messages, never mutates durable session state, and **never dispatches local tool calls or continues tool loops**.
  - Failures are logged quietly and retried at the next `interval` while the original `duration` window keeps counting down.
- **Real token cost & local GPU contention (single-slot and `--parallel N` multi-slot)**:
  - Warming requests are real upstream API calls consuming tokens, budget, and rate limits.
  - **Disable warming (`false`) on both single-slot and multi-slot (`--parallel N --kv-unified`) local GPU servers or behind external inference schedulers**: local per-slot KV caches stay resident in VRAM across idle pauses without TTL keep-alive pings until evicted by new slot traffic, whereas background OpenCode warming pings bypass external application queues, occupy active GPU slots (especially under long provider timeouts), and trigger sequential prefill micro-batches that stall concurrent foreground agents (see `` `multi-agent-inference-benchmarking` ``)!
- **Dynamic session metadata & KV prefix cache invariance (Jinja chat template trap)**:
  - Session warming never warms the initial cold request (Step 1); warming timers start *only after* a non-warming model request finishes.
  - In chat templates where `system.content` renders *before* `\n\n## Tools` (such as DeepSeek V4.1 Flash and standard GGUF Jinja templates), placing volatile session metadata (`date` and working directory `<env>`) at the end of `system.content` (`context.ts:152-161`) invalidates `~3,000–5,000` tool-schema KV tokens on every worktree switch or calendar rollover!
  - Moving dynamic session metadata out of `<｜System｜>` into `<｜User｜>` (e.g., inside a leading `<system-reminder>` block) preserves 100% byte-for-byte invariance for `<｜System｜> + instructions + ## Tools` across all worktrees, calendar days, and sessions (see `` `opencode-instructions` ``).

- **3-Slot Boot Prefix Warming & `--cache-ram 57344` (`aquanox-prefix-warmup.service`)**:
  - On local deployments, boot pre-warming populates the `56 GiB` host RAM prompt cache (`--cache-ram 57344`, holding `~1.30M` pure-`FP16` tokens) across all 3 active slots (`id_slot: 0, 1, 2`):
    - Slot 0: `general` (`Max`, `100` effort) for the Team Lead.
    - Slot 1: `general` (`High` / `subagent-high`, `75` effort) for concurrent subagents.
    - Slot 2: `explore` (`subagent-high`, `75` effort with restricted tool schema and `"shell": "deny"`).
  - Checkpoints store full `12,827`-token system preambles, skill catalogs, and tool schemas (`~563.7 MiB`/variant = `~2.20 GiB` total, only `3.9%` of `56 GiB` `--cache-ram`).
  - Restoring a `120K+` token checkpoint from `--cache-ram 57344` takes **`9–13 s` (`~10,000–13,400 tok/s`)**, which is **`~100×` faster** than an uncached cold re-prefill (`~110–124 tok/s`, taking 28 minutes for long sessions).
- **The Reasoning Effort Invalidation Trap (`token 8` / `token ~12,934` Header Invalidation)**:
  - DeepSeek V4.1 renders `<｜System｜>Reasoning Effort: <budget>` at the beginning of the rendered prompt.
  - Preset strings map strictly to integer headers: `"low" -> 50`, `"medium" -> 62`, `"high" -> 75`, `"max" -> 100`.
  - **The Mid-Conversation Invalidation Pitfall**: Switching reasoning effort mid-conversation (e.g., changing from `High (75)` to `Max (100)` at the start of Turn 2) alters the BPE token at index 8 (or token `~12,934` in concatenated multi-turn prompts). Because KV caching relies on Longest Common Prefix (LCP), a single token mutation at index 8 **invalidates 100% of all subsequent KV cache tokens**, forcing a catastrophic full cold re-prefill of the entire conversation history (`705.80 s` in `task 29812`!).
  - **Remediation**: Schedulers and harness runners must maintain reasoning effort stability across turns (pinning Lead sessions to `Max (100)` and child subagents to `#subagent-high`).
- **The Tool Schema Prefix Invariance Rule (`request_synthesis({})` vs Removing Tools)**:
  - In OpenAI-compatible and Jinja-based local LLM APIs, tool schemas are rendered directly into the system prompt prefix (`## Tools`).
  - **The Schema-Divergence Trap**: Attempting to force a model into a final report by removing tools from the API payload changes the tool schema prefix, instantly busting the entire multi-turn KV cache!
  - **The Solution**: In subagent synthesis turns, **never remove tools from the prompt**. Instead, invoke the zero-arg `request_synthesis({})` control tool. This instructs the session runner to set `toolChoice: "none"` on the subsequent step while keeping `tools: loaded.tools` 100% identical in the request body. The model is forced to emit a structured summary or report without tools, achieving **100% KV prefix cache hits** and eliminating runaway `32,768`-token thinking cliffs.
- **Net-Token Slot Conservation in `get_available_slot()`**:
  - In `llama-server` multi-slot scheduling (`tools/server/server-context.cpp:1752`), naive LCP slot selection can allow a short incoming prompt matching only the base system prefix (`12.9K` tokens) to overwrite a slot holding a `120K+` warm multi-turn session.
  - Net-Token Slot Conservation scores slots by net retained tokens:
    $$\text{Net Tokens} = \text{lcp\_slot} - (\text{prompt\_tokens} - \text{lcp\_slot})$$
    preventing shallow prompts from cannibalizing deep slots when an idle or shallower slot exists.
- **Hierarchical Repository Foundation KV Checkpoints & Disk-Edit Coherence**:
  - For local model deployments, persistent KV caching (`--cache-ram`, vLLM prefix cache) provides a deterministic alternative to active keep-alive warming.
  - Loading repository architectural contracts and foundation schemas via workspace `opencode.json` `"instructions"` into a pre-warmed RAM pool enables non-destructive multi-slot PCIe Gen4 H2D DMA restores (`it_best->prompt.clone()` + `states.splice()`): empirically **`173.0 ms` (`30,803.5 tok/s`)** for a single-slot `5,329`-token `FP16` restore, **`575.85 ms` (`18,442.3 tok/s` aggregate)** for 2 concurrent slots restoring `5,310` tokens each, and simultaneous 3-slot fan-out restores of `7,628` tokens each (versus `43–260 s` uncached CPU prefill).
  - **2-Request Eviction-Commit Boot Pre-Warm (`server-context.cpp:1790`)**: Because `llama-server` writes KV states to `--cache-ram` **only upon slot eviction** (`f_keep < 0.50f`), a single boot warm-up HTTP request populates VRAM Slot 0 while leaving `--cache-ram` empty (`0 B`). Always execute a 2-request boot warm-up on `id_slot: 0`: Request 1 prefills the canonical foundation prefix (`max_tokens: 1`), and Request 2 sends a 16-token UUID sentinel on `id_slot: 0` (`f_keep = 0.0f < 0.50f`) to force `prompt_save(*prompt_cache)` into `--cache-ram` for all slots `0..N-1`.
  - **Disk-Edit Cache Coherence**: OpenCode reads instructions directly from disk. In Longest Common Prefix (LCP) caching engines, modifying a file diverges the token stream at the exact edited token, automatically discarding stale downstream KV states. Fast (`< 4 ms`) `git status --porcelain` or SHA-256 Merkle checks provide explicit validation.
  - **Context Attention Tax Warning**: Do not bloat `<｜System｜>` beyond **`~20K–35K` tokens**; large static prefixes incur an attention latency penalty on all subsequent turns that can erode the prefill time saved.
- **OpenCode V2 Session-Completion Polling Contract for Multi-Variant Boot Pre-Warmers**:
  - Boot pre-warmers evaluating multiple reasoning variants (`low`, `medium`, `high`, `max`) spawn ephemeral sessions per variant via `POST /api/session` and dispatch Turn 1 via `POST /api/session/{id}/prompt`.
  - **The V2 `/message` Polling Timeout Trap**: Boot pre-warmers MUST NOT poll `GET /api/session/{id}/message` looking for `m.info.role == "assistant"` or per-message `tokens.input > 0`. In OpenCode V2, message items use `"type": "user" | "assistant" | "idle"` (`content: [...]`) without a `"role"` wrapper or per-message `tokens`. V1-style pollers looking for `role` or per-message token counts hang until their client timeout (e.g. 240 s), even when the inference engine finished generation in `0.24 s`!
  - **Canonical OpenCode V2 Completion Poll**:
    1. Poll `GET /api/session/active` until the session ID disappears (`id not in resp["data"]`).
    2. Pair with `GET /api/session/{id}` (`info = resp["data"]`), verifying terminal status: `info["outcome"] in ("succeeded", "failed", "interrupted")` or `info["time"].get("idle")`.
    3. Read cumulative token metrics directly from session info: `info["tokens"]["input"]`, `info["tokens"]["output"]`, and `info["tokens"]["cache"]["read"]`.
    4. Fail fast if `info["outcome"] == "failed"`.
    5. Always delete the ephemeral warm-up session (`DELETE /api/session/{id}`) in a `finally:` block before dispatching the slot eviction-commit sentinel to the inference server.
- **Systemd `PartOf=` Coupling & `LOAD_MODE=none` Timeouts for Boot Pre-Warmers (`aquanox-prefix-warmup.service`)**:
  - A boot pre-warmer oneshot service (`Type=oneshot`, `RemainAfterExit=yes`) MUST set `PartOf=deepseek-flash.service` and `[Install] WantedBy=multi-user.target deepseek-flash.service` so restarting `deepseek-flash.service` (which clears volatile `--cache-ram`) automatically re-runs 4-variant warming.
  - Configure `TimeoutStartSec >= 1500` and service-readiness polling (`GET /health` + `GET /api/model`) `>= 720 s` when `LOAD_MODE=none` repacks `403+ GiB` of CPU MoE/Engram weights (`~500–550 s`) before `/health` responds.
- **OpenCode `tokens.reasoning` Usage Omission vs `delta.reasoning_content` & `finish_reason: "stop"` Termination**:
  - OpenCode's `mapUsage` (`openai-chat.ts`) populates `tokens.reasoning` solely from `usage.completion_tokens_details?.reasoning_tokens`. Because `llama-server` omits `completion_tokens_details.reasoning_tokens`, `tokens_reasoning` remains `0` in `opencode.db` even when `content` holds full `"type": "reasoning"` parts streamed via `delta.reasoning_content`.
  - OpenCode terminates a turn (`needsContinuation = false`, `idle_outcome = "succeeded"`) whenever `finish_reason === "stop"` arrives with `0` structured `delta.tool_calls`.
