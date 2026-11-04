---
name: opencode-server-client
description: Connect, auth, diagnose OpenCode V2 daemon, client SDK, shell, and PTY
  terminal transports
---

# OpenCode Server, Client SDK, and Terminal Transports

Connect apps and scripts to OpenCode V2 server (`opencode serve` or `@opencode/client/service`), auth via Basic auth or pairing tokens, handle `@opencode/client` res shapes and transport errs, select correct shell or WebSocket PTY surface.

## Scope and Neighbor Boundaries

- **This skill owns**: `@opencode/client/service` (`Service.discover`, `ensure`, `stop`, `headers`), `server.info`, Basic auth vs `server.pair` + `/auth/connect/:code` pairing, `@opencode/client` res unwrapping vs raw `204`/`Uint8Array` res, `ClientError` transport taxonomy, `location.reload`, proc/terminal surfaces (`session.shell`, standalone `shell.*`, ordinary `pty.*`, `experimental.persistentPty.*` + WebSocket tickets), platform diagnostics (`debug.location.list/evict`, `debug.heapDump`, `migration.v1.status`).
- **Sibling skills**:
  - `opencode-network` — outbound `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` loopback bypass and custom CA bundles.
  - `opencode-event-streams` — `event.subscribe` (`GET /api/event`) and `session.log` streaming.
  - `opencode-session-lifecycle` — session CRUD, `interrupt`, `wait`, and `opencode.json(c)` precedence.
  - `opencode-tools` — model-invoked `shell` tool calls inside agent turns.
  - `opencode-workspace-files` — `location.get`, `file.*`, `vcs.*`, and `worktree.*` operations.

Read `references/transport-and-terminals.md` for SDK method signatures, PTY comparison tables, `ClientError` handling.

## Core Transport and Terminal Workflow

1. **Discover or connect to target OpenCode server**:
   - Inspect `server.info()` (`GET /api/info` → `{ version, pid, urls, tmp, persistentPty? }`) to verify daemon identity and experimental persistent-PTY support. **`server.info()` proves HTTP reachability, not upstream model/provider readiness!**
   - With `@opencode/client/service`: `Service.discover` for read-only compatible daemon lookup (never starts proc), `Service.ensure` only when authorized to start or replace missing/mismatched daemon, `Service.headers(endpoint)` to attach daemon credentials without exposing private registration files.
2. **Configure auth and res parsing accurately**:
   - Attach server credentials explicitly (`Authorization: Basic ...` or redeemed pairing token) on server-side transports, reject cross-origin HTTP redirects on authenticated reqs, never expose server passwords or pairing codes in unprivileged logs.
   - `server.pair()` (`POST /api/pair` → `{ code, expiry }`) redeemed at **`GET /auth/connect/:code`** (sits **outside `/api/`** → `/api/`-only reverse proxies cannot forward pairing redemption unchanged).
   - Match res decoders to exact operation: many `@opencode/client` methods unwrap `{ data }` automatically; location-scoped catalogs keep `{ location, data }`; `204` mutations ret `void`; `file.read` / `experimental.media.get` ret `Uint8Array`. Never double-unwrap SDK results; never unconditionally `.json()`-parse `204`/binary res.
3. **Choose correct shell or PTY exec surface**:
   - **Transcript shell message**: `session.shell({ sessionID, id?, command })` (`POST /api/session/:id/shell` → `204`; `agent` **not** pinned input field).
   - **Standalone background command**: `shell.create` / `list` / `get` / `remove` + `shell.output({ id, cursor?, limit?, location? })` (advance returned `cursor`; check `shell.get` for exit status).
   - **Interactive location PTY**: `pty.create` / `list` / `get` / `update` / `remove` + `pty.connect.token({ ptyID, location?, "x-opencode-ticket"? })` (returns expiring WebSocket token; `@opencode/client` does not open WebSocket itself).
   - **Session-persistent PTY** (survives client detach/reattach when `server.info().persistentPty` active): `experimental.persistentPty.read/list/create` (`/api/experimental/session/:id/terminal[/read]`) and `get/update/snapshot/remove/connectToken` (`/api/experimental/persistent-pty/...`).

## Key Invariants and Gotchas

- **Post-send `ClientError` != mutation rejected**: Distinguish declared HTTP domain errs from `ClientError` reasons (`Transport`, `UnexpectedStatus`, `UnsupportedContentType`, `MalformedResponse`, `SseEventTooLarge`). Connection loss or malformed parse after sending mutating req leaves server state uncertain → reconcile actual resource state before retry.
- **`location.reload()` takes no location arg**: `client.location.reload()` (`POST /api/location/reload` → `void`) reloads connected server active location ctx without body param; verify targeted daemon/location first.
- **Terminal detach != `session.interrupt`, and `persistentPty.shutdown` is daemon-wide**:
  - Closing or resizing PTY attachment does not interrupt active agent turn (`session.interrupt`).
  - `experimental.persistentPty.shutdown` and `handoff` are service-wide daemon lifecycle operations (also triggered during `Service.stop`) — **never** call to close single browser tab or single session.
- **Diagnostic side effects**: `debug.location.evict` unloads live workspace services, `debug.heapDump` writes sensitive proc mem to disk, `migration.v1.status()` (`"required" | "completed" | "running" | "error"`) is read-only probe, not migration executor.
