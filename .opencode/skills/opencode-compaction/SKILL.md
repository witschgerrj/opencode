---
name: opencode-compaction
description: "Configure, trigger, and reconcile OpenCode V2 context compaction, kept recent token budgets, overflow recovery, summary models, background compaction, and provider-native checkpoints. Use for context pressure and model-visible history (`session.context`); use `opencode-messages-parts` for full historical transcripts and `opencode-snapshots` for undo/revert rollback."
---

# OpenCode Compaction

Compaction keeps long sessions running past a model's context window by replacing older conversation turns with a structured handoff summary (or provider-native checkpoint) while retaining exact recent turns alongside it.

## Scope and Neighbor Boundaries

- **This skill owns**: `compaction` configuration (`auto`, `keep.tokens`, `buffer`), `agents.compaction.model`, `experimental.background_compaction`, provider/model `settings.compaction.type` (`summary` vs `native`), manual `POST /api/session/:id/compact`, and model-visible `GET /api/session/:id/context`.
- **Use sibling skills for**:
  - `` `opencode-messages-parts` `` — paginated durable transcript hydration (`message.list`), which retains older turns even after compaction drops them from model context.
  - `` `opencode-snapshots` `` — undoing/reverting conversation turns and workspace file edits.
  - `` `opencode-inbox-delivery` `` — `steer` vs `queue` inbox mechanics and pending item management.
  - `` `opencode-event-streams` `` — subscribing to `session.compaction.*` SSE and durable session-log events.
  - `` `opencode-instructions` `` — `AGENTS.md` baseline reload and nested instruction re-injection after compaction.
  - `` `opencode-models` `` / `` `opencode-providers` `` — declaring model context/input token limits.
  - `` `multi-agent-inference-benchmarking` `` — sizing per-slot local KV context across isolated agent worktrees, aligning full-stack concurrency limits, and benchmarking `1..N` multi-agent throughput.

Read [compaction schemas, modes, and wire contracts](references/compaction-contracts.md) for full configuration tables, background/native rules, and SDK contracts.

## Core Workflow

1. **Tune automatic compaction budgets (`opencode.jsonc`)**:
   - Automatic compaction is enabled by default (`compaction.auto: true`), reserving a free `buffer` (`15%` of model context limit, at least `16000` tokens) and preserving `keep.tokens` (`15000` tokens by default) of exact recent history beside the summary.
   - Increase `compaction.keep.tokens` on large-context models when retaining exact recent diffs and tool outputs matters more than maximizing free headroom.
   - Optionally route summary generation to a dedicated model via `agents.compaction.model` (falls back to the session's model if unresolved).
2. **Trigger manual compaction safely**:
   - CLI: `opencode api post /api/session/<sessionID>/compact --data '{"id":"msg_compact_1"}'`
   - SDK: `client.session.compact({ sessionID, id, delivery })` (`delivery`: `"steer"` or `"queue"`).
   - Manual compaction works even when `compaction.auto` is `false` or history is short. It runs at the next safe boundary before waiting queued prompts, and duplicate requests made while one is pending merge into it.
   - Supply an explicit `id` when callers need idempotent retries; reusing the same `id` for a different request payload returns `409 Conflict`.
3. **Track completion and inspect model-visible context**:
   - An HTTP `200` from `/compact` proves **inbox admission**, not summary completion.
   - Observe `session.compaction.started`, `delta`, `ended`, and `failed` events (plus `SessionMessageCompactionRunning` / `Completed` / `Failed` messages). Do not treat `delta` chunks as terminal completion.
   - Inspect `client.session.context({ sessionID })` (`GET /api/session/:id/context`) to verify what the model actually sees on the next turn.

## Key Invariants and Gotchas

- **Prompt-cache reuse & incremental checkpoints**: Summary requests send the full current conversation (`[system prompt][older][recent][summary instructions]`) so providers can reuse the normal turn's prompt prefix cache. Subsequent compactions incrementally update the prior summary checkpoint using turns since that checkpoint.
- **Lossy summaries & tail shortening**: Summaries preserve objectives, decisions, active/completed work, blockers, next moves, and file paths, while shortening long tool outputs and replacing attachment bytes with brief descriptions in the kept recent tail. Earlier messages remain intact in durable storage (`message.list`).
- **Instruction baseline refresh**: After compaction, current versions of ambient instruction files become the session's baseline, and previously evicted nested `AGENTS.md` files can re-inject if their directory is read again.
- **Fixed-overhead floor**: Compaction only replaces older conversation turns; it cannot free context consumed by huge fixed system prompts, `AGENTS.md` files, or MCP/tool schemas.
- **Single overflow retry**: When a provider rejects a prompt as too long, OpenCode compacts and retries **once**; a second consecutive context-overflow rejection fails with an error.
- **Context preservation via structured search vs raw full-file reads**: Tool execution results (from `read`, `grep`, `shell`) enter session history directly. Dumping unconstrained 1,000+ line files (20,000+ tokens) into context rapidly consumes `keep.tokens` and breaches `buffer`, forcing premature automatic compaction. Because compaction generates lossy summaries, premature compaction discards exact code diffs and fine-grained AST definitions. Adopting structured regex `grep` and bounded `read(offset, limit)` slices preserves context headroom, delaying compaction across extended multi-turn sessions.
- **Token telemetry traps**: Do not display the summary generation call's token usage as the post-compaction session context size, and remember that last-request token counts are historical measurements rather than live context meters.
- **Local GPU (single- & multi-slot) & native checkpoint caveats**:
  - On multi-slot local GPU servers (e.g., `llama-server --parallel 3` at `3 × 384K`), set `limit.context` in **every** active `opencode.json` (project root, templates, and each isolated agent worktree) to the **per-slot** KV budget (`393216` for `384k`/slot, never the `3 × 393,216 = 1,179,648` unified pool total) with an aligned compaction schema: `"compaction": { "auto": true, "buffer": 65536, "keep": { "tokens": 12288 } }` (`327,680` auto-compaction trigger) so no worktree overflows its slot or compacts prematurely; route multi-agent capacity sizing and `1..N` benchmarking to `` `multi-agent-inference-benchmarking` ``.
  - `experimental.background_compaction` starts summarizing in memory at ~85% of threshold; keep it `false` on single- and multi-slot local GPU servers because speculative background summaries contend directly with active foreground agent slots and trigger sequential prefill micro-batches even when held summaries go unused.
  - Provider-native compaction (`settings.compaction.type: "native"`) relies on provider-specific endpoints (such as OpenAI Responses) returning encrypted non-portable checkpoints; it fails on generic OpenAI-compatible local servers and falls back to the uncompacted transcript if the user switches models.
- **Compaction schema syntax gotcha (`normalize.ts:374`)**: Configuring `"keep": 12288` as a bare integer fails `isRecord(input.compaction.keep)` and is silently dropped with `invalid(["compaction", "keep"])`, reverting to default `keep.tokens`. Always wrap the configuration as an object: `"compaction": { "auto": true, "buffer": 65536, "keep": { "tokens": 12288 } }`.
- **Why `keep.tokens = 12288` beats `6144` under `--reasoning-preserve`**: When `recent-text.ts` accurately accounts for `{ type: "reasoning" }` (`<think>`) alongside unclipped tool outputs and snaps to settled tool-call boundaries, a single `#high`/`#max` turn plus a file read can consume `5K–9K` tokens. Setting `keep.tokens` to `6144` retains only `~1` turn, risking summarizing away active pre-patch line context and forcing costly `70–110 s` re-read cycles. Calibrating `keep.tokens = 12288` preserves `2–4` full settled verbatim turns at `0.0 s` runtime cost below `327,680` tokens and incurs only `+53 s` re-prefill if compaction fires (strongly net-positive).
- **Historical `reasoning` prefix immutability and SWA ring buffers (`to-llm-message.ts:156-184`)**: Stripping `{ type: "reasoning" }` parts from `sameModel` errored or interrupted turns mutates historical BPE token offsets and invalidates `llama_kv_cache_dsv4` sliding-window attention (SWA) ring buffers, triggering a full `cache = 0` wipe. Always preserve `{ type: "reasoning" }` parts on `sameModel` turns, and never alter the token `#0` system prompt prefix during compaction.
