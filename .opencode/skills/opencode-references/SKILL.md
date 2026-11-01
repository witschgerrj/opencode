---
name: opencode-references
description: "Configure and inspect OpenCode V2 named external directory and Git repository `references`, local versus Git shorthand rules, global cache paths, 24-hour async refresh throttling, `description` guidance, `hidden` selectors, and `reference.list` contracts. Use for outside supporting directories/repos; use `opencode-workspace-files` for active project files/worktrees and `opencode-attachments` for direct file/data prompt attachments."
---

# OpenCode References

References give OpenCode named aliases to directories or remote Git repositories outside the active project workspace so clients can attach them by alias and agents can inspect their files on demand.

## Scope and Neighbor Boundaries

- **This skill owns**: `references` configuration in `opencode.json(c)` (local `path`, Git `repository`/`branch`, shorthand disambiguation, `description`, `hidden`), global Git reference cache storage, 24-hour throttled async clone/refresh rules, alias naming constraints, root attachment behavior, and `client.reference.list`.
- **Use sibling skills for**:
  - `` `opencode-permissions` `` — `external_directory`, `read`, and `edit` permission rules required for agents to read or edit referenced external paths.
  - `` `opencode-workspace-files` `` — active workspace `location.get`, `file.*`, `vcs.*`, and `worktree.*` operations.
  - `` `opencode-attachments` `` — direct `file://` and `data:` prompt attachments and `media.image` normalization.
  - `` `opencode-instructions` `` — persistent `AGENTS.md` and `instructions` files injected in full on every session.

Read [references schema, cache, and SDK contracts](references/references-schema.md) for field matrices, storage paths, refresh timelines, and API details.

## Core Configuration Workflow

1. **Define valid alias keys under `references`**:
   - Aliases cannot be empty and **must not** contain `/`, `\`, whitespace, backticks (`` ` ``), or commas (`,`).
2. **Choose Local (`path`) vs Remote Git (`repository`) accurately**:
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
   - **Local relative paths** resolve from the **directory containing the config file** (not the session's current working directory).
   - **Git entries** accept GitHub `owner/repo` shorthand, HTTPS Git URLs, `host/path` (`gitlab.com/org/repo`), and SCP SSH (`git@host:org/repo.git`). Local `file:` Git URLs are rejected.
3. **Align `external_directory` and `read` permissions**:
   - Configuring a reference **never grants extra tool permissions**. If `external_directory` or `read` is restricted (or locked down by `` `opencode-policies` ``), explicitly allow the resolved reference directory (or global `repos` cache directory) in `permissions`.
4. **Attach and traverse**:
   - Attaching an alias injects a **non-recursive listing** of immediate root files and directories. Instruct or allow the agent to call `read` (or `glob`/`grep`) on specific descendant paths below the root.

## Key Invariants and Gotchas

- **Bare string shorthand means Git, NOT local**: A string shorthand is local **only** when it starts with `.`, `/`, or `~` (e.g., `"./docs"`, `"../docs"`, `"/opt/docs"`, `"~/docs"`). Writing `"docs": "docs"` treats `"docs"` as a remote Git repository!
- **Prompt guidance requires `description`**: References with a `description` are automatically advertised in agent system instructions with their alias and resolved path; references without `description` remain in the API and client menus unless hidden, but receive no automatic system-prompt hint.
- **`hidden: true` only hides interactive UI menus**: A hidden reference still appears in `reference.list({ location })` responses and—if it has a `description`—is still injected into agent instructions.
- **Prompts never wait for async Git clone or refresh**:
  - Missing Git checkouts clone asynchronously; existing checkouts check for background refresh on reference load/reload and upon user prompt admission (throttled to **once per 24 hours** per shared checkout, persisted across restarts, with failed attempts also subject to the 24-hour cooldown and zero polling while idle).
  - An attached alias may reflect older cached files (or an unfinished clone) while a later `read` tool call in the same turn sees newly refreshed files.
- **Never edit cached Git reference checkouts**: Global checkouts under `<data-dir>/opencode/repos/<host>/<repo>[@<branch>]` are shared across workspaces, and background refreshes fetch and hard-reset to the tracked branch, wiping local edits.
- **`ReferenceInstructions` & Context Prefill Discipline**: OpenCode core (`packages/core/src/reference/instructions.ts`) dynamically injects references having a `description` into layer 3 of system instructions via `<available_references><reference><name>...</name><path>...</path><description>...</description></reference></available_references>`. When inspecting large referenced codebases, avoid unconstrained whole-file `read` calls (which compound with line-number prefixes to bloat prefill context). Adopt a compound search strategy: execute targeted regex `grep` to pinpoint exact declaration or selector lines, then follow with bounded `read(path, offset, limit)` slices to retain 100% factual coverage while cutting prefill token consumption by more than half.
