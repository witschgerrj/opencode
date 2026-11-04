---
name: opencode-workspace-files
description: Resolve OpenCode V2 workspace location scopes, execute raw FS byte operations,
  handle file watches, inspect VCS diffs, manage worktrees. Trigger when resolving
  locations or invoking workspace, filesystem, VCS, worktree APIs.
---

# OpenCode Workspace, FS, VCS, Worktree APIs

Resolve OpenCode V2 location/project scopes, perform raw binary/dir FS operations and watches, inspect VCS diffs/status, manage project worktrees via `@opencode/client`.

## Scope & Neighbor Boundaries

- **Owns**: `location.get` scope resolution (`location[directory]`, `project.id`, `project.canonical`, worktree dir), raw `file.read`/`list`/`find`/`write`, `file.watch`/`unwatch`, `watcher.ignore` config, `project.list`/`update`, `vcs.*` (`get`, `base`, `status`, `branch.list`, `init`, `diff`), worktree config (`worktree.directory`), `worktree.*` (`list`, `create`, `refresh`, `remove`).
- **Sibling skills**:
  - `opencode-references` — external dir/remote Git `references` aliases, `reference.list`.
  - `opencode-attachments` — prompt/command attachment inputs (`file:` / `data:`), `media.image` normalization.
  - `opencode-messages-parts` — download tool output media (`experimental.media.get`).
  - `opencode-snapshots` — reversible session turn snapshots, undo/revert (VCS diffs, raw `file.write` do NOT create reversible session turn checkpoints).
  - `opencode-tools` — model-facing `read`, `edit`, `write`, `patch`, `glob`, `grep`, `opencode.worktree_*` tools.
  - `opencode-event-streams` — consume `filesystem.changed` SSE events.

Read `references/workspace-vcs-worktrees.md` for complete `@opencode/client` endpoint table, binary payload rules, `worktree.directory` resolution.

## Core Workspace Operations Workflow

1. **Resolve `location` vs `projectID` explicitly**:
   - Call `client.location.get({ location?: { directory? } })` → `{ directory, project: { id, directory, canonical } }`.
   - Keep `location` (`{ directory }`, encoded as `location[directory]=...` query params), `project.id` (`projectID`), `project.canonical` checkout path, worktree `directory`, `sessionID` distinct. Never substitute display labels or session IDs for FS roots or `projectID`.
2. **Handle raw bytes for `file.read` and `file.write`**:
   - `file.read({ path, location? })` (`GET /api/fs/read/<encoded-path>`) → raw `Uint8Array` bytes (no JSON response unwrapping).
   - `file.write({ path, payload: Uint8Array, location? })` (`POST /api/experimental/fs/write` with `path`/`location` query params) → sends raw binary `Uint8Array` req body (NOT JSON `{ content }`). No REST partial-edit, delete, or rename endpoints on `client.file`.
   - Use `file.list({ path?, location? })` for single-dir listings.
   - Use `file.find({ query, type?, limit?, location? })` for recursive path matching. Never treat single-dir `list` fallback as recursive `find` completion.
3. **Manage FS watches cleanly**:
   - Register: `file.watch({ path, location? })` (`POST /api/experimental/fs/watch` → `204`).
   - Reconcile `filesystem.changed` events via `opencode-event-streams`.
   - Teardown: always `file.unwatch({ path, location? })` (`DELETE`) on disposal or location switch.
   - Exclude noisy build dirs via `"watcher": { "ignore": ["dist/**"] }`.
4. **Query VCS state & manage `projectID`-scoped worktrees**:
   - Distinguish `vcs.diff` modes explicitly (`"working"`, `"branch"`, `"committed"`, with `untracked: "files" | "folders"`).
   - Handle `vcs.base` returning `null`.
   - Never call `vcs.init` or `project.update` (`commands.start`) during read-only inspection.
   - Pass resolved `projectID` to `worktree.list`, `refresh`, `create`, `remove({ projectID, directory, force })`.
   - `force` required boolean on `worktree.remove` → check `vcs.status` + user intent first; never default `force: true`.

## Key Invariants & Gotchas

- **Model tool names != REST CRUD routes**: No `/api/fs/edit`, `/api/fs/delete`, or `/api/project/create` HTTP routes. Only pinned `file.*`, `project.list/update`, `vcs.*`, `worktree.*` contracts exist.
- **`file.watch` `204` returns no initial snapshot**: Watch sub returns no initial file tree or historical changelog. Pair `file.watch` with explicit `file.list` / `file.read` post-subscription.
- **`worktree.directory` resolves against `project.canonical`**: In `opencode.json(c)`, relative `"worktree": { "directory": ".lane/trees" }` resolves against project saved canonical checkout (even if configured globally or accessed via clone sharing same `projectID`). Changing `worktree.directory` does not relocate existing worktrees.
- **Broad workspace indexing hygiene (`.ignore` file)**:
   - Broad parent dir with large model weights (`400+ GiB`), archives, or Python virtualenvs → place root `.ignore` file (`models/`, `archive/`, `environments/`, `**/.git/`, `**/node_modules/`, `**/target/`, `**/__pycache__/`).
   - `/api/fs/find` ripgrep-backed → respects `.ignore` to prevent path search hangs on massive trees while leaving direct `read`, `grep`, `shell` access unrestricted.
- **Linked `git worktree` local submodule init (`protocol.file.allow=always`)**:
   - Git `>= 2.38.1` fails submodule init in linked `git worktree` referencing local FS paths with `fatal: transport 'file' not allowed` (CVE-2022-39253 mitigation).
   - Override protocol restriction explicitly:
     `git -c protocol.file.allow=always submodule update --init --recursive`.
