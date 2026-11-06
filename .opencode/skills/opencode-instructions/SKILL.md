---
name: opencode-instructions
description: Author configure sync OpenCode V2 persistent instructions AGENTS.md config
  paths API.
---

# OpenCode Instructions

OpenCode V2 loads persistent guidance from `AGENTS.md` files, configured `instructions` arrays, session-scoped API entries, assembling additively into model ctx.

## Scope & Boundaries

- **Owns**: `AGENTS.md` discovery (global `~/.config/opencode/AGENTS.md`, upward workspace walk, lazy nested subfolder loading, `OPENCODE_DISABLE_PROJECT_CONFIG=1`), `instructions` config entries (relative/home/absolute paths, globs, 5s HTTP/S URLs), 6-layer prompt assembly order, mid-session update/move/revert/compaction refresh, client redaction, `@opencode/client` `session.instructions.entry.*` API.
- **Sibling skills**:
  - `opencode-skills` — on-demand `SKILL.md` bundles via `skill` tool.
  - `opencode-agents` — per-agent `system` prompts.
  - `opencode-references` — external dir/Git aliases with optional `description`.
  - `opencode-compaction` — ctx summarization + baseline instruction refresh.

See `references/discovery-ordering-and-api.md` for traversal diagrams, assembly order, wire contracts.

## Authoring & Config Workflow

1. **Place `AGENTS.md` at governing dir scope**:
   - V2 recognizes `AGENTS.md` only (no `CLAUDE.md` fallback).
   - Session init combines:
     1. `~/.config/opencode/AGENTS.md` (global)
     2. Upward `AGENTS.md` walk from current workspace dir toward `$HOME` (or project root outside `$HOME`), ordered nearest-to-farthest (`packages/web/AGENTS.md` → `packages/AGENTS.md` → `AGENTS.md`).
   - Set `OPENCODE_DISABLE_PROJECT_CONFIG=1` → skip project `AGENTS.md`, keep `~/.config/opencode/AGENTS.md`.
2. **Add supplemental paths/globs/URLs via `instructions` (`opencode.jsonc`)**:
   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "instructions": [
       "CONTRIBUTING.md",
       "docs/guidelines/*.md",
       "~/rules/coding-style.md",
       "https://example.com/team-rules.md"
     ]
   }
   ```
   - Config entries combine additively in order immediately after `AGENTS.md`.
3. **Manage per-session dynamic entries via API**:
   - SDK: `client.session.instructions.entry.put({ sessionID, key, value })` (`PUT /api/experimental/session/:id/instructions/entries/:key` with body `{"value": <JsonValue>}` → `204`), plus `list` and `remove`.

## Invariants & Gotchas

- **Lazy nested `AGENTS.md` discovery & edit rule**:
  - `AGENTS.md` below workspace root loads lazily (nearest-first) on subfolder file read or dir list; deduplicated while visible in session history.
  - **Mid-session edits**: Global/upward `AGENTS.md` edits auto-inject update before next prompt. **Editing loaded nested `AGENTS.md` NOT detected** → restart session for immediate effect.
  - **Compaction & revert**: Compaction refreshes ambient files as baseline; revert clears/reloads ambient state. Evicted nested `AGENTS.md` reloads on subsequent subtree read.
- **FS read errs vs deletion**: Deleting ambient `AGENTS.md` notifies session of removal. FS read err retains last known instructions. `session_move` retains state + introduces dest guidance as update.
- **5s HTTP URL timeout**: Remote `instructions` fetch with 5s timeout (skip/keep stale on err). Unreachable hosts cause 5s config-load delay; avoid in offline/air-gapped env.
- **Outer `{ value }` wrapper required on PUT**: Raw `PUT /api/experimental/session/:id/instructions/entries/:key` reqs `{"value": ...}` root. Unwrapped `{"content": "...", "description": "..."}` fails HTTP `400` (`Missing key at ["value"]`). Do not duplicate text across prompt body and `instructions.entry.put`.
- **KV prefix cache invariance & Jinja `## Tools` cache-busting**:
  - OpenCode `SessionContext.select` (`packages/core/src/session/context.ts:152-161`) appends `loaded.builtins` (`core/date`, `core/environment` `<env>Working directory: ...</env>`) + `loaded.entries` at end of `system.content`.
  - Templates rendering `system.content` before `\n\n## Tools` (DeepSeek V4.1 Flash, GGUF Jinja) bust `3,000–5,000` tool KV tokens on worktree change or midnight UTC date rollover.
  - **Fix**: Move dynamic session metadata (`date`, `<env>`) from `<｜System｜>` to `<｜User｜>` (e.g. leading `<system-reminder>`) → preserves 100% byte invariance for `<｜System｜> + instructions + ## Tools`.
- **Durable Epoch-Prefix State, `12 KiB` Instruction Delta Cap & `subagentReminder` Recency (`instruction-state.ts`, `epoch-prefix.ts`)**:
  - `InstructionState` (`packages/core/src/session/instruction-state.ts`) persists per-session epoch baselines in SQLite `session_epoch_prefix` (`frozen_initial`, `instruction_baseline_json`, `workspace_summary`) and per-user-message reminder snapshots in `session_turn_reminder`.
  - Mid-epoch changes to `AGENTS.md` or dynamic instruction entries are computed incrementally via `computeInstructionDelta(baseline, current)` and injected into `<system-reminder>` (`<instruction-delta>`) without mutating `frozen_initial` in `<｜System｜>`, preserving the `:8080` KV prefix cache across turns and process restarts (`hydrateDurableEpochPrefix`).
  - `MAX_INSTRUCTION_DELTA_CHARS = 12,288` (`12 KiB` in `packages/core/src/session/epoch-prefix.ts`) deterministically truncates oversized mid-epoch instruction deltas with `"\n...[truncated instruction delta]"` before persisting to `session_turn_reminder`, preventing unbounded per-turn prompt bloat.
  - `subagentReminder` (`getSubagentReminder` in `epoch-prefix.ts`) is placed at the **tail** of `reminderParts` (`[workspaceSummary, renderedVolatile, subagentReminder]`) immediately before `</system-reminder>\n\n${msg.text}` so `<env>...</env>` never buries the graph-coupled subagent partitioning directive.
- **Content-Hash Deduplication in `ConfigInstructionPlugin` (`packages/core/src/config/plugin/instruction.ts`)**:
  - `refresh()` deduplicates loaded instruction files across `[...sources.global, ...sources.project, ...sources.configured]` by normalized non-empty content (`file.content.replaceAll("\r\n", "\n").trim()`).
  - Keeps first occurrence (`sources.global` `~/.config/opencode/AGENTS.md`) and drops redundant copies (e.g., `/etc/opencode/AGENTS.md` from `configuredSource`) → prevents `20,552` B (`~4,600` tok / `~21.7s` cold TTFT) duplicate global instruction bloat in `frozen_initial`.
- **Cross-Repository Prefix Ordering in `SessionContext.select` (`packages/core/src/session/context.ts`)**:
  - `loaded.discovery` (`core/instructions`, starting with `~/.config/opencode/AGENTS.md`) ordered **ahead of** `loaded.skills` (`core/skill-guidance`) in `Instructions.combine([...])`.
  - Places `CodeModeInstructions` (`~900` tok) + Global `AGENTS.md` at top of `<｜System｜>` → crosses `llama-server` `4,096`-tok `DSV4` recurrent-state checkpoint boundary (`seq_pos = 4096`) before repo-specific `AGENTS.md` or project skills diverge, unlocking cross-workspace foundation prefix cache hits (`f_keep`).
- **Skill catalog bloat & `autoinvoke: false` scoping**:
  - 50+ skills inject `5,000–6,500+` XML tokens per step. Set `metadata.opencode/autoinvoke: false` on admin/platform/meta skills to hide from auto-catalog while retaining ID-based loads.
- **Privileged content redaction**: Clients observe instruction source mutation events; raw instruction content stays redacted from unprivileged payloads.
- **Foundation KV Checkpoints & Disk-Edit Coherence**:
  - **Pre-warmed foundation**: Workspace `opencode.json` `"instructions"` preloads foundation specs. RAM KV caching (`llama-server` `--cache-ram`, vLLM prefix cache) restores `18K–35K` tokens via PCIe H2D DMA in `~0.8–1.6 s` vs `180–350 s` cold prefill.
  - **Disk-edit cache coherence**: OpenCode reads instructions live from FS (`instruction-discovery.ts`). LCP matching diverges token identity at edited offset → stale KV eliminated. Verify parity via `git status --porcelain` or SHA-256 Merkle checks (`< 4 ms`).
  - **`<28K` token ceiling**: Static prefix `> 28K` degrades prefill (`98.8 -> 96.4 tok/s`) and decode (`21.66 -> 21.23 tok/s`). Cap static prefix at `15K–20K` tokens; use targeted tool reads for localized code.
