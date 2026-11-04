---
name: opencode-dev
description: Run, debug, verify opencode CLI/TUI and server via termctrl, API introspection,
  logs, heap dumps, Bun inspector.
---

# Debug opencode

Interactive CLI/TUI and server dev workflow. Exec commands from `packages/cli` unless noted.

## Server/client model

opencode = client/server architecture:

- **Server proc**: Runs Effect HTTP API (`packages/server`), owns domain state (sessions, DB, plugins, permissions, Location services). Started by `serve` cmd (`packages/cli/src/commands/handlers/serve.ts`).
- **TUI proc**: HTTP/SSE client of server via `@opencode/client` (`OpenCode.make`). No app logic.
- **Discovery**: CLI procs find shared server via JSON reg file `~/.local/state/opencode/service.json` (`service-local.json` for local/dev channel) containing `{id, version, url, pid, password}` (HTTP Basic auth). Client calls `GET /api/info` to verify alive, PID match, version compatibility. `opencode service status` prints URL.
- **Sharing**: Concurrent CLI/TUI procs converge on single shared background daemon. If missing/unhealthy, spawns detached (`serve --service`) and self-registers.
- **`bun dev service start|status|stop|restart`**: Manages background daemon lifecycle.
- **Standalone mode** (`--standalone`): Spawns private child `serve --stdio --port 0` with random password tied to proc lifetime. Isolates debug session.
- Logs tagged `role=server` or `role=cli` plus per-proc `run=<id>`. Distinguishes interleaved log entries.

## Starting dev TUI

- `packages/cli` = CLI/TUI entrypoint. `bun dev` (inside `packages/cli` or repo root) runs `packages/cli/src/index.ts`.
- `bun dev` connects to shared local daemon (`service-local.json`), spawning if needed. Shared across worktrees. Add `--standalone` for private server.
- `bun run dev:live` from repo root runs worktree TUI against installed server and real sessions.

## Interactive debugging with termctrl

- Use `termctrl` for interactive checks (real PTY, OpenTUI handshake, screenshot capture).
- Use dedicated session name. Never reuse or kill unrelated session.

```bash
termctrl start opencode-dev --host opentui --cols 112 --rows 34 -- bun dev
termctrl wait opencode-dev "Ask anything" --timeout 20000
termctrl show opencode-dev
```

- Wait for visible text (`Ask anything`, `Connect a provider`) before input. Avoid sleeps.
- Drive TUI via `termctrl send`. Prefix typed text with `text:`; send control keys separately:

```bash
termctrl send opencode-dev 'text:example prompt' enter
termctrl send opencode-dev ctrl-c
```

- Run `termctrl show` after interaction. Inspect for render err, stale state, toasts, crashes.
- Save PNG evidence for user-visible bugs/fixes. Inspect PNG, not text captures. Write outside repo:

```bash
termctrl save opencode-dev --format png --out /tmp/opencode/tui.png
```

- Viewport resize check:

```bash
termctrl resize opencode-dev --cols 100 --rows 30
termctrl show opencode-dev
```

- Source changes: `termctrl restart opencode-dev`. TUI restart != server restart; exec `bun dev service restart` after server changes, or use `--standalone`.
- Background daemon checks: `bun dev service start`, `bun dev service status`, `bun dev service stop`.
- Cleanup session:

```bash
termctrl stop opencode-dev
```

## Server/API debugging

- Inspect helper: `bun dev api --help`. Sends req via daemon discovery/auth path.
- Introspect server data backing TUI to isolate UI render bugs vs client data layer vs server state.
- Supports OpenAPI operation ID or raw HTTP method + path:

```bash
bun dev api get /api/info
bun dev api get /openapi.json
bun dev api <operationId> --param key=value
```

- Pass JSON body via `--data`/`-d` (auto sets `content-type: application/json`). Custom headers: `--header`/`-H name:value`.
- Auto-starts daemon if missing. Manual lifecycle: `bun dev service status`, `bun dev service restart`, `bun dev service stop`.

## Auditing installed `opencode` sessions

Installed sessions: `~/.local/share/opencode/opencode.db` and `~/.local/share/opencode/log/opencode.log`. Local/dev uses `opencode-local.db` and `opencode-local.log`. `OPENCODE_DB` overrides DB. Run `opencode service status` before `opencode api` (prevents auto-starting unneeded server).

For session ID `ses_...`, audit 3 sources:

- Server state: `opencode api get /api/session/active` and session/message endpoints.
- DB history: `event` table ordered rows.
- Client state: `packages/tui/src/context/data.tsx` + active route projection/rendering.

Locate DB containing session without mutation:

```bash
SESSION=ses_...
for db in ~/.local/share/opencode/*.db; do
  sqlite3 "file:$db?mode=ro" "select 1 from session where id='$SESSION' limit 1" 2>/dev/null | grep -q 1 && printf '%s\n' "$db"
done
```

## Logs

- Dir: `~/.local/share/opencode/log/`. Dev: `opencode-local.log`; prod: `opencode.log`. Append-only, shared across procs.
- Format: `timestamp`, `level`, `run=<id>`, `message`, `role=cli|server`.
- Follow log:

```bash
tail -f ~/.local/share/opencode/log/opencode-local.log
```

- Filter run/role:

```bash
grep 'run=8fc3b1d5' ~/.local/share/opencode/log/opencode-local.log
grep 'role=server' ~/.local/share/opencode/log/opencode-local.log
```

- Verbosity: `OPENCODE_LOG_LEVEL=DEBUG`.
- Mirror stderr: `OPENCODE_PRINT_LOGS=1`.
- Capture termctrl proc stdout/stderr: `termctrl logs <session>`. Shared daemon procs write to log file.

## Heap snapshots

Capture background server snapshot without restart:

```bash
opencode debug heap-dump
```

Discovers running service, calls `POST /api/debug/heap-dump`, waits for completion, prints path. Custom server: `--server <url>` (requires `OPENCODE_PASSWORD`). Custom output dir: `--directory <dir>`. (404 = endpoint unsupported in running version).

Desktop mem: Command palette → **Capture heap snapshots** (`packages/gui-plugins/src/debug/main.ts`). Writes `~/Downloads/opencode-heap-<time>/` with local server snapshot, window renderers, Electron main proc. Includes Chromium dumps (`memory-infra.json`), summary (`memory.json` with `malloc`, `partition_alloc`, `cc/tile_memory`, `gpu`, `v8`), window DOM size, images, server `process.memoryUsage()`, and `manifest.json`. Dev desktop CDP trigger (`OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT`, default 9222): `Control+Shift+P` → `heap snapshots` → Enter.

Unix `SIGUSR1` listener in `packages/cli/src/heap.ts` via `packages/util/src/heap-snapshot.ts`:

1. Find procs:

```bash
pgrep -af opencode
ps -o pid,ppid,rss,vsz,lstart,etime,cmd -p <pid>,<pid>
```

2. Signal proc (target `opencode serve --service` PID for server):

```bash
kill -USR1 <server-pid>
```

3. Wait for log confirmation:

```bash
grep 'heap snapshot' ~/.local/share/opencode/log/opencode.log | tail
find ~/.local/share/opencode/log -maxdepth 1 -name 'heap-<server-pid>-*.heapsnapshot' -printf '%T@ %s %p\n' | sort -nr | head
```

Local dev: check `opencode-local.log`. Path in log is authoritative.

4. Inspect via Chrome DevTools or MemLab installed in `/tmp/opencode`:

```bash
npm install --prefix /tmp/opencode/heap-analysis @memlab/cli
/tmp/opencode/heap-analysis/node_modules/.bin/memlab analyze object-size --snapshot <snapshot>
/tmp/opencode/heap-analysis/node_modules/.bin/memlab analyze shape --snapshot <snapshot>
/tmp/opencode/heap-analysis/node_modules/.bin/memlab trace --snapshot <snapshot> --node-id=<id>
```

Confirm leaks: capture baseline → run workload → GC/idle → capture 2nd snapshot → diff retainer paths and growth. Compare snapshot heap size with RSS:

```bash
cat /proc/<pid>/smaps_rollup
pmap -x <pid> | sort -k3 -nr | head -25
```

Record `ps`/`smaps_rollup` before + after capture. Large anon mappings + small live heap = native leak or allocator fragmentation.

## CPU profiles

CLI installs `SIGPROF` listener (`packages/cli/src/cpu-profile.ts`, non-Windows). Signal triggers 10s profile and stops automatically. Extra signals ignored during run.

1. Fetch server PID:

```bash
opencode api get /api/info
```

Dev channel: `bun dev api get /api/info`.

2. Trigger profile:

```bash
kill -PROF <server-pid>
```

3. Wait for completion in log:

```bash
grep 'CPU profile' ~/.local/share/opencode/log/opencode.log | tail
find ~/.local/share/opencode/log -maxdepth 1 -name 'cpu-<server-pid>-*.cpuprofile' -printf '%T@ %s %p\n' | sort -nr | head
```

Dev: `opencode-local.log`. Path: `cpu-<pid>-<timestamp>.cpuprofile`. Load into Chrome DevTools / V8 CPU profiler.

## Debugger

Launch CLI via `termctrl` with Bun inspector URL:

```bash
termctrl start opencode-debug --host opentui --cols 112 --rows 34 -- \
  bun run --inspect=ws://localhost:6499/ src/index.ts
```

- Pause on start: `--inspect-wait` or `--inspect-brk`.
- Inspector logs / startup errs: `termctrl logs opencode-debug`.
- UI view: `termctrl show opencode-debug`.

## Verification

- CLI changes: `bun typecheck` in `packages/cli`.
- Shared TUI changes: `bun typecheck` and `bun test` in `packages/tui`. Never test from repo root.
- Manual verification: check initial render, modified interaction, Ctrl-C exit, save PNG screenshot.
