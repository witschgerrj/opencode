---
name: opencode-tools
description: "Use, configure, and debug OpenCode V2 built-in model tools (`read`, `glob`, `grep`, `edit`, `write`, `patch`, `shell`, `webfetch`, `websearch`, `question`, `skill`, `subagent`, `execute` Code Mode, `opencode` session/worktree utilities, Desktop `browser`, and `tool_output` limits). Use for built-in tool contracts and Code Mode orchestration; use `opencode-mcp-servers` for MCP tools/resources and `opencode-permissions` for permission rule authoring."
---

# OpenCode Tools and Code Mode

OpenCode V2 exposes a structured catalog of built-in filesystem, command, web, interaction, automation, and JavaScript Code Mode (`execute`) tools, each enforcing action/resource permissions directly and inside nested calls.

## Scope and Neighbor Boundaries

- **This skill owns**: Built-in model tool behavior (`read`, `glob`, `grep`, `edit`, `write`, `patch`, foreground/background `shell`, `webfetch`, `websearch`, `question`, `skill`, `subagent`, `todowrite`), `execute` JavaScript Code Mode runtime, `opencode.*` (`session_rename`, `session_move`, `worktree_*`) and Desktop `browser.*` Code Mode namespaces, `tool_output` retention limits, and direct vs nested tool permission boundaries.
- **Use sibling skills for**:
  - `` `opencode-mcp-servers` `` — MCP server setup, `codemode: false` direct exposure, and `list_mcp_resources` / `read_mcp_resource`.
  - `` `opencode-permissions` `` and `` `opencode-policies` `` — authoring ordered `{action, resource, effect}` rules and hard `tool.use` policies.
  - `` `opencode-formatters` `` — post-edit formatting triggered by `edit`, `write`, and `patch`.
  - `` `opencode-attachments` `` — `media.image` normalization shared with `read` image loading.
  - `` `opencode-websearch` `` — search engine selection, credentials, and rate-limit failover.
  - `` `opencode-skills` `` and `` `opencode-agents` `` — authoring skills and subagent profiles.
  - `` `opencode-human-input` `` — answering `question` forms and permission prompts over the SDK/HTTP API.
  - `` `opencode-server-client` `` — client-side `session.shell`, standalone `shell.*`, and PTY endpoints (there is **no** generic `client.tool.call` REST endpoint for built-in tools).

Read [built-in tool catalog and Code Mode contracts](references/builtin-tools-and-codemode.md) for per-tool parameters, caps, permission resources, and namespace operations.

## Core Tool Workflow

1. **Choose the right file or search tool**:
   - `read` pages UTF-8 text (numbered lines, capped at **2,000 lines** and **50 KiB** per page; lines shortened past 2,000 chars), lists immediate directory entries, and loads `PNG`/`JPEG`/`GIF`/`WebP`/`PDF` up to 20 MiB source data.
   - `glob` matches relative paths (default 100 files, 30s timeout); `grep` searches file contents via regex or `literal: true` (default 100 matching lines, 30s timeout).
   - `edit` replaces unique (`replaceAll: false`) or all occurrences in an existing file; `write` creates or overwrites a file (creating parent directories); `patch` applies multi-file `*** Add File` / `*** Update File` / `*** Delete File` (including renames/moves) **only on supported OpenAI/GPT models** (other models receive `edit` and `write`).
2. **Use `shell` with explicit `workdir` and bounded timeouts**:
   - Pass `workdir` rather than embedding `cd`. Foreground calls default to a **2-minute (`120000` ms) timeout**.
   - Set `background: true` for long-running processes; background calls return immediately, notify the session upon exit, and **have no timeout unless `timeout` is explicitly supplied**.
   - Tune inline retention globally via `"tool_output": { "max_lines": 2000, "max_bytes": 51200 }`; oversized `shell` and `webfetch` outputs are shortened inline while full output is saved in a managed file.
3. **Orchestrate parallel or filtered workflows with Code Mode (`execute`)**:
   - `execute` runs sandboxed JavaScript with **no direct disk I/O, no `import`/`require`, and no timers**, providing global `fetch` plus permitted catalog tools (`opencode.*`, `browser.*`, and MCP namespaces).
   - Use `execute` to batch independent reads/queries in parallel and summarize intermediate data before it enters model context.

## Key Invariants and Gotchas

- **Denying `execute` hides Code-Mode-only tools**: A `deny` on action `execute` (`resource: "*"`) removes Code Mode **and** hides every tool exposed exclusively inside it—including MCP server tools unless that server sets `"codemode": false`, `opencode.*` session/worktree helpers, and `browser.*`.
- **Code Mode never bypasses permissions**: Every nested built-in, MCP, or plugin tool invoked inside `execute` still enforces its own permission rules across all affected resources.
- **`grep` checks the pattern, NOT the search path**: `grep` evaluates permission action `grep` against the requested regex/literal `pattern` string—it does **not** check the `path` argument! Do not rely on `grep` rules to restrict directory access.
- **`patch` model gating**: `patch` is advertised only to supported GPT models; prompts or skills targeting non-GPT models must work with `edit` and `write`.
- **Safe-boundary `session_move`**: `opencode.session_move` takes effect at a safe turn boundary, so destination-dependent file or shell work must run in a **subsequent** call, not later in the same `execute` script.
- **`core/codemode` tool consolidation**: In OpenCode (`packages/core/src/session/context.ts` and `core/src/codemode/instructions.ts`), auxiliary utilities (`opencode_models`, `opencode_session_rename`, `opencode_worktree_list`) are consolidated into Code Mode's single concise Markdown instruction block (`709` tokens) instead of generating separate individual DSML tool schemas for each tool (`2,890–3,350` tokens in `## Tools`).
- **Structured search (`grep.ts`) vs raw file prefill (`plugin/read.ts`)**: `grep.ts` outputs only matching lines (`~400–980` tokens) without emitting entire file contexts or line-number overhead on non-matching lines, making it the preferred first-wave discovery tool before issuing targeted `read(path, offset, limit)` slices.
- **Desktop `browser` namespace constraints**: `browser.*` requires an attached **OpenCode Desktop app** (unavailable on headless servers), requires passing the explicit `tabID` to every page call, requires a focused visible tab for screenshots, caps server-local file uploads/captures at **5 MiB**, treats page DOM/logs/headers as untrusted data, and uses a single all-or-nothing `browser` `*` deny rule (no per-click prompts).
- **Token accounting traps & line-number prefix bloat**:
  - OpenCode's `toModelContent` (`packages/core/src/tool/plugin/read.ts:192`) formats text reads with `Read file <path>, lines A-B` header plus `${line}: ` number prefixes on every line. Adding an optional `lineNumbers?: boolean` parameter (defaulting `false` while retaining the `Read file <path>, lines A-B` header) preserves OpenCode `edit`'s exact `oldString -> newString` string matching while saving **`2,103` exact BPE tokens** across 13 file reads (`17,742 -> 15,639` tokens)!
  - DeepSeek DSML tool calls cost `~71–75` tokens/call (not `40`t JSON estimates). Always verify via `/apply-template` + `/tokenize`!
  - Beware double-subtracting tools: do not claim token savings for tools that already live inside `core/codemode` (e.g. `opencode_*`) or are already `"deny"` in `opencode.json` (e.g. `webfetch`, `websearch`).
- **Zero-truncation discipline & Interior Component-Body Completeness Rule**:
  - Lowering global `read-filesystem.ts` default line/byte caps (e.g. to `160L / 8 KiB`) silently truncates tail CSS rules (e.g., cutting off styles at line 161 in a 272-line CSS file) or dense specifications (e.g., cutting off lines 39–77 in a 77-line 20 KiB prose document).
  - **Interior Component-Body Slice Completeness Rule**: Never slice only component headers/tails while omitting `30–50`-line interior helper bodies (such as intermediate JSX render blocks between `grep` anchors). Always extend batched `read` ranges continuously from function signature through closing `}` of every matched component.
  - Skipping middle ranges without checking anchor `grep` hits (e.g. slicing `[1:120]` and `[180:277]` while dropping block styles at `L171` or component renderers at `L237`) breaks research completeness.
  - Always keep safe `2,000L / 50 KiB` ceilings in tool definitions.
  - Implement zero-truncation discovery discipline: **multi-file `grep` anchor discovery first to identify exact symbol/section lines, followed by targeted `read(offset, limit)` slices**.

- **Multi-File / Multi-Range Batched `read` + Opt-In Lossless Compaction**:
  - Extending `ReadTool` (`packages/core/src/tool/plugin/read.ts`) with `batch` (`Array<{ path: string, ranges?: Array<[number, number]> }>` or string specs `"path:s1-e1,s2-e2"` executed concurrently via `Effect.forEach(..., { concurrency: 8 })`) allows an agent to read multiple files and specific line slices in a single tool call.
  - Coupled with defaulting `lineNumbers = false` (saving `${line}: ` token bloat while keeping `Read file <path>, lines A-B` headers) and opt-in read-only lossless whitespace/comment/blank-line + `>60`-char inline SVG `<path d="...">` compaction (`compact: true`), this collapses what would otherwise be **8–13 separate DSML `read` invocations (`~950–1,350` DSML output tokens across 4–5 turns)** into **1–2 batched calls (`~140–310` DSML tokens across 2 tool turns)**.
  - **Edit Safety Invariant & CRITICAL GOTCHA on `compact: true` in `read.ts:292`**:
    - **NEVER set `compact: true` as the global default** in `read.ts:292` or tool options.
    - `compact: true` removes all blank lines, collapses multi-line CSS style blocks `{ ... }` onto single lines, and truncates `>60`-character JSX SVG paths to `d="[path:Nc]"`.
    - If `compact: true` is active during reads preceding an `edit` or `patch`, `Patch.derive` verbatim context matching fails because the target lines no longer match the real file on disk, triggering cascading edit-retry failures.
    - **Rule**: Keep global defaults strictly at `compact: false, limit: 2000`. Use `compact: true` solely for read-only discovery/audit turns, and always ensure `compact: false` is used before generating patches or edits.

- **The `@opencode/codemode` (`execute`) sandbox trap**:
  - `execute` runs inside an isolated V8 JavaScript sandbox without Node's `fs` or `child_process`.
  - Built-in filesystem and shell tools (`read`, `grep`, `glob`, `shell`) hardcode `options: { codemode: false }` and cannot be invoked from inside `execute` scripts.
  - Additionally, `execute` is denied on `explore` agents. Never attempt to use `execute` as a batch wrapper for disk tools; use native `read({ batch: [...] })` instead.

- **Two-stage `request_synthesis({})` control tool**:
  - Solves the fundamental pre-generation tool-vs-synthesis blindness on autonomous `general` agents (`steps: undefined`).
  - Without a control tool, `llm.ts` cannot determine whether a turn will call tools or synthesize the final report. Removing tools on the final step alters the system prompt / tool catalog prefix at token `~2K`, invalidating the KV cache.
  - Subagents run discovery/action steps with bounded reasoning budgets (`1024` on `explore`, `2560..4096` on `general`) and `toolChoice: "auto"`.
  - Calling the zero-arg `request_synthesis({})` tool switches the runner's subsequent turn to `toolChoice: "none"` and elevates `reasoning_budget_tokens` (`2048..2560`), while keeping `tools: loaded.tools` 100% byte-identical (`100%` KV prefix hit rate, zero `32,768` cliffs).

- **Multi-file `PatchTool` unlocked for DeepSeek V4.1 (`patch.ts:319-333`)**:
  - Removed the `!event.model.id.includes("gpt-")` model gating in `patch.ts`.
  - DeepSeek V4.1 Flash natively emits unified multi-file diffs (`*** Add File:`, `*** Update File:`, `*** Delete File:`) with exact line anchors, enabling atomic multi-file application alongside `write` and `edit`.
