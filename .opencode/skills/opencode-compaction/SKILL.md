---
name: opencode-compaction
description: Configure trigger reconcile OpenCode V2 context compaction budgets overflow
  recovery summary models background compaction provider native checkpoints
---

# OpenCode Compaction

Compaction keep long session running past model ctx window. Replace old turn with handoff summary (or provider-native checkpoint). Retain exact recent turn.

## Scope & Neighbor Boundaries

- **Skill owns**: `compaction` config (`auto`, `keep.tokens`, `buffer`), `agents.compaction.model`, `experimental.background_compaction`, provider/model `settings.compaction.type` (`summary` vs `native`), manual `POST /api/session/:id/compact`, model-visible `GET /api/session/:id/context`.
- **Sibling skills**:
  - `opencode-messages-parts` — durable transcript hydration (`message.list`), retain old turn after compaction.
  - `opencode-snapshots` — undo/revert turn & workspace file edit.
  - `opencode-inbox-delivery` — `steer` vs `queue` inbox mechanics.
  - `opencode-event-streams` — subscribe `session.compaction.*` SSE & session-log event.
  - `opencode-instructions` — `AGENTS.md` baseline reload & nested instruction re-injection.
  - `opencode-models` / `opencode-providers` — declare model ctx/input token limit.
  - `multi-agent-inference-benchmarking` — size per-slot local KV ctx across worktrees, full-stack concurrency limit, benchmark `1..N` throughput.

Read `references/compaction-contracts.md` for config table, background/native rule, SDK contract.

## Core Workflow

1. **Tune auto compaction budget (`opencode.jsonc`)**:
   - Enabled by default (`compaction.auto: true`). Reserve free `buffer` (`15%` model ctx limit, min `16000` tokens). Preserve `keep.tokens` (default `15000` tokens) exact recent history beside summary.
   - Increase `compaction.keep.tokens` on large-ctx model when exact recent diff / tool output priority over headroom.
   - Route summary gen via `agents.compaction.model` (fallback session model).
2. **Trigger manual compaction**:
   - CLI: `opencode api post /api/session/<sessionID>/compact --data '{"id":"msg_compact_1"}'`
   - SDK: `client.session.compact({ sessionID, id, delivery })` (`delivery`: `"steer"` or `"queue"`).
   - Works when `compaction.auto: false` or history short. Exec at next safe boundary before queued prompt. Duplicate request merge into pending.
   - Explicit `id` for idempotent retry. Reusing `id` with diff payload ret `409 Conflict`.
3. **Track completion & inspect ctx**:
   - HTTP `200` from `/compact` = inbox admission, NOT completion.
   - Watch `session.compaction.started`, `delta`, `ended`, `failed` events (`SessionMessageCompactionRunning` / `Completed` / `Failed`). `delta` chunk != terminal.
   - Call `client.session.context({ sessionID })` (`GET /api/session/:id/context`) verify model-visible turn.

## Key Invariants & Gotchas

- **Prompt-cache reuse & incremental checkpoint**: Summary req send full conversation (`[system prompt][older][recent][summary instructions]`) → provider reuse normal turn prefix cache. Subsequent compaction update prior summary checkpoint incrementally using turns since checkpoint.
- **Lossy summary & tail shorten**: Summary keep objective, decision, active/done work, blocker, next move, file path. Shorten tool output, replace attachment bytes with description in kept tail. Old msg intact in durable store (`message.list`).
- **Instruction baseline refresh**: Post-compaction, ambient instruction file version become baseline. Evicted nested `AGENTS.md` re-inject if dir read again.
- **Fixed-overhead floor**: Compaction only replace old conversation turn. Cannot free ctx taken by huge system prompt, `AGENTS.md`, MCP/tool schema.
- **Single overflow retry**: Provider reject prompt too long → OpenCode compact & retry **once**. Second consecutive overflow err out.
- **Ctx preservation via structured search vs raw read**: Tool output (`read`, `grep`, `shell`) enter history directly. Dumping 1,000+ line file (20,000+ tokens) consume `keep.tokens`, breach `buffer`, force premature compaction → discard exact diff & AST. Use regex `grep` + bounded `read(offset, limit)` slice delay compaction.
- **Token telemetry**: Summary call token usage != post-compaction session ctx size. Last-request count = historical measurement, not live meter.
- **Local GPU & native checkpoint**:
  - Multi-slot local GPU (e.g. `llama-server --parallel 3` at `3 × 384K`): set `limit.context` in **every** `opencode.json` (root, template, agent worktree) to **per-slot** KV budget (`393216` for `384k`/slot, never `1,179,648` total pool). Align schema: `"compaction": { "auto": true, "buffer": 65536, "keep": { "tokens": 12288 } }` (`327,680` trigger) → prevent slot overflow. Sizing details in `multi-agent-inference-benchmarking`.
  - `experimental.background_compaction` start memory summary at ~85% threshold. Keep `false` on local GPU: speculative summary contend with active foreground slot, trigger sequential prefill micro-batch.
  - Native compaction (`settings.compaction.type: "native"`) rely on provider endpoint (OpenAI Responses) returning encrypted checkpoint. Fail on generic local OpenAI server; fallback uncompacted transcript on model switch.
- **Compaction schema syntax gotcha (`normalize.ts:374`)**: Bare int `"keep": 12288` fail `isRecord(input.compaction.keep)` → silently dropped (`invalid(["compaction", "keep"])`), revert default. Wrap object: `"compaction": { "auto": true, "buffer": 65536, "keep": { "tokens": 12288 } }`.
- **`keep.tokens = 12288` vs `6144` under `--reasoning-preserve`**: `recent-text.ts` account for `{ type: "reasoning" }` (`<think>`) + tool output + tool-call boundary. `#high`/`#max` turn + file read = `5K–9K` tokens. `keep.tokens: 6144` retain `~1` turn → risk summarizing active patch ctx → trigger `70–110 s` re-read cycle. `keep.tokens = 12288` preserve `2–4` verbatim turn at `0.0 s` cost below `327,680` tokens, add `+53 s` re-prefill on fire.
- **Historical `reasoning` prefix immutability & SWA ring buffer (`to-llm-message.ts:156-184`)**: Strip `{ type: "reasoning" }` on `sameModel` err/interrupt turn mutate historical BPE token offset → invalidate `llama_kv_cache_dsv4` SWA ring buffer → full `cache = 0` wipe. Preserve `{ type: "reasoning" }` on `sameModel` turn; never alter token `#0` system prompt prefix during compaction.
