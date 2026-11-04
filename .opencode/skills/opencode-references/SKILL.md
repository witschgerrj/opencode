---
name: opencode-references
description: Configure inspect external directory Git repository references cache
  paths async refresh throttles.
---

# OpenCode References

References provide named aliases to external dirs or remote Git repos outside active workspace. Clients attach via alias; agents inspect files on demand.

## Scope and Neighbor Boundaries

- **This skill owns**: `references` config in `opencode.json(c)` (local `path`, Git `repository`/`branch`, shorthand disambiguation, `description`, `hidden`), global Git reference cache storage, 24-hour throttled async clone/refresh rules, alias naming constraints, root attachment behavior, `client.reference.list`.
- **Sibling skills**:
  - `opencode-permissions` — `external_directory`, `read`, `edit` permission rules required for external paths.
  - `opencode-workspace-files` — active workspace `location.get`, `file.*`, `vcs.*`, `worktree.*` ops.
  - `opencode-attachments` — direct `file://`, `data:` prompt attachments, `media.image` normalization.
  - `opencode-instructions` — persistent `AGENTS.md` and `instructions` files injected per session.

Read `references/references-schema.md` for field matrices, storage paths, refresh timelines, API details.

## Core Configuration Workflow

1. **Define valid alias keys under `references`**:
   - Alias non-empty; must NOT contain `/`, `\`, whitespace, backticks (`` ` ``), commas (`,`).
2. **Choose Local (`path`) vs Remote Git (`repository`)**:
   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "references": {
       "product-docs": {
         "path": "../product-docs",
         "description": "Use for product behavior and API terminology"
       },
       "shared": "~/work/shared",          // Local shorthand (starts with ., /, or ~)
       "effect": {
         "repository": "Effect-TS/effect",
         "branch": "main",
         "description": "Use for Effect TypeScript patterns",
         "hidden": false
       }
     }
   }
   ```
   - **Local relative paths**: resolve from dir containing config file (not session CWD).
   - **Git entries**: accept GitHub `owner/repo` shorthand, HTTPS Git URLs, `host/path` (`gitlab.com/org/repo`), SCP SSH (`git@host:org/repo.git`). Local `file:` Git URLs rejected.
3. **Align `external_directory` and `read` permissions**:
   - Reference config never grants extra tool permissions. If `external_directory` or `read` restricted (or locked via `opencode-policies`), explicitly allow resolved reference dir (or global `repos` cache dir) in `permissions`.
4. **Attach and traverse**:
   - Attaching alias injects non-recursive listing of immediate root files and dirs. Agent must call `read` (or `glob`/`grep`) on specific descendant paths under root.

## Key Invariants and Gotchas

- **Bare string shorthand = Git, NOT local**: String shorthand local ONLY when starting with `.`, `/`, `~` (e.g. `"./docs"`, `"../docs"`, `"/opt/docs"`, `"~/docs"`). `"docs": "docs"` treats `"docs"` as remote Git repo!
- **Prompt guidance requires `description`**: References with `description` auto-advertised in agent system instructions with alias + resolved path; references lacking `description` stay in API/client menus (unless hidden) without auto prompt hints.
- **`hidden: true` only hides interactive UI menus**: Hidden reference still appears in `reference.list({ location })` res and injected into instructions if `description` present.
- **Prompts never wait for async Git clone/refresh**:
  - Missing Git checkouts clone async; existing checkouts check background refresh on reference load/reload and user prompt admission (throttled: 1 per 24 hours per shared checkout, persisted across restarts; failed attempts also trigger 24-hour cooldown; 0 idle polling).
  - Attached alias can reflect stale cached files (or unfinished clone) while subsequent `read` tool call in same turn sees refreshed files.
- **Never edit cached Git reference checkouts**: Global checkouts under `<data-dir>/opencode/repos/<host>/<repo>[@<branch>]` shared across workspaces. Background refreshes fetch + hard-reset tracked branch, wiping local edits.
- **`ReferenceInstructions` & Context Prefill Discipline**: Core (`packages/core/src/reference/instructions.ts`) dynamically injects references having `description` into layer 3 system instructions via `<available_references><reference><name>...</name><path>...</path><description>...</description></reference></available_references>`. Avoid unconstrained whole-file `read` on large repos (bloats prefill context via line prefixes). Compound search flow: regex `grep` to pinpoint exact declaration/selector lines → bounded `read(path, offset, limit)` slices → 100% coverage, >50% token reduction.
