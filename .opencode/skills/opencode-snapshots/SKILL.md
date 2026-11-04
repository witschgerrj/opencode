---
name: opencode-snapshots
description: Manage OpenCode V2 step Git snapshots, undo redo staged rollbacks, message
  reverts, session diff APIs.
---

# OpenCode Snapshots, Diffs, Staged Rollbacks

OpenCode V2 captures best-effort FS snapshots per model step in separate internal Git object store. `/undo`, `/redo`, `session.revert` roll back conversation turns + attributed workspace file edits together.

## Boundaries with Neighbor Skills

- **Repo Git status, branch diffs, file reads**: `opencode-workspace-files`.
- **Branch parallel session without overwriting history (fork)**: `opencode-session-lifecycle`.
- **Summarize older turns for ctx limits**: `opencode-compaction`.
- **Inspect assistant msg snapshot metadata (`snapshot.start/end/files`), SSE revert events**: `opencode-messages-parts`, `opencode-event-streams`.

## Core Workflow

1. **Inspect session diffs + dirty worktree edits before rollback**:
   - Check `git status --short` / `git diff` and `session.diff({ sessionID, from?, to?, context? })` before invoking `/undo` or `session.revert.stage`.
   - Confirm target session **idle** (OpenCode rejects revert mutations during active runs). Verify affected assistant steps recorded snapshot pairs; check shell external side effects.
   - Read `references/snapshots-and-revert.md` for exact file eligibility + API schemas.
2. **Stage, cancel, commit message-boundary rollback**:
   - **Stage (`/undo`, `<leader>u`, msg `Revert`, or `session.revert.stage`)**: Restores attributed files on disk immediately to pre-boundary state (deletes files created after boundary). Interactive UIs: places reverted prompt text in composer.
   - **Cancel (`/redo`, `<leader>r`, or `session.revert.clear`)**: Cancels staged rollback *before* new prompt submitted. Restores pre-`/undo` conversation + file contents.
   - **Commit (submit revised prompt, or `session.revert.commit`)**: Finalizes staged rollback in active conversation view.
3. **Configure/disable FS capture**:
   - Snapshots enabled by default. Set `"snapshots": false` in `opencode.json(c)` (V1: `"snapshot": false`) → stops future FS captures, preserves existing stored snapshot objects + conversation-only rollback.

## Critical Invariants and Gotchas

- **Staging immediately overwrites workspace files**: `session.revert.stage` / `/undo` mutates disk immediately—**not** read-only preview. `/undo` + `/redo` overwrite manual edits made to attributed paths after capture. Commit/stash dirty worktree changes first.
- **Active dir + 2 MiB untracked scope**:
   - Covers tracked files + non-ignored untracked files up to **2 MiB each** under session active dir in Git repo.
   - **Never captures**: Git-ignored files (`dist/`, `.env`), untracked files **> 2 MiB**, files outside session active subdir, `.git` metadata (commits, branches, index), non-Git workspaces (where `/undo` rolls back conversation history only).
- **Only attributed paths restore; shell side effects never roll back**: Attributed assistant step paths restored/deleted. Shell changes (proc, DB, network, git commits/branches, ignored artifacts, out-of-dir files) remain untouched.
- **`partID` output-only, rejected by `session.revert.stage`**: `SessionRevert` res contains `partID`, `messageID`, `snapshot`, `files`. `SessionRevertStageInput` accepts **only** `{ sessionID, messageID, files? }` (no part-level stage boundary).
- **Not atomic transaction, not secure erasure**: Interrupted steps may lack snapshot pairs. Committing rollback removes turns from active conversation view without deleting durable history or file blobs in internal Git object DB (`opencode debug paths data`).
- **Git-snapshot overhead**:
   - Per-step `git write-tree` adds `~0.25–0.50 s` harness delay per turn. 21-step session → `~5.6 s` cumulative overhead.
   - `"snapshots": false` eliminates per-step tree writes → transition gaps shrink to `~0.55 s` (`> 85%` overhead reduction).
   - Recommended for read-only research, audit, analysis agents where file rollback unneeded.
