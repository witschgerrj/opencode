---
name: opencode-workspace-files
description: "Resolve OpenCode V2 workspace locations (`location.get`) and integrate raw filesystem (`file.read`, `list`, `find`, binary `file.write`), file watching (`file.watch`/`unwatch` + `filesystem.changed`), `project.list`/`update`, VCS (`vcs.get`, `base`, `status`, `branch.list`, `init`, `diff`), and `worktree` APIs (`worktree.directory` config and `worktree.*`). Use for workspace/VCS/worktree SDK operations; use `opencode-references` for external `references`, `opencode-attachments` for prompt attachments, and `opencode-snapshots` for turn undo/revert."
---

# OpenCode Workspace, Filesystem, VCS, and Worktree APIs

Resolve OpenCode V2 location and project scopes accurately, perform raw binary/directory filesystem operations and watches, inspect VCS diffs and status, and manage project worktrees via `@opencode/client`.

## Scope and Neighbor Boundaries

- **This skill owns**: `location.get` scope resolution (`location[directory]`, `project.id`, `project.canonical`, worktree directory), raw `file.read` / `list` / `find` / `write` and `file.watch` / `unwatch`, `watcher.ignore` config, `project.list` / `update`, `vcs.*` (`get`, `base`, `status`, `branch.list`, `init`, `diff`), and `worktree` config (`worktree.directory`) + `worktree.*` (`list`, `create`, `refresh`, `remove`).
- **Use sibling skills for**:
  - `` `opencode-references` `` — external directory and remote Git `references` aliases and `reference.list`.
  - `` `opencode-attachments` `` — prompt/command attachment inputs (`file:` / `data:`) and `media.image` normalization.
  - `` `opencode-messages-parts` `` — downloading tool output media (`experimental.media.get`).
  - `` `opencode-snapshots` `` — reversible session turn snapshots and undo/revert (VCS diffs and raw `file.write` calls do **not** create reversible session turn checkpoints!).
  - `` `opencode-tools` `` — model-facing `read`, `edit`, `write`, `patch`, `glob`, `grep`, and `opencode.worktree_*` tools.
  - `` `opencode-event-streams` `` — consuming `filesystem.changed` SSE events.

Read [workspace, filesystem, VCS, and worktree contracts](references/workspace-vcs-worktrees.md) for the complete `@opencode/client` endpoint table, binary payload rules, and `worktree.directory` resolution.

## Core Workspace Operations Workflow

1. **Resolve `location` versus `projectID` explicitly**:
   - Call `client.location.get({ location?: { directory? } })` -> `{ directory, project: { id, directory, canonical } }`.
   - Keep `location` (`{ directory }`, encoded as `location[directory]=...` query params), `project.id` (`projectID`), `project.canonical` checkout path, worktree `directory`, and `sessionID` distinct—never substitute display labels or session IDs for filesystem roots or `projectID`.
2. **Handle raw bytes for `file.read` and `file.write`**:
   - `file.read({ path, location? })` (`GET /api/fs/read/<encoded-path>`) returns raw **`Uint8Array`** bytes (do not pass through JSON response unwrappers).
   - `file.write({ path, payload: Uint8Array, location? })` (`POST /api/experimental/fs/write` with `path`/`location` query params) sends a **raw binary `Uint8Array` request body**—**not** JSON `{ content }`! There are no REST partial-edit, delete, or rename endpoints on `client.file`.
   - Use `file.list({ path?, location? })` for single-directory listings and `file.find({ query, type?, limit?, location? })` for recursive path matching (do not silently treat a single-directory `list` fallback as proof a recursive `find` returned everything).
3. **Manage filesystem watches cleanly**:
   - Register via `file.watch({ path, location? })` (`POST /api/experimental/fs/watch` -> `204`), reconcile `filesystem.changed` events via `` `opencode-event-streams` ``, and always `file.unwatch({ path, location? })` (`DELETE`) on disposal or location switch. Exclude noisy build folders via `"watcher": { "ignore": ["dist/**"] }`.
4. **Query VCS state and manage `projectID`-scoped worktrees**:
   - Distinguish `vcs.diff` modes explicitly (`"working"`, `"branch"`, `"committed"`, with `untracked: "files" | "folders"`), and handle `vcs.base` returning `null`. Never call `vcs.init` or `project.update` (`commands.start`) during read-only inspection.
   - Pass resolved `projectID` to `worktree.list`, `refresh`, `create`, and `remove({ projectID, directory, force })`. **`force` is a required boolean** on `worktree.remove`—check `vcs.status` and user intent first, and **never default `force` to `true`** on uncertain removals!

## Key Invariants and Gotchas

- **Model tool names != REST CRUD routes**: Do not invent `/api/fs/edit`, `/api/fs/delete`, or `/api/project/create` HTTP routes based on model tool names; only the pinned `file.*`, `project.list/update`, `vcs.*`, and `worktree.*` contracts exist.
- **`file.watch` `204` is not an initial snapshot**: Subscribing a watch returns no initial file tree or historical changelog—pair `file.watch` with an explicit `file.list` / `file.read` after subscribing.
- **`worktree.directory` resolves against `project.canonical`**: In `opencode.json(c)`, relative `"worktree": { "directory": ".lane/trees" }` always resolves against the project's **saved canonical checkout** (even when configured globally or accessed from another clone sharing the same `projectID`). Changing `worktree.directory` does not relocate existing worktrees.
- **Broad workspace indexing hygiene (`.ignore` file)**:
  - When configuring a workspace root over a broad parent directory containing large model weights (`400+ GiB`), archives, or Python virtualenvs, place a root `.ignore` file (`models/`, `archive/`, `environments/`, `**/.git/`, `**/node_modules/`, `**/target/`, `**/__pycache__/`).
  - Because OpenCode's `/api/fs/find` is ripgrep-backed, it respects `.ignore` to prevent path search crawls from hanging on massive asset trees, while leaving direct `read`, `grep`, and `shell` access to those paths completely unrestricted.
- **Linked `git worktree` local submodule initialization (`protocol.file.allow=always`)**:
  - In modern Git (`>= 2.38.1`), initializing submodules inside linked `git worktree` checkouts referencing local filesystem paths fails with `fatal: transport 'file' not allowed` (CVE-2022-39253 mitigation).
  - Always override the protocol restriction explicitly during worktree setup:
    `git -c protocol.file.allow=always submodule update --init --recursive`.
