---
name: opencode-agents
description: Configure, select, orchestrate OpenCode V2 primary agents, subagent trees,
  child-session discovery, and family settlement.
---

# OpenCode Agents and Subagents

OpenCode V2 agent bundles system prompt, model preference, exec mode, step limit, ordered permissions, UI metadata into named profile.

## Boundaries with Neighbor Skills

- Model catalog, variants, API compatibility: Use `opencode-models` (and `opencode-providers` for credentials/endpoints).
- Permission matching, wildcards, saved grants, live approval prompts: Use `opencode-permissions`, `opencode-human-input`.
- Root session creation, prompt turns, forking, deletion: Use `opencode-session-lifecycle`.
- Slash commands switching agents or spawning background runs: Use `opencode-commands`.

## Core Workflow

1. **Choose definition scope and format**:
   - Reusable profiles: Markdown files in `~/.config/opencode/agents/<name>.md` (global), system config `agents/`, `.opencode/agents/<name>.md` (project upward discovery), or inline under `agents` in `opencode.json(c)`.
   - Nested dirs form slash-scoped IDs (`.opencode/agents/team/reviewer.md` → `team/reviewer`).
   - Read `references/configuration.md` for V2 fields, `default_agent` fallback rules, V1 migration caveats.
2. **Separate primary selection from subagent delegation**:
   - `mode: "primary"` (default custom agents) runs as main session agent; `mode: "subagent"` runs only child sessions via `subagent` tool; `mode: "all"` supports both.
   - Inspect live `agent.list({ location })` / `agent.get({ agentID, location })` metadata for actual `mode`, `hidden`, `permissions` (do not infer from display labels).
3. **Orchestrate and verify child-session trees**:
   - Subagents exec with fresh ctx, own configured `permissions`, configured `model` (inherit parent model only when unset).
   - Display, await, stop subagent trees: follow `references/child-sessions.md`.

## Critical Invariants and Gotchas

- **Switching primary agents never changes session model**: Sessions store selected model independently. `session.switchAgent` (`POST /api/session/:id/agent`) changes only active agent. Changing `default_agent` in config never alters existing sessions.
- **Subagent tool-schema budgeting via `permissions`**: Subagent sessions assemble prompts with tool schemas for all permitted tools. Specialized subagents (research/review) must configure explicit `deny` rules on unused heavy tools (`execute`, `write`, `edit`, `patch`, `todowrite`) to trim schemas, minimize prompt prefill latency.
- **Parent permissions gate target IDs, not child tools**: Parent `{ "action": "subagent", "resource": "<agent-id>", "effect": "..." }` rule controls *which* subagents launch; never restricts child tool permissions once launched.
- **`hidden: true` is visibility, not security**: Hidden agents vanish from pickers, `subagent` tool catalog. Permissions enforce access control. Built-in hidden `compaction`, `title`, `summary` cannot be selected directly (V1 `scout` agent deleted in V2).
- **`request` overlays inert**: V2 preserves `agents.<id>.request` (`headers`, `body`) in config, but session runner does not send with model reqs. Put active `headers`, `body`, sampling settings on provider, model, or model `#variant`.
- **Permission ordering and home expansion**: Global `permissions` apply before `agents.<id>.permissions`. Last matching rule wins (broad denies/asks before narrow allows). `~` and `$HOME` expand for `read`, `edit`, `external_directory` resources. `shell` resources match raw command text without home expansion.
- **Root idle can precede background child delivery**: Parent session can become idle while background subagent still runs or before completion message wakes parent inbox. Never treat single root-idle event or root stop call as proof descendant family settled.
- **Child `#max` variant inheritance trap (`subagent.ts:187`)**: Child spawns without variant override inherited Root `#max` variant (`effort: "max"`, `-1` unbounded `<think>`) → spiral into `32,768`-token `finish="length"` cliffs. In `subagent.ts:187`, child spawns (`!!parentID`) without overrides default to `#subagent-high` (`effort: "high"` [75], `reasoning_budget_tokens: 4096`), fallback `#high` (`effort: "high"`, `reasoning_budget_tokens: 8192`).
- **Deterministic `id_slot` affinity and multi-agent KV isolation**: In multi-slot deployments (`--parallel 3`), Root sessions pin to `id_slot: 0`; concurrent child subagents lease `id_slot: 1`, `id_slot: 2` (forwarded via `request.http.body` in `http.ts:35-41`). Prevents cross-slot KV cache eviction and SWA ring buffer thrashing between parent orchestrators, background subagents.
- **Dual-layer `explore` `"shell": "deny"` lockdown (`config/plugin/agent.ts:83-91`)**: Setting `"shell": "deny"` only in built-in `packages/core/src/plugin/agent.ts:82` overridden if top-level `opencode.json` `permissions` has `{ "action": "shell", "effect": "allow" }` (top-level merges *after* built-in agent permissions; lastMatch wins). Mandatory dual-layer: lock `plugin/agent.ts:82` AND add terminal rule `{ "action": "shell", "resource": "*", "effect": "deny" }` in `agents.explore.permissions` in `opencode.json`.
- **3-Way security allowlist requirement for new built-in tools**: Hardened envs with default-deny policies (`tool.use: * -> deny`) and permissions (`*: * -> deny`): any new built-in tool (e.g. `request_synthesis`) requires explicit allow in 3 places:
  1. Top-level `permissions`
  2. Agent-level `agents.<id>.permissions` (both `general`, `explore`)
  3. Top-level `policies` (`{ "action": "tool.use", "resource": "request_synthesis:*", "effect": "allow" }`)
  Missing any blocks invocation.
