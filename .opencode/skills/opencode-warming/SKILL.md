---
name: opencode-warming
description: Configure evaluate OpenCode session warming keep-alive pings transient
  calls boot prefix cache
---

# OpenCode Warming

Session warming sends periodic transient keep-alive reqs during user idle pauses to maintain upstream provider prompt caches. Disabled by default.

## Scope & Boundaries

- **Owns**: `warming` config (`false`, `true`, `{ prompt, interval, duration }`), duration validation, `interval >= duration` skip, idle/window timer resets, transient no-history/no-tool exec, failure retries, token/rate-limit/GPU-slot trade-offs, 3-slot boot prefix pre-warming (`aquanox-prefix-warmup`).
- **Sibling skills**:
  - `opencode-providers`, `opencode-models`: provider cache marker formats, WebSocket prefix reuse (`settings.transport: "websocket"`), timeouts.
  - `opencode-session-lifecycle`: `experimental.location_idle_timeout` (unload idle project services, independent of session warming).
  - `opencode-compaction`: summarize long conversations near ctx limits.
  - `multi-agent-inference-benchmarking`: multi-slot (`--parallel N --kv-unified`) local KV residency, concurrency tuning, `1..N` throughput benchmarks.

Read `references/warming-timing-and-costs.md` for field defaults, timelines, cloud vs local guidance.

## Core Config

1. **Enable for short provider prompt-cache TTLs**:
   - **Boolean shorthand** (`interval: "4 minutes"`, `duration: "30 minutes"`, default `"OK"` prompt → up to 7 calls at minutes 4, 8, 12, 16, 20, 24, 28):
     ```jsonc
     {
       "$schema": "https://opencode.ai/config.json",
       "warming": true
     }
     ```
   - **Custom object** (partial objects preserve defaults):
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
2. **Disable explicitly for local inference / override lower precedence**:
   ```jsonc
   {
     "warming": false
   }
   ```

## Key Invariants & Gotchas

- **Starts post-real-call; pings never extend `duration`**:
  - Timers start only after non-warming model req finishes.
  - Warming ping resets `interval` countdown; does NOT extend `duration` (window anchored to latest real req).
  - New normal model activity resets both `interval` and `duration`.
- **`interval >= duration` sends 0 pings**: Window expires before first ping fires.
- **Invalid/zero duration strings fail open**: `interval` and `duration` must parse to finite durations `> 0`. Invalid/zero logs server warning → skips warming → config load succeeds.
- **Zero history mutation & zero tool exec**:
  - Reuses session model, agent, instructions, ctx; transiently appends `prompt`; makes 1 model call; discards reply.
  - Never touches inbox, never writes transcript, never dispatches local tools, never continues tool loops.
  - Failures logged quietly; retry scheduled at next `interval` while `duration` counts down.
- **Token cost & local GPU contention**:
  - Warming reqs consume real tokens, budget, rate limits.
  - Disable (`warming: false`) on single-slot and multi-slot (`--parallel N --kv-unified`) local GPU or behind external schedulers: local per-slot KV caches stay in VRAM across idle pauses without keep-alives. Background pings bypass app queues, monopolize GPU slots, trigger sequential prefill stalls.
- **Dynamic metadata & KV prefix invariance (Jinja template trap)**:
  - Warming does not warm initial cold req (Turn 1).
  - Templates rendering `system.content` before `\n\n## Tools` (DeepSeek V4.1 Flash, GGUF Jinja): putting volatile metadata (`date`, working dir `<env>`) at end of `system.content` (`context.ts:152-161`) busts `~3,000–5,000` tool-schema KV tokens on worktree switch or day rollover.
  - Move dynamic metadata from `<｜System｜>` to `<｜User｜>` (e.g. leading `<system-reminder>`) → preserves 100% byte invariance for `<｜System｜> + instructions + ## Tools` across sessions (`opencode-instructions`).
- **3-Slot Boot Prefix Warming & `--cache-ram 57344` (`aquanox-prefix-warmup.service`)**:
  - Populates 56 GiB host RAM prompt cache (`--cache-ram 57344`, `~1.30M` `FP16` tokens) across 3 slots (`id_slot: 0, 1, 2`):
    - Slot 0: `general` (`Max`, `100` effort) for Team Lead.
    - Slot 1: `general` (`High` / `subagent-high`, `75` effort) for subagents.
    - Slot 2: `explore` (`subagent-high`, `75` effort, restricted tools, `"shell": "deny"`).
  - Checkpoints store 12,827-token system preamble, skill catalog, tool schemas (`~563.7 MiB`/variant = `~2.20 GiB` total, 3.9% of 56 GiB `--cache-ram`).
  - Restoring 120K+ token checkpoint from `--cache-ram 57344`: 9–13 s (`~10,000–13,400 tok/s`), `~100×` faster than cold re-prefill (`~110–124 tok/s`, 28 min).
- **Reasoning Effort Invalidation Trap (`token 8` / `token ~12,934`)**:
  - DeepSeek V4.1 renders `<｜System｜>Reasoning Effort: <budget>` at start of prompt.
  - String presets → integer headers: `"low" -> 50`, `"medium" -> 62`, `"high" -> 75`, `"max" -> 100`.
  - Mid-conversation switch (`High (75)` → `Max (100)` at Turn 2) alters BPE token at index 8 (or `~12,934` in multi-turn). LCP cache invalidates 100% downstream tokens → full cold re-prefill (`705.80 s` in `task 29812`).
  - Fix: pin reasoning effort across turns (Lead = `Max (100)`, subagents = `#subagent-high`).
- **Tool Schema Prefix Invariance (`request_synthesis({})` vs Tool Removal)**:
  - OpenAI-compatible and Jinja APIs render schemas directly into system prompt (`## Tools`).
  - Removing tools from API payload modifies tool schema prefix → invalidates multi-turn KV cache.
  - Fix: invoke zero-arg `request_synthesis({})`. Session runner sets `toolChoice: "none"` next step while keeping `tools: loaded.tools` byte-identical → 100% KV hit, forces report generation without 32,768-token runaway cliffs.
- **Net-Token Slot Conservation in `get_available_slot()`**:
  - In `llama-server` multi-slot scheduling (`tools/server/server-context.cpp:1752`), naive LCP allows short prompt matching base prefix (12.9K tokens) to evict 120K+ warm session.
  - Score slots by net retained tokens:
    $$\text{Net Tokens} = \text{lcp\_slot} - (\text{prompt\_tokens} - \text{lcp\_slot})$$
    Prevents shallow prompts cannibalizing deep slots when idle/shallower slots exist.
- **Hierarchical Repo Foundation KV Checkpoints & Disk-Edit Coherence**:
  - Workspace `opencode.json` `"instructions"` pre-warmed in RAM pool enables PCIe Gen4 H2D DMA restores (`it_best->prompt.clone()` + `states.splice()`): 173.0 ms (`30,803.5 tok/s`) 1-slot 5,329-token `FP16`, 575.85 ms (`18,442.3 tok/s` aggregate) 2-slot concurrent 5,310-token restore.
  - **2-Req Eviction-Commit Boot Pre-Warm (`server-context.cpp:1790`)**: `llama-server` writes KV states to `--cache-ram` only on slot eviction (`f_keep < 0.50f`). Boot warm-up on `id_slot: 0`:
    1. Req 1: prefill canonical foundation prefix (`max_tokens: 1`).
    2. Req 2: send 16-token UUID sentinel on `id_slot: 0` (`f_keep = 0.0f < 0.50f`) → forces `prompt_save(*prompt_cache)` into `--cache-ram` for slots `0..N-1`.
  - **Disk-Edit Coherence**: File edit diverges LCP token stream at edit point → discards stale downstream KV states automatically. Verify with `git status --porcelain` or SHA-256 Merkle checks (`< 4 ms`).
  - **Attention Tax**: Keep `<｜System｜>` `<= ~20K–35K` tokens. Oversized static prefixes degrade attention latency across all subsequent turns.
- **OpenCode V2 Completion Polling Contract (Boot Pre-Warmers)**:
  - Ephemeral session flow: `POST /api/session` → Turn 1 `POST /api/session/{id}/prompt`.
  - **V2 `/message` Trap**: Do NOT poll `GET /api/session/{id}/message` checking `m.info.role == "assistant"` or `tokens.input > 0`. V2 uses `"type": "user" | "assistant" | "idle"` (`content: [...]`) without `"role"` wrapper or per-message `tokens`. V1 pollers hang until client timeout.
  - **Canonical V2 Poll**:
    1. Poll `GET /api/session/active` until session ID absent (`id not in resp["data"]`).
    2. Check `GET /api/session/{id}` (`info = resp["data"]`), assert terminal state: `info["outcome"] in ("succeeded", "failed", "interrupted")` or `info["time"].get("idle")`.
    3. Read tokens: `info["tokens"]["input"]`, `info["tokens"]["output"]`, `info["tokens"]["cache"]["read"]`.
    4. Fail fast on `info["outcome"] == "failed"`.
    5. Always `DELETE /api/session/{id}` in `finally:` block before slot eviction-commit sentinel.
- **Systemd `PartOf=` & `LOAD_MODE=none` (`aquanox-prefix-warmup.service`)**:
  - Unit `Type=oneshot`, `RemainAfterExit=yes`, `PartOf=deepseek-flash.service`, `[Install] WantedBy=multi-user.target deepseek-flash.service`. Restarting `deepseek-flash.service` triggers re-warm.
  - Set `TimeoutStartSec >= 1500`, poll `GET /health` + `GET /api/model` `>= 720 s` (`LOAD_MODE=none` repacks 403+ GiB CPU MoE/Engram weights, 500–550 s before `/health` responds).
- **OpenCode `tokens.reasoning` vs `delta.reasoning_content` & Termination**:
  - `mapUsage` (`openai-chat.ts`) reads `tokens.reasoning` only from `usage.completion_tokens_details?.reasoning_tokens`. `llama-server` omits field → `tokens_reasoning` is `0` in `opencode.db` despite streaming `"type": "reasoning"` via `delta.reasoning_content`.
  - Turn terminates (`needsContinuation = false`, `idle_outcome = "succeeded"`) on `finish_reason === "stop"` with 0 `delta.tool_calls`.
