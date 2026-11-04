---
name: opencode-instructions
description: "Author, configure, and sync OpenCode V2 persistent instructions (`AGENTS.md` global, upward workspace, and lazy nested discovery, `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `instructions` config paths/globs/URLs, 6-layer prompt assembly order, live-edit/revert/compaction updates, and experimental `session.instructions.entry.*` `{value}` API). Use for persistent and session instructions; use `opencode-skills` for on-demand `SKILL.md` bundles and `opencode-agents` for agent system prompts."
---

# OpenCode Instructions

OpenCode V2 loads persistent guidance from `AGENTS.md` files, configured `instructions` arrays, and session-scoped API entries, assembling them additively into the model's context.

## Scope and Neighbor Boundaries

- **This skill owns**: `AGENTS.md` discovery (global `~/.config/opencode/AGENTS.md`, upward workspace walk, lazy nested subfolder loading, `OPENCODE_DISABLE_PROJECT_CONFIG=1`), `instructions` config entries (relative/home/absolute paths, globs, 5-second HTTP/S URLs), 6-layer initial prompt assembly order, mid-session update/move/revert/compaction refresh rules, client content redaction, and `@opencode/client` `session.instructions.entry.*` endpoints.
- **Use sibling skills for**:
  - `` `opencode-skills` `` — on-demand `SKILL.md` task instructions loaded selectively via the `skill` tool.
  - `` `opencode-agents` `` — per-agent `system` prompt definitions.
  - `` `opencode-references` `` — external directory/Git aliases with optional `description` hints.
  - `` `opencode-compaction` `` — context summarization and baseline instruction refresh.

Read [instruction discovery, ordering, and session entry API](references/discovery-ordering-and-api.md) for exact traversal diagrams, assembly order, and wire contracts.

## Core Authoring and Configuration Workflow

1. **Place `AGENTS.md` files at the directory scope they govern**:
   - **V2 recognizes `AGENTS.md` only**—it does **not** fall back to `CLAUDE.md`.
   - At session start, OpenCode combines:
     1. `~/.config/opencode/AGENTS.md` (global)
     2. Every `AGENTS.md` walking **upward** from the current workspace directory toward `$HOME` (or stopping at the project root for workspaces outside `$HOME`), ordered **nearest-to-farthest** (`packages/web/AGENTS.md` -> `packages/AGENTS.md` -> `AGENTS.md`).
   - Set `OPENCODE_DISABLE_PROJECT_CONFIG=1` to skip project `AGENTS.md` discovery while retaining `~/.config/opencode/AGENTS.md`.
2. **Add supplemental files, globs, or URLs via `instructions` (`opencode.jsonc`)**:
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
   - Entries from all active config files combine additively in listed order right after `AGENTS.md` files.
3. **Manage per-session dynamic entries via the experimental API**:
   - SDK: `client.session.instructions.entry.put({ sessionID, key, value })` (`PUT /api/experimental/session/:id/instructions/entries/:key` with body **`{ "value": <JsonValue> }`** -> `204`), plus `list` and `remove`.

## Key Invariants and Gotchas

- **Lazy nested `AGENTS.md` discovery & fresh-session edit rule**:
  - `AGENTS.md` files *below* the workspace root load lazily (nearest-first) when the agent reads a file or lists a directory in that subtree, and are deduplicated while visible in session history.
  - **Mid-session edits**: Editing a global or upward `AGENTS.md` (or local `instructions` file) injects an automatic instruction update before the next prompt. **Editing an already-loaded nested `AGENTS.md` is NOT detected automatically**—start a fresh session when nested edits must apply immediately!
  - **Compaction & revert re-injection**: Compaction refreshes ambient instruction files as the session baseline, and committing a revert clears and reloads ambient state; if compaction or revert evicts a nested `AGENTS.md` entry from model history, reading that subtree again will load it again.
- **Transient read errors preserve state**: Deleting all ambient `AGENTS.md` files informs the session they no longer apply, whereas a temporary filesystem read error retains the last known instructions. Moving a session (`session_move`) retains existing state and introduces destination guidance as an update.
- **5-second HTTP URL timeout trap**: `http://` and `https://` entries in `instructions` fetch at config load with a **5-second timeout** (skipping or keeping last-fetched text on failure). Avoid remote URLs in air-gapped or offline environments where unreachable hosts add 5-second config-load delays.
- **Required outer `{ value }` wrapper on session entry `PUT`**: Raw HTTP `PUT /api/experimental/session/:id/instructions/entries/:key` requires `{ "value": ... }` at the JSON root. Sending unwrapped `{ "content": "...", "description": "..." }` at the root violates the pinned schema (failing with HTTP `400` `Missing key at ["value"]`)—and never prepend user instructions to prompt text if you also sync them via `instructions.entry.put`, or the model receives duplicate copies!
- **KV prefix cache invariance & Jinja `## Tools` cache-busting trap**:
  - OpenCode's `SessionContext.select` (`packages/core/src/session/context.ts:152-161`) appends `loaded.builtins` (`core/date` and `core/environment` `<env>Working directory: ...</env>`) plus `loaded.entries` at the **end of `system.content`**.
  - In chat templates where `system.content` renders *before* `\n\n## Tools` (such as DeepSeek V4.1 Flash and standard GGUF Jinja templates), any change to `<env>` (e.g. worktree switch) or `date` (midnight UTC rollover) mutates tokens immediately *before* `## Tools`, invalidating `~3,000–5,000` tool-schema KV tokens in the prefix cache!
  - **Mitigation**: Moving dynamic session metadata (`date`, `<env>`, dynamic context entries) out of `<｜System｜>` into `<｜User｜>` (such as inside a leading `<system-reminder>` block) preserves 100% byte-for-byte invariance for `<｜System｜> + instructions + ## Tools` across all worktrees, calendar days, and sessions.
- **Content-Hash Deduplication in `ConfigInstructionPlugin` (`packages/core/src/config/plugin/instruction.ts`)**:
  - `refresh()` deduplicates loaded instruction files across `[...sources.global, ...sources.project, ...sources.configured]` by normalized non-empty content (`file.content.replaceAll("\r\n", "\n").trim()`).
  - It keeps the first occurrence (`sources.global`'s `~/.config/opencode/AGENTS.md`) and drops redundant copies such as `/etc/opencode/AGENTS.md` from `configuredSource`.
  - **Cold TTFT & KV impact**: Prevents `20,552` bytes (`~4,600` tokens / `~21.7s` cold TTFT on pure-FP16 inference) of duplicate global instructions from bloating `frozen_initial`.
- **Cross-Repository Prefix Ordering in `SessionContext.select` (`packages/core/src/session/context.ts`)**:
  - `loaded.discovery` (`core/instructions`, starting with `~/.config/opencode/AGENTS.md`) is ordered **ahead of** `loaded.skills` (`core/skill-guidance`) in `Instructions.combine([...])`.
  - Placing `CodeModeInstructions` (`~900` tokens) + Global `AGENTS.md` (`~4,600` tokens) at the top of `<｜System｜>` guarantees an identical `~5,500`-token prefix across all repositories.
  - **Checkpoint boundary crossing**: This crosses `llama-server`'s `4,096`-token `DSV4` recurrent-state checkpoint boundary (`seq_pos = 4096`) before any repository-specific `AGENTS.md` or `100+` project skills diverge, unlocking instant cross-workspace foundation prefix cache hits (`f_keep` hits) across distinct projects.
- **Skill catalog bloat & `autoinvoke: false` scoping**:
  - Unfiltered advertising of 50+ skills injects `5,000–6,500+` tokens of `<available_skills>` XML into every prompt step. Use `metadata.opencode/autoinvoke: false` on admin/platform/meta skills to strip them from the automatic catalog while keeping them loadable by ID (see `` `opencode-skills` ``).
- **Privileged content redaction**: Clients can observe *which* instruction sources changed, but raw instruction text remains privileged and is never exposed back to unprivileged client payloads.

- **Hierarchical Repository Foundation KV Checkpoints & Disk-Edit Cache Coherence**:
  - **Pre-Warmed Foundation Architecture**: Preloading repository-wide architectural contracts, shared schemas, or foundation specifications via workspace `opencode.json` `"instructions"` allows inference engines with RAM KV caching (`llama-server` `--cache-ram`, vLLM prefix cache) to restore `18K–35K` foundation tokens via PCIe H2D DMA in **`~0.8–1.6 s`**, bypassing `180–350 s` of uncached CPU or cold GPU prefill.
  - **Disk-Edit Cache Coherence**: OpenCode reads instruction files live from disk (`instruction-discovery.ts`). In engines using Longest Common Prefix (LCP) matching, editing a file on disk naturally diverges token identity at the exact edited token offset, guaranteeing the model never operates on stale cached KV states. For external session injection, fast (`< 4 ms`) `git status --porcelain` or SHA-256 Merkle checks verify live-disk parity before declaring pre-warmed checkpoints authoritative.
  - **The System-Prompt Bloat Trade-Off & `<28K` Sweet Spot**: Beware over-bloating `<｜System｜>` past **`28K` tokens** (such as `36K+` full-repo file dumps). Every static token in the persistent prefix remains resident in context across all subsequent turns, degrading prefill (`98.8 -> 96.4 tok/s`) and decode (`21.66 -> 21.23 tok/s`). Maintain the **`<28K` sweet spot**, reserving `~15K–20K` tokens for high-reuse foundation contracts and utilizing targeted tool reads for localized code.
