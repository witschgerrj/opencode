---
name: opencode-agents
description: Configure, select, and orchestrate OpenCode V2 primary agents and foreground or background subagents, including child-session discovery and family settlement. Use for agent profiles, modes, step limits, and child-session trees; use opencode-models for model catalogs/variants, opencode-permissions for permission rule syntax, and opencode-session-lifecycle for root session management.
---

# OpenCode Agents and Subagents

An OpenCode V2 agent bundles a system prompt, model preference, execution mode, step limit, ordered permissions, and UI metadata into a named profile.

## Boundaries with Neighbor Skills

- **Model catalog, variants, and API compatibility**: Use `opencode-models` (and `opencode-providers` for provider credentials/endpoints).
- **Permission matching, wildcards, saved grants, and live approval prompts**: Use `opencode-permissions` and `opencode-human-input`.
- **Root session creation, prompt turns, forking, and deletion**: Use `opencode-session-lifecycle`.
- **Slash commands that switch agents or spawn background runs**: Use `opencode-commands`.

## Core Workflow

1. **Choose the definition scope and format**:
   - Author reusable profiles as Markdown files in `~/.config/opencode/agents/<name>.md` (global), system config `agents/`, or `.opencode/agents/<name>.md` (project upward discovery), or inline under `agents` in `opencode.json(c)`.
   - Nested folders form slash-scoped IDs (`.opencode/agents/team/reviewer.md` -> `team/reviewer`).
   - Read [agent configuration, built-ins, and merging](references/configuration.md) for all V2 fields, `default_agent` fallback rules, and V1 migration caveats.
2. **Separate primary selection from subagent delegation**:
   - `mode: "primary"` (the default for new custom agents) runs as the main session agent; `mode: "subagent"` runs only in child sessions via the `subagent` tool; `mode: "all"` supports both.
   - Inspect live `agent.list({ location })` / `agent.get({ agentID, location })` metadata for actual `mode`, `hidden`, and `permissions` rather than inferring behavior from display labels.
3. **Orchestrate and verify child-session trees**:
   - Subagents execute with fresh context, their own configured `permissions`, and their configured `model` (inheriting the parent session's model only when unset).
   - When building clients or orchestrators that display, await, or stop subagent trees, follow [child-session discovery, wire contracts, and family settlement](references/child-sessions.md).

## Critical Invariants and Gotchas

- **Switching primary agents never changes the session model**: Sessions store their selected model independently. `session.switchAgent` (`POST /api/session/:id/agent`) changes only the active agent, and changing `default_agent` in config never alters existing sessions.
- **Subagent tool-schema budgeting via `permissions`**: Subagent sessions assemble prompts with tool schemas for all permitted tools. Specialized subagents (such as research or review agents) should configure explicit `deny` rules on unused heavy tools (`execute`, `write`, `edit`, `patch`, `todowrite`) to trim tool schemas and minimize prompt prefill latency.
- **Parent permissions gate target IDs, not child tools**: A parent agent's `{ "action": "subagent", "resource": "<agent-id>", "effect": "..." }` rule controls *which* subagents it can launch, but never restricts the child's own tool permissions once launched.
- **`hidden: true` is visibility, not security**: Hidden agents vanish from pickers and the `subagent` tool catalog, but permissions—not `hidden`—enforce access control. Built-in hidden `compaction`, `title`, and `summary` agents cannot be selected directly (and V1's `scout` agent does not exist in V2).
- **`request` overlays are currently inert**: OpenCode V2 preserves `agents.<id>.request` (`headers` and `body`) in config, but the V2 session runner does **not** send them with model requests yet. Put active `headers`, `body`, or sampling settings on a provider, model, or model `#variant` instead.
- **Permission ordering and home expansion**: Global `permissions` apply before `agents.<id>.permissions`, and the **last matching rule wins** (place broad denies/asks before narrow allows). `~` and `$HOME` expand for `read`, `edit`, and `external_directory` resources, whereas `shell` resources match raw command text without home expansion.
- **Root idle can precede background child delivery**: A parent session can become idle while a background subagent is still running or before its completion message wakes the parent inbox. Never treat a single root-idle event or a single root stop call as proof that the entire descendant family has settled.
- **Child `#max` variant inheritance trap (`subagent.ts:187`)**: Spawning a child subagent without an explicit variant override previously inherited the Root session's `#max` variant (`effort: "max"`, `-1` unbounded `<think>`), causing subagents to spiral into `32,768`-token `finish="length"` cliffs on intermediate discovery steps. In `subagent.ts:187`, child spawns (`!!parentID`) without explicit overrides default to `#subagent-high` (`effort: "high"` [75], `reasoning_budget_tokens: 4096`), falling back to `#high` (`effort: "high"`, `reasoning_budget_tokens: 8192`).
- **Deterministic `id_slot` affinity and multi-agent KV isolation**: In multi-slot deployments (`--parallel 3`), Root sessions pin to `id_slot: 0`, while concurrent child subagents lease `id_slot: 1` and `id_slot: 2` distinctly (forwarded via `request.http.body` in `http.ts:35-41`). This prevents cross-slot KV cache eviction and SWA ring buffer thrashing between parent orchestrators and background subagents.
- **Dual-layer `explore` `"shell": "deny"` lockdown (`config/plugin/agent.ts:83-91`)**: Setting `"shell": "deny"` only in built-in `packages/core/src/plugin/agent.ts:82` is overridden if top-level `opencode.json` `permissions` contains `{ "action": "shell", "effect": "allow" }`, because OpenCode merges top-level permissions *after* built-in agent permissions (`lastMatch` wins). To prevent `explore` from running rogue `/tmp/opencode` shell scripts, dual-layer enforcement is mandatory: keep `plugin/agent.ts:82` locked AND explicitly add `{ "action": "shell", "resource": "*", "effect": "deny" }` as the terminal rule in `agents.explore.permissions` in `opencode.json`.
- **3-Way security allowlist requirement for new built-in tools**: In hardened environments with default-deny policies (`tool.use: * -> deny`) and permissions (`*: * -> deny`), any new built-in tool (such as `request_synthesis`) must be explicitly allowed in three distinct places: (1) top-level `permissions`, (2) agent-level `agents.<id>.permissions` (for both `general` and `explore`), and (3) top-level `policies` (`{ "action": "tool.use", "resource": "request_synthesis:*", "effect": "allow" }`). Missing any one of the three blocks tool invocation.
