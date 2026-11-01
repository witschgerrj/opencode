---
name: opencode-skills
description: Configure, discover, prioritize, permit, and load OpenCode V2 skills across local roots, configured paths, and HTTP index.json catalogs. Use for skill discovery precedence, path-derived IDs, autoinvoke metadata, @skill-id mentions, skill permissions, and skill API contracts; use create-skill for authoring and validating skill content.
---

# OpenCode Skills Discovery, Precedence, and Loading

OpenCode V2 skills package task-specific instructions and private supporting files (`references/`, `scripts/`) so agents load them on demand via the `skill` tool or `@skill-id` prompt mentions instead of bloating every system prompt.

## Boundaries with Neighbor Skills

- **Authoring, structuring, and running `validate_skills.py` on a skill**: Use `create-skill`.
- **Slash command prompt templates (`.opencode/commands/`)**: Use `opencode-commands`.
- **Always-on ambient `AGENTS.md` instructions**: Use `opencode-instructions`.
- **General permission rule evaluation and live approval prompts**: Use `opencode-permissions` and `opencode-human-input`.

## Core Workflow

1. **Trace discovery roots and exact path-derived IDs**:
   - OpenCode automatically scans global (`~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`), system, and upward project (`.opencode/skills`, `.claude/skills`, `.agents/skills`) roots, plus additive `"skills": [...]` config paths and HTTP `index.json` catalogs.
   - The file path strictly determines the **case-sensitive** skill ID (`<source>/git-release/SKILL.md` -> `git-release`; `<source>/teams/release/SKILL.md` -> `release`; root `<source>/review.md` -> `review`). Frontmatter `name` is only a display label.
   - Read [discovery precedence, HTTP catalogs, loading, and wire contracts](references/discovery-and-loading.md) for full ordering and HTTP catalog schemas.
2. **Distinguish registered, advertised, permitted, and loaded states**:
   - At each model step, OpenCode advertises only `{ id, name, description }` for skills that have a non-empty `description`, do not disable auto-invocation, and are not denied by the active agent's `skill` permissions.
   - Setting `opencode/autoinvoke` to `false` under `metadata` (or `disable-model-invocation` to `true`) hides a skill from automatic model listings while keeping it loadable explicitly by exact ID (`@skill-id` or explicit `skill` tool / API call).
3. **Diagnose missing or shadowed skills systematically**:
   - Check in order: (1) exact uppercase `SKILL.md` (or root-level `*.md`) within 6 directory levels, (2) exact path-derived ID casing, (3) non-empty `description`, (4) `opencode/autoinvoke` and `skill` permissions / `policies`, (5) later higher-precedence sources overriding the same ID, and (6) HTTP catalog `index.json` `version` bumps.

## Critical Invariants and Gotchas

- **Display `name` is never a valid skill ID**: Calling the `skill` tool, `@skill-id`, or `session.skill` with `"Git Release"` instead of `"git-release"` fails with an unknown-ID error.
- **Relative `skills` config paths resolve from the active working directory**: Unlike `plugins` and `references` (which resolve relative to the containing `opencode.json(c)` file), relative entries in `"skills": ["./team-skills"]` resolve from OpenCode's **active working directory**.
- **`SKILL.md` stops deeper directory scanning**: Any folder containing `SKILL.md` is treated as one skill leaf; nested `SKILL.md` files inside it are ignored and hidden. Flat `*.md` skills are discovered **only** at a source root, never in subfolders, and do not receive a 10-file supporting path sample on load.
- **Loading a skill never grants tool permissions**: Injecting a skill's Markdown body does not authorize `shell`, `edit`, `webfetch`, or other tools recommended inside those instructions; normal agent permissions and system policies still apply.
- **Supporting files load lazily**: Loading a skill injects its frontmatter-stripped Markdown body, base directory path, and up to 10 sample neighbor file paths—never the contents of `references/` or `scripts/`. The agent reads supporting files on demand. Never read entire reference catalogs if only specific sections or rows are needed.
- **`<available_skills>` XML catalog bloat & `autoinvoke: false` scoping**:
  - An unfiltered global+project catalog of 50+ skills injects `5,000–6,500+` XML tokens into every prompt turn (the rendered `<available_skills>` XML format is `~20%` larger than raw JSON instruction blobs).
  - Adding `metadata.opencode/autoinvoke: false` (or `disable-model-invocation: true`) to frontmatter strips admin-only, platform-authoring, or meta skills from the automatic XML catalog while preserving explicit `@skill-id` and `skill` tool loading.
- **Runtime V2 vs portable conventions**: OpenCode V2 runtime treats all frontmatter as optional and does not enforce lowercase kebab-case, 1-64 char length, or `name == id`; enforce those rules via `` `create-skill` `` for cross-repo portability without mislabeling them as V2 runtime errors.
- **Orthogonal roles of `autoinvoke: true` vs `subagent` permissions**:
  - `autoinvoke: true` (default) publishes the skill's `{ id, name, description }` inside the `<available_skills>` prompt catalog, enabling the top-level agent to discover and load domain guidance on demand via the `skill` tool.
  - `autoinvoke: false` (or `metadata.opencode/autoinvoke: false` / `disable-model-invocation: true`) hides the skill from automatic discovery while keeping it loadable via manual `/skill` user commands or explicit `@skill-id` prompt mentions.
  - This is **completely orthogonal to `subagent` permissions**: `subagent` permissions govern delegating work to independent child agents (`explore`, custom subagents) running in separate sessions, whereas `skill` permissions and `autoinvoke` govern loading Markdown instructions directly into the active session context.
