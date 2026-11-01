---
name: opencode-server-client
description: "Connect to, authenticate, and diagnose the OpenCode V2 background server and `@opencode/client` SDK (`Service.discover/ensure/stop/headers`, `server.info`, Basic auth versus `/api/pair` and `/auth/connect/:code` pairing, SDK `{data}` unwrapping and `ClientError` handling, `location.reload`, `session.shell` versus standalone `shell.*` versus ordinary `pty.*` and `experimental.persistentPty.*` WebSocket tickets, and `debug.*`/`migration.v1.status`). Use for daemon/client transport and terminals; use `opencode-network` for outbound proxies/CAs and `opencode-session-lifecycle` for session conversations."
---

# OpenCode Server, Client SDK, and Terminal Transports

Connect applications and scripts cleanly to the OpenCode V2 server (`opencode serve` or `@opencode/client/service`), authenticate via Basic auth or pairing tokens, handle `@opencode/client` response shapes and transport errors, and select the right shell or WebSocket PTY surface.

## Scope and Neighbor Boundaries

- **This skill owns**: `@opencode/client/service` (`Service.discover`, `ensure`, `stop`, `headers`), `server.info`, Basic authentication vs `server.pair` + `/auth/connect/:code` pairing, `@opencode/client` response unwrapping vs raw `204`/`Uint8Array` responses, `ClientError` transport taxonomy, `location.reload`, process/terminal surfaces (`session.shell`, standalone `shell.*`, ordinary `pty.*`, `experimental.persistentPty.*` + WebSocket tickets), and platform diagnostics (`debug.location.list/evict`, `debug.heapDump`, `migration.v1.status`).
- **Use sibling skills for**:
  - `` `opencode-network` `` — outbound `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` loopback bypass and custom CA bundles.
  - `` `opencode-event-streams` `` — `event.subscribe` (`GET /api/event`) and `session.log` streaming.
  - `` `opencode-session-lifecycle` `` — session CRUD, `interrupt`, `wait`, and `opencode.json(c)` precedence.
  - `` `opencode-tools` `` — model-invoked `shell` tool calls inside agent turns.
  - `` `opencode-workspace-files` `` — `location.get`, `file.*`, `vcs.*`, and `worktree.*` operations.

Read [transport, service discovery, and terminal contracts](references/transport-and-terminals.md) for full SDK method signatures, PTY comparison tables, and `ClientError` handling.

## Core Transport and Terminal Workflow

1. **Discover or connect to the intended OpenCode server**:
   - Inspect `server.info()` (`GET /api/info` -> `{ version, pid, urls, tmp, persistentPty? }`) to verify daemon identity and experimental persistent-PTY support. Remember: **`server.info()` proves HTTP reachability, not upstream model/provider readiness!**
   - With `@opencode/client/service`: use `Service.discover` for read-only compatible daemon lookup (never starts a process), `Service.ensure` only when authorized to **start or replace** a missing/mismatched daemon, and `Service.headers(endpoint)` to attach daemon credentials without exposing private registration files.
2. **Configure authentication and response parsing accurately**:
   - Attach server credentials explicitly (e.g., `Authorization: Basic ...` or redeemed pairing token) on server-side transports, reject cross-origin HTTP redirects on authenticated requests, and never expose server passwords or pairing codes to unprivileged logs.
   - Note that `server.pair()` (`POST /api/pair` -> `{ code, expiry }`) is redeemed at **`GET /auth/connect/:code`**—which sits **outside `/api/`**, so `/api/`-only reverse proxies cannot forward pairing redemption unchanged!
   - Match response decoders to the exact operation: many `@opencode/client` methods unwrap `{ data }` automatically, location-scoped catalogs keep `{ location, data }`, `204` mutations return `void`, and `file.read` / `experimental.media.get` return `Uint8Array`. Never double-unwrap SDK results or unconditionally `.json()`-parse `204`/binary responses.
3. **Choose the right shell or PTY execution surface**:
   - **Transcript shell message**: `session.shell({ sessionID, id?, command })` (`POST /api/session/:id/shell` -> `204`; note `agent` is **not** a pinned input field).
   - **Standalone background command**: `shell.create` / `list` / `get` / `remove` + `shell.output({ id, cursor?, limit?, location? })` (advance returned `cursor`; check `shell.get` for exit status).
   - **Interactive location PTY**: `pty.create` / `list` / `get` / `update` / `remove` + `pty.connect.token({ ptyID, location?, "x-opencode-ticket"? })` (returns expiring WebSocket token; `@opencode/client` does not open the WebSocket itself).
   - **Session-persistent PTY** (survives client detach/reattach when `server.info().persistentPty` is active): `experimental.persistentPty.read/list/create` (`/api/experimental/session/:id/terminal[/read]`) and `get/update/snapshot/remove/connectToken` (`/api/experimental/persistent-pty/...`).

## Key Invariants and Gotchas

- **Post-send `ClientError` != mutation rejected**: Distinguish declared HTTP domain errors from `ClientError` reasons (`Transport`, `UnexpectedStatus`, `UnsupportedContentType`, `MalformedResponse`, `SseEventTooLarge`). Connection loss or malformed parse after sending a mutating request leaves server state uncertain—reconcile actual resource state before retrying.
- **`location.reload()` takes no location argument**: `client.location.reload()` (`POST /api/location/reload` -> `void`) reloads the connected server's active location context without a body parameter; verify which daemon/location you are targeting first.
- **Terminal detach != `session.interrupt`, and `persistentPty.shutdown` is daemon-wide**:
  - Closing or resizing a PTY attachment does not interrupt an active agent turn (`session.interrupt`).
  - `experimental.persistentPty.shutdown` and `handoff` are **service-wide daemon lifecycle operations** (also triggered during `Service.stop`)—**never** call them to close one browser tab or clean up a single session!
- **Diagnostic side effects**: `debug.location.evict` unloads live workspace services, `debug.heapDump` writes sensitive process memory to disk, and `migration.v1.status()` (`"required" | "completed" | "running" | "error"`) is a read-only probe rather than a migration executor.
