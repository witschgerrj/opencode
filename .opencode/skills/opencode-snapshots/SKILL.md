---
name: opencode-snapshots
description: Use, configure, and integrate OpenCode V2 per-step Git object snapshots, /undo and /redo staged rollbacks, message-boundary reverts, and session diff/revert wire contracts. Use for coupled conversation-and-file undo semantics; use opencode-workspace-files for general VCS review, opencode-session-lifecycle for session forks, and opencode-compaction for context summarization.
---

# OpenCode Snapshots, Diffs, and Staged Rollbacks

OpenCode V2 captures best-effort filesystem snapshots around each model step inside a separate internal Git object store so `/undo`, `/redo`, and `session.revert` can roll back conversation turns and attributed workspace file edits together.

## Boundaries with Neighbor Skills

- **General repository Git status, branch diffs, and file reads**: Use `opencode-workspace-files`.
- **Branching into a parallel session without overwriting current history (forking)**: Use `opencode-session-lifecycle`.
- **Summarizing older turns to fit model context limits**: Use `opencode-compaction`.
- **Inspecting assistant message snapshot metadata (`snapshot.start/end/files`) and SSE revert events**: Use `opencode-messages-parts` and `opencode-event-streams`.

## Core Workflow

1. **Inspect session diffs and dirty worktree edits before rolling back**:
   - Check `git status --short` / `git diff` and `session.diff({ sessionID, from?, to?, context? })` before invoking `/undo` or `session.revert.stage`.
   - Confirm the target session is **idle** (OpenCode rejects revert mutations while a session is running) and verify whether affected assistant steps actually recorded snapshot pairs and whether shell commands produced external side effects.
   - Read [capture coverage, restoration rules, storage, and revert/diff wire contracts](references/snapshots-and-revert.md) for exact file eligibility and API schemas.
2. **Stage, cancel, or commit a message-boundary rollback**:
   - **Stage (`/undo` or `<leader>u`, message `Revert`, or `session.revert.stage`)**: Immediately restores attributed files on disk to their state before the selected message boundary (removing files newly created after that boundary) and, in interactive UIs, places the reverted prompt text back into the composer for editing.
   - **Cancel (`/redo` or `<leader>r`, or `session.revert.clear`)**: Cancels a staged rollback *before* submitting a new prompt, restoring the pre-`/undo` conversation and file contents.
   - **Commit (submitting the revised prompt, or `session.revert.commit`)**: Finalizes the staged rollback in the active conversation view.
3. **Configure or disable filesystem capture when needed**:
   - Snapshots are enabled by default; set `"snapshots": false` in `opencode.json(c)` (V1 `"snapshot": false`) to stop future filesystem captures while retaining existing stored snapshot objects and conversation-only rollback.

## Critical Invariants and Gotchas

- **Staging immediately overwrites workspace files**: `session.revert.stage` (and `/undo`) mutates disk files right away—it is **not** a read-only preview. Both `/undo` and `/redo` overwrite any manual external edits made to attributed paths after capture; commit or back up important dirty-worktree changes first.
- **Strict active-directory and 2 MiB untracked scope**:
  - Covers tracked files **and** non-ignored untracked files up to **2 MiB each** *under the session's active directory* inside a Git repository.
  - **Never captures**: Git-ignored files (`dist/`, `.env`), individual untracked files **> 2 MiB**, files outside the session's active subdirectory, `.git` metadata (commits, branches, index), or non-Git workspaces (where `/undo` rolls back conversation history only).
- **Only attributed paths restore; shell side effects never roll back**: Only paths attributed to assistant steps after the revert boundary are restored or deleted. Shell changes to processes, databases, network services, Git commits/branches, ignored artifacts, or out-of-directory files remain untouched.
- **`partID` is output-only, never accepted by `session.revert.stage`**: `SessionRevert` responses may contain `partID`, `messageID`, `snapshot`, and `files`, but `SessionRevertStageInput` accepts **only** `{ sessionID, messageID, files? }` (no part-level stage boundary).
- **Rollback is neither a transaction nor secure erasure**: Interrupted steps can lack usable snapshot pairs. Committing a rollback removes turns from the active conversation view without deleting durable session history or sensitive file blobs stored in OpenCode's internal Git object database (`opencode debug paths data`).
- **Quantified git-snapshot inter-turn overhead**:
  - Running per-step `git write-tree` captures introduces `~0.25–0.50 s` of harness delay between turns. In multi-turn sessions (e.g. 21 steps), cumulative transition gap overhead reaches `~5.6 s`.
  - Disabling snapshots via `"snapshots": false` eliminates per-step tree writes, shrinking cumulative transition gaps to `~0.55 s` (`> 85%` overhead reduction).
  - Strongly recommended for read-only research, audit, and analysis agents where file rollbacks are never needed.
