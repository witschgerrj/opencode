---
name: opencode-tools
description: Operate, configure, and troubleshoot OpenCode built-in model tools, Code
  Mode execution runtime, session utilities, and output retention limits.
---

# OpenCode Tools and Code Mode

OpenCode V2 exposes structured catalog of built-in FS, command, web, interaction, automation, and JS Code Mode (`execute`) tools. Each enforces action/resource permissions directly and inside nested calls.

## Scope and Neighbor Boundaries

- **This skill owns**: Built-in model tool behavior (`read`, `glob`, `grep`, `edit`, `write`, `patch`, foreground/background `shell`, `webfetch`, `websearch`, `question`, `skill`, `subagent`, `todowrite`), `execute` JS Code Mode runtime, `opencode.*` (`session_rename`, `session_move`, `worktree_*`) and Desktop `browser.*` Code Mode namespaces, `tool_output` retention limits, direct vs nested tool permission boundaries.
- **Sibling skills**:
  - `opencode-mcp-servers` — MCP server setup, `codemode: false` direct exposure, `list_mcp_resources` / `read_mcp_resource`.
  - `opencode-permissions` and `opencode-policies` — authoring ordered `{action, resource, effect}` rules, hard `tool.use` policies.
  - `opencode-formatters` — post-edit formatting triggered by `edit`, `write`, `patch`.
  - `opencode-attachments` — `media.image` normalization shared with `read` image loading.
  - `opencode-websearch` — search engine selection, credentials, rate-limit failover.
  - `opencode-skills` and `opencode-agents` — authoring skills, subagent profiles.
  - `opencode-human-input` — answering `question` forms, permission prompts over SDK/HTTP API.
  - `opencode-server-client` — client-side `session.shell`, standalone `shell.*`, PTY endpoints (no generic `client.tool.call` REST endpoint for built-in tools).

Read `references/builtin-tools-and-codemode.md` for per-tool params, caps, permission resources, namespace operations.

## Core Tool Workflow

1. **Choose file or search tool**:
   - `read`: pages UTF-8 text (numbered lines, cap **2,000 lines**, **50 KiB** per page; lines shortened past 2,000 chars), lists immediate dir entries, loads `PNG`/`JPEG`/`GIF`/`WebP`/`PDF` up to 20 MiB source data.
   - `glob`: matches relative paths (default 100 files, 30s timeout).
   - `grep`: searches file contents via regex or `literal: true` (default 100 matching lines, 30s timeout).
   - `edit`: replaces unique (`replaceAll: false`) or all occurrences in existing file.
   - `write`: creates or overwrites file (creates parent dirs).
   - `patch`: applies multi-file `*** Add File` / `*** Update File` / `*** Delete File` (including renames/moves) only on supported OpenAI/GPT models (other models receive `edit` and `write`).
2. **Use `shell` with explicit `workdir` and bounded timeouts**:
   - Pass `workdir` rather than embedding `cd`. Foreground calls default to **10-minute (`600000` ms) timeout**.
   - Set `background: true` for long-running proc; background calls return immediately, notify session on exit, have no timeout unless `timeout` explicitly supplied.
   - Global inline retention: `"tool_output": { "max_lines": 2000, "max_bytes": 51200 }`. Oversized `shell` and `webfetch` outputs shortened inline; full output saved in managed file.
3. **Orchestrate parallel or filtered workflows with Code Mode (`execute`)**:
   - `execute` runs sandboxed JS: no direct disk I/O, no `import`/`require`, no timers. Provides global `fetch` + permitted catalog tools (`opencode.*`, `browser.*`, MCP namespaces).
   - Use `execute` to batch independent reads/queries in parallel; summarize intermediate data before entering model ctx.

## Key Invariants and Gotchas

- **Bounded Child Stdio Drain (`200ms` cap in `shell.ts`) & `600s` Default Timeout**:
  - Foreground `shell` defaults to **10-minute (`600,000` ms)** timeout (`timeout: 600000`).
  - In `shell.ts`, stdout/stderr stream drain races against a **`200ms` timeout** upon child `'exit'` event → prevents backgrounded child processes inheriting open stdio descriptors from hanging tool return until `600,000ms`.
- **Denying `execute` hides Code-Mode-only tools**: `deny` on action `execute` (`resource: "*"`) removes Code Mode and hides every tool exposed exclusively inside it: MCP server tools unless server sets `"codemode": false`, `opencode.*` session/worktree helpers, `browser.*`.
- **Code Mode never bypasses permissions**: Every nested built-in, MCP, or plugin tool invoked inside `execute` enforces own permission rules across affected resources.
- **`grep` checks pattern, NOT search path**: `grep` evaluates permission action `grep` against requested regex/literal `pattern` string—never checks `path` arg. Never rely on `grep` rules to restrict dir access.
- **`patch` model gating**: `patch` advertised only to supported GPT models; prompts/skills targeting non-GPT models must use `edit` and `write`.
- **Safe-boundary `session_move`**: `opencode.session_move` takes effect at safe turn boundary. Destination-dependent file or shell work must run in subsequent call, not later in same `execute` script.
- **`core/codemode` tool consolidation**: In OpenCode (`packages/core/src/session/context.ts`, `core/src/codemode/instructions.ts`), auxiliary utilities (`opencode_models`, `opencode_session_rename`, `opencode_worktree_list`) consolidate into Code Mode single markdown instruction block (`709` tokens) vs individual DSML tool schemas (`2,890–3,350` tokens in `## Tools`).
- **Structured search (`grep.ts`) vs raw file prefill (`plugin/read.ts`)**: `grep.ts` outputs only matching lines (`~400–980` tokens) without emitting entire file ctx or line-number overhead on non-matching lines. Preferred first-wave discovery tool before targeted `read(path, offset, limit)`.
- **Desktop `browser` namespace constraints**: `browser.*` requires attached OpenCode Desktop app (unavailable headless), requires explicit `tabID` every page call, requires focused visible tab for screenshots, caps server-local file uploads/captures at **5 MiB**, treats page DOM/logs/headers as untrusted data, uses single all-or-nothing `browser` `*` deny rule (no per-click prompts).
- **Token accounting traps & line-number prefix bloat**:
  - OpenCode `toModelContent` (`packages/core/src/tool/plugin/read.ts:192`) formats text reads with `Read file <path>, lines A-B` header plus `${line}: ` number prefixes per line. Optional `lineNumbers?: boolean` param (default `false` while retaining `Read file <path>, lines A-B` header) preserves OpenCode `edit` exact `oldString -> newString` matching while saving **`2,103` exact BPE tokens** across 13 file reads (`17,742 -> 15,639` tokens).
  - DeepSeek DSML tool calls cost `~71–75` tokens/call (not `40`t JSON estimates). Verify via `/apply-template` + `/tokenize`.
  - Avoid double-subtracting tools: do not claim savings for tools already inside `core/codemode` (e.g. `opencode_*`) or already `"deny"` in `opencode.json` (e.g. `webfetch`, `websearch`).
- **Zero-truncation discipline & Interior Component-Body Completeness Rule**:
  - Lowering global `read-filesystem.ts` default line/byte caps (e.g. `160L / 8 KiB`) silently truncates tail CSS rules (cutting styles at line 161 in 272-line CSS file) or dense specs (cutting lines 39–77 in 77-line 20 KiB prose doc).
  - **Interior Component-Body Slice Completeness Rule**: Never slice only component headers/tails while omitting `30–50`-line interior helper bodies (intermediate JSX render blocks between `grep` anchors). Extend batched `read` ranges continuously from fn signature through closing `}` of matched component.
  - Skipping middle ranges without checking anchor `grep` hits (slicing `[1:120]` and `[180:277]` while dropping block styles at `L171` or component renderers at `L237`) breaks completeness.
  - Retain safe `2,000L / 50 KiB` ceilings in tool definitions.
  - Workflow: multi-file `grep` anchor discovery first → identify exact symbol/section lines → targeted `read(offset, limit)` slices.
- **Multi-File / Multi-Range Batched `read` + Opt-In Lossless Compaction**:
  - Extending `ReadTool` (`packages/core/src/tool/plugin/read.ts`) with `batch` (`Array<{ path: string, ranges?: Array<[number, number]> }>` or string specs `"path:s1-e1,s2-e2"` exec concurrently via `Effect.forEach(..., { concurrency: 8 })`) allows reading multiple files + line slices in single tool call.
  - Combined with default `lineNumbers = false` + opt-in lossless whitespace/comment/blank-line + `>60`-char inline SVG `<path d="...">` compaction (`compact: true`), collapses 8–13 separate DSML `read` calls (`~950–1,350` DSML output tokens across 4–5 turns) into 1–2 batched calls (`~140–310` DSML tokens across 2 tool turns).
  - **Edit Safety Invariant & CRITICAL GOTCHA on `compact: true` in `read.ts:292`**:
    - **NEVER set `compact: true` as global default** in `read.ts:292` or tool options.
    - `compact: true` strips blank lines, collapses multi-line CSS style blocks `{ ... }` to single lines, truncates `>60`-char JSX SVG paths to `d="[path:Nc]"`.
    - If `compact: true` active during reads preceding `edit` or `patch`, `Patch.derive` verbatim ctx matching fails (target lines diverge from disk), triggering cascading retry failures.
    - **Rule**: Keep global defaults strictly `compact: false, limit: 2000`. Use `compact: true` solely for read-only discovery/audit turns; ensure `compact: false` before generating patches or edits.
- **`@opencode/codemode` (`execute`) sandbox trap**:
  - `execute` runs in isolated V8 JS sandbox without Node `fs` or `child_process`.
  - Built-in FS and shell tools (`read`, `grep`, `glob`, `shell`) hardcode `options: { codemode: false }`; cannot be invoked inside `execute` scripts.
  - `execute` denied on `explore` agents. Never use `execute` as batch wrapper for disk tools; use native `read({ batch: [...] })`.
- **Two-stage `request_synthesis({})` control tool**:
  - Solves pre-generation tool-vs-synthesis blindness on autonomous `general` agents (`steps: undefined`).
  - Without control tool, `llm.ts` cannot determine if turn calls tools or synthesizes final report. Removing tools on final step alters system prompt / tool catalog prefix at token `~2K`, invalidating KV cache.
  - Subagents run discovery/action steps with bounded reasoning budgets (`1024` on `explore`, `2560..4096` on `general`) and `toolChoice: "auto"`.
  - Invoking zero-arg `request_synthesis({})` tool switches runner subsequent turn to `toolChoice: "none"`, elevates `reasoning_budget_tokens` (`2048..2560`), keeps `tools: loaded.tools` 100% byte-identical (`100%` KV prefix hit rate, zero `32,768` cliffs).
- **Multi-file `PatchTool` unlocked for DeepSeek V4.1 (`patch.ts:319-333`)**:
  - Removed `!event.model.id.includes("gpt-")` model gating in `patch.ts`.
  - DeepSeek V4.1 Flash natively emits unified multi-file diffs (`*** Add File:`, `*** Update File:`, `*** Delete File:`) with exact line anchors → atomic multi-file application alongside `write` and `edit`.
