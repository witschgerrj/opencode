---
name: opencode-skills
description: Configure discover prioritize permit load OpenCode V2 skills across local
  roots config paths HTTP index catalogs
---

# OpenCode Skills Discovery Precedence Loading

OpenCode V2 skills package task instructions + supporting files (`references/`, `scripts/`). Loaded on demand via `skill` tool or `@skill-id` mention. Prevents prompt bloat.

## Boundaries With Neighbor Skills

- **Author, structure, run `validate_skills.py`**: Use `create-skill`.
- **Slash command templates (`.opencode/commands/`)**: Use `opencode-commands`.
- **Ambient `AGENTS.md` instructions**: Use `opencode-instructions`.
- **Permission rules + live approval prompts**: Use `opencode-permissions` + `opencode-human-input`.

## Core Workflow

1. **Trace discovery roots + path-derived IDs**:
   - Auto-scans global (`~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`), system, upward project (`.opencode/skills`, `.claude/skills`, `.agents/skills`) roots, additive `"skills": [...]` config paths, HTTP `index.json` catalogs.
   - File path strictly determines **case-sensitive** skill ID: `<source>/git-release/SKILL.md` → `git-release`; `<source>/teams/release/SKILL.md` → `release`; root `<source>/review.md` → `review`. Frontmatter `name` = display label only.
   - Read `references/discovery-and-loading.md` for ordering + HTTP catalog schemas.
2. **Distinguish states**:
   - Model advertises `{ id, name, description }` if non-empty `description`, autoinvoke enabled, not denied by agent `skill` permissions.
   - Set `metadata.opencode/autoinvoke: false` (or `disable-model-invocation: true`) → hides skill from auto listings, keeps loadable via exact ID (`@skill-id` or explicit `skill` tool/API call).
3. **Diagnose missing or shadowed skills**:
   - Check sequence: (1) exact uppercase `SKILL.md` (or root `*.md`) ≤ 6 dir levels deep → (2) exact path ID casing → (3) non-empty `description` → (4) `opencode/autoinvoke` + `skill` permissions/`policies` → (5) higher-precedence source override → (6) HTTP catalog `index.json` `version` bumps.

## Critical Invariants and Gotchas

- **Display `name` never valid skill ID**: Calling `skill` tool, `@skill-id`, or `session.skill` with `"Git Release"` instead of `"git-release"` → fails unknown-ID err.
- **Relative `skills` config paths resolve from CWD**: Unlike `plugins`/`references` (resolve relative to `opencode.json(c)`), relative entries in `"skills": ["./team-skills"]` resolve from active working dir.
- **`SKILL.md` stops deeper dir scan**: Dir containing `SKILL.md` = skill leaf. Nested `SKILL.md` ignored. Flat `*.md` discovered **only** at source root, never subfolders; receives no 10-file sample on load.
- **Loading skill grants zero tool permissions**: Injected body does not authorize `shell`, `edit`, `webfetch`. Agent permissions + policies enforce separately.
- **Supporting files load lazily**: Skill load injects stripped markdown body, base dir path, ≤ 10 sample neighbor file paths. Never injects `references/` or `scripts/` contents. Agent reads on demand. Do not read entire catalogs if target subset suffices.
- **`<available_skills>` XML catalog bloat & `autoinvoke: false` scoping**:
  - Unfiltered catalog of 50+ skills injects `5,000–6,500+` XML tokens/turn (`~20%` larger than raw JSON).
  - Add `metadata.opencode/autoinvoke: false` (or `disable-model-invocation: true`) to strip admin/platform/meta skills from auto XML catalog while preserving explicit `@skill-id` + `skill` tool loads.
- **Global-First Skill Sorting (`isGlobalOrSystemSkill` in `packages/core/src/skill/instructions.ts`)**:
  - `SkillInstructions.load` sorts global/system/builtin skills (`~/.config/opencode/skills`, `/etc/opencode/skills`, `/builtin/`) ahead of project-local skills (`.opencode/skills/`) via `isGlobalOrSystemSkill()`, preserving alphabetical `id.localeCompare` order per tier → maximizes `<available_skills>` prefix stability across workspaces.
- **Large Project Skill/Agent Catalogs (`open-world` / `aurelith` Case Study) & `epoch_prefix` Protection**:
  - `128` project skills + `57` project agents expand `frozen_initial` + `frozen_hooked_tools_json` (`~36.5K` tok pre-Caveman Ultra; `-42%` post-Caveman Ultra).
  - OpenCode `epoch_prefix` table (`SessionEpochPrefix`) freezes `frozen_initial` + `frozen_hooked_tools_json` at session init → Turns 2+ restore exact frozen prefix (`96–99.7%` KV cache hit rate, `1.47s–12.67s` TTFT).
- **Runtime V2 vs portable conventions**: OpenCode V2 runtime treats all frontmatter optional (does not enforce kebab-case, 1-64 char length, `name == id`). Enforce via `create-skill` for cross-repo portability.
- **`autoinvoke: true` vs `subagent` permissions**:
  - `autoinvoke: true` (default) publishes `{ id, name, description }` inside `<available_skills>` prompt catalog → top-level agent loads via `skill` tool.
  - `autoinvoke: false` (or `metadata.opencode/autoinvoke: false` / `disable-model-invocation: true`) hides skill from auto catalog; loadable via `/skill` or `@skill-id`.
  - Orthogonal to `subagent` permissions: `subagent` governs delegating to child agents (`explore`, subagents) in separate sessions; `skill` permissions + `autoinvoke` govern injecting markdown into active ctx.
