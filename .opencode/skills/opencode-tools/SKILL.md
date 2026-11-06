---
name: opencode-tools
description: Operate OpenCode built-in tools Code Mode cgroup leaf isolation env scrubbing shell backpressure and GPU tool plugins
---

# OpenCode Tools and Code Mode

OpenCode V2 exposes structured catalog of built-in FS, command, web, interaction, automation, GPU, and JS Code Mode (`execute`) tools. Each enforces action/resource permissions directly and inside nested calls.

## Scope and Neighbor Boundaries

- **This skill owns**: Built-in model tool behavior (`read`, `glob`, `grep`, `edit`, `write`, `patch`, foreground/background `shell`, `webfetch`, `websearch`, `question`, `skill`, `subagent`, `todowrite`), GPU tools (`generate_image`, `godot_sandbox`), two-tier leaf cgroup isolation (`cgroup-wrap.ts`), credential scrubbing (`env-scrub.ts`), shell stream backpressure (`64 MiB`), `execute` JS Code Mode runtime, `tool_output` retention limits, direct vs nested tool permissions.
- **Sibling skills**:
  - `opencode-mcp-servers` — MCP server setup, `stdio` cgroups, credential scrubbing.
  - `opencode-agents` — agent profiles, subagent trees, GPU tool slot policy (`withGpuToolSlotPolicy`).
  - `opencode-session-lifecycle` — session creation, `Session.remove`, unleased inference prevention.
  - `opencode-permissions` and `opencode-policies` — ordered permission rules, hard `tool.use` policies.
  - `opencode-formatters` — post-edit formatting triggered by `edit`, `write`, `patch`.
  - `opencode-human-input` — answering `question` forms, permission prompts over SDK/HTTP API.

Read `references/builtin-tools-and-codemode.md` for per-tool params, caps, permission resources, namespace operations.

## Core Tool Workflow

1. **Choose file or search tool**:
   - `read`: pages UTF-8 text (numbered lines, cap **2,000 lines**, **50 KiB** per page; lines shortened past 2,000 chars), lists immediate dir entries, loads `PNG`/`JPEG`/`GIF`/`WebP`/`PDF` up to 20 MiB source data.
   - `glob`: matches relative paths (default 100 files, 30s timeout).
   - `grep`: searches file contents via regex or `literal: true` (default 100 matching lines, 30s timeout).
   - `edit`: replaces unique (`replaceAll: false`) or all occurrences in existing file.
   - `write`: creates or overwrites file (creates parent dirs).
   - `patch`: applies atomic multi-file diffs (`*** Add File:`, `*** Update File:`, `*** Delete File:`) with exact line anchors.
2. **Use `shell` with bounded timeouts, backpressure, and leaf cgroups**:
   - Pass `workdir` rather than embedding `cd`. Foreground calls default to **10-minute (`600000` ms) timeout**.
   - Stream backpressure awaits `stream.once("drain")` when buffer fills; capped at `MAX_SHELL_OUTPUT_BYTES = 64 MiB`.
   - Every OS process tree automatically wrapped in `aquanox-subprocs.slice` leaf cgroup.
3. **Orchestrate parallel or filtered workflows with Code Mode (`execute`)**:
   - `execute` runs sandboxed JS: no direct disk I/O, no `import`/`require`, no timers. Provides global `fetch` + permitted catalog tools (`opencode.*`, `browser.*`, MCP namespaces).
4. **Call GPU tool plugins (`generate_image`, `godot_sandbox`)**:
   - Tool execution wrapped in `SessionSlotLease.withGpuToolSlotPolicy(sessionID, ..., { suspendMode: "keep_reserved" })`.
   - Requests signed and routed to `/run/aquanox-broker/broker.sock` via `GpuBrokerUnixClient`.

## Default Two-Tier Leaf Cgroup Isolation (`packages/core/src/util/cgroup-wrap.ts`)

Every external OS process spawned by `shell.ts`, `pty.ts`, and `mcp/stdio.ts` is wrapped into a bounded systemd leaf unit under `aquanox-subprocs.slice` (`MemoryHigh=12G`, `MemoryMax=16G`, `MemorySwapMax=0`, `CPUQuota=1600%`) using `systemd-run --quiet --collect --wait`:

| Cgroup Tier | Matching Commands | Memory Limits | OOM & CPU Affinity Controls |
| :--- | :--- | :--- | :--- |
| **`fast_inspect`** (`FAST_INSPECT_SPEC`) | Read-only inspection: `git` (status/log/diff), `rg`, `grep`, `ls`, `cat`, `sed`, `awk`, `jq`, `find` (no `-exec`), `stat`, `file`, etc. | `MemoryHigh=768M`<br>`MemoryMax=1024M` (`1.0 GiB`) | `MemorySwapMax=0`<br>`OOMPolicy=kill`<br>`OOMScoreAdjust=300`<br>`AllowedCPUs=32-63`<br>`--nice=10` |
| **`build_test`** (`BUILD_TEST_SPEC`) | Compilers, test runners, bundlers, interpreters, shell scripts, pipelines: `cargo`, `bun`, `node`, `pytest`, `python3`, `godot`, `make`, `*.sh`, `sh -c`, `find -exec`, etc. | `MemoryHigh=6144M`<br>`MemoryMax=8192M` (`8.0 GiB`)* | `MemorySwapMax=0`<br>`OOMPolicy=kill`<br>`OOMScoreAdjust=300`<br>`AllowedCPUs=32-63`<br>`--nice=10` |

*\*Configurable via `AQUANOX_BUILD_TEST_MEMORY_MAX_MIB` (scales `MemoryHigh = floor(0.75 * max)`).*
- **Containment Invariant**: Command classification selects only between bounded leaf tiers; it never bypasses cgroup isolation. Only in-process TypeScript `node:fs` calls run unwrapped.

## Process Environment Credential Scrubbing (`packages/core/src/util/env-scrub.ts`)

Protects system credentials from leaking to untrusted child shells, build scripts, or MCP processes:
1. **Startup Scrubbing (`loadAndScrubStartupCredentials`)**:
   - Reads secrets (`OPENCODE_SERVER_PASSWORD`, `AQUANOX_BROKER_SECRET`, `AQUANOX_LLM_API_KEY`, `AQUANOX_ADMIN_TOKEN`) from `CREDENTIALS_DIRECTORY` into module-private memory.
   - Deletes all sensitive variables from `process.env`.
2. **Child Environment Sanitization (`scrubChildEnvironment`)**:
   - Strips exact sensitive keys: `OPENCODE_SERVER_PASSWORD`, `AQUANOX_BROKER_SECRET`, `AQUANOX_LLM_API_KEY`, `AQUANOX_ADMIN_TOKEN`.
   - Strips sensitive prefix patterns: `OPENCODE_CREDENTIAL_*`, `AQUANOX_SECRET_*`.
   - Applied to 100% of child spawns across `shell.ts`, `pty.ts`, and `mcp/stdio.ts`.

## Shell Stream Backpressure & Truncation (`packages/core/src/shell.ts`)

- **Backpressure Handling**: When streaming stdout/stderr chunks, if `stream.write(chunk)` returns `false` (buffer full), the fiber pauses and awaits `stream.once("drain")`, with listeners cleaned up on error, close, or fiber cancellation.
- **64 MiB Cap**: Enforces `MAX_SHELL_OUTPUT_BYTES = 64 MiB` (`67,108,864 B`). Exceeding the limit appends `\n[output truncated at 64 MiB limit]\n`, flags `truncated = true`, and terminates the process tree.

## GPU Broker Client & Tool Plugins (`gpu-broker-client.ts`, `generate-image.ts`, `godot-sandbox.ts`)

- **`GpuBrokerUnixClient` & Signed `params` Contract**:
  - Connects to `/run/aquanox-broker/broker.sock` over HTTP/UDS.
  - HMAC Request Envelope (`FenceToken`): signs requests with epoch-bound HMAC SHA-256 (`f"{broker_boot_id}:{broker_epoch}:{request_id}:{seq}:{rand}"`).
  - Canonical `params` Binding: `worktree_root`, `output_path`/`output_dir`, `active_leads`, `subagent_commitments_mib`, and `resident` (`resident: Boolean(req.resident ?? false)`) are placed directly inside the canonical `params` object hashed by `params_sha256`.
  - One-Shot Actions Enforcement (`GPU-025`): `godot-sandbox.ts` defines `ONE_SHOT_GODOT_ACTIONS = ["capture", "sandbox", "import", "validate", "test"] as const`; `validateGodotSandboxInput` strictly forces `resident: false` for all one-shot actions to prevent unmonitored dead workers.
  - Automatic Rekeying: on `401 ERR_BROKER_EPOCH_MISMATCH` / `ERR_BROKER_EPOCH_STALE`, automatically rekeys via single-use `POST /v1/auth/bootstrap_or_rekey` (handling `409 ERR_EPOCH_KEY_ALREADY_CONFIRMED` on duplicate calls).
  - Subprocess Accounting & Resilient Release (`GPU-028`): `shell.ts` registers `build_test` units via `registerSubproc` (`POST /v1/subproc/register`) before spawn and releases them via `releaseSubproc` (`POST /v1/subproc/release`) on exit. `releaseSubproc` enforces 3-attempt exponential backoff (`[100ms, 300ms]`) on transient HTTP 5xx, socket disconnect, `ECONNREFUSED`, `ECONNRESET`, or timeout, and calls `bootstrapOrRekey(true)` on `401/403` to transparently recover from credential rotation. `shell.ts` tracks live `activeSubprocUnits` and registers `beforeExit`, `SIGINT`, and `SIGTERM` signal cleanup hooks (`cleanupActiveSubprocUnits()`) so interrupted processes release reservations before exit.
- **Tool Slot Policy**:
  - `generate_image` and `godot_sandbox` wrap calls inside `SessionSlotLease.withGpuToolSlotPolicy(sessionID, ..., { suspendMode: "keep_reserved" })`.
  - Caller's physical `128k` slot remains locked across the GPU lease; resume latency is `0 ms`.

## Tooling & Cgroup Learnings (OOMPolicy, Finding 10, Finding 4)

### Learning 1: `systemd-run` `OOMPolicy=kill` vs Invalid `MemoryOOMGroup=yes`
- **Symptom / Issue**: `systemd-run` failed process invocations with `Unknown assignment` when setting `-p MemoryOOMGroup=yes`.
- **Root Cause**: `systemd 255.4` does not support `-p MemoryOOMGroup=yes`. In systemd unit configuration, cgroup v2 `memory.oom.group=1` is enabled via `-p OOMPolicy=kill` (or `OOMPolicy=continue`).
- **Verified Fix**: Replaced invalid `-p MemoryOOMGroup=yes` with `-p OOMPolicy=kill` in `cgroup-wrap.ts` across `FAST_INSPECT_SPEC` and `BUILD_TEST_SPEC`. Verified directly on `systemd 255.4`.
- **Prevention Rule**: Always test `systemd-run` flags live on target host; do not confuse kernel cgroup v2 interface filenames (`memory.oom.group`) with systemd unit property names (`OOMPolicy`).

### Learning 2: Default-On Leaf Cgroup Enforcement & Broker Subprocess Accounting (`Finding 10`)
- **Symptom / Issue**: Guarding `shouldWrapInLeafCgroup()` behind opt-in `AQUANOX_ENFORCE_LEAF_CGROUPS === "1"` left subprocesses unwrapped when the env var was omitted. Furthermore, premature shell fiber cancellation or timeout bypassed process exit listeners, stranding subproc registrations in the GPU broker ledger.
- **Root Cause**: Opt-in gate allowed uncontained shell and MCP execution in normal runs, while relying solely on child process exit handlers leaked registrations when fibers were interrupted before exit.
- **Verified Fix**: Default enforcement to on (`process.env.AQUANOX_ENFORCE_LEAF_CGROUPS !== "0"`) when `aquanox-subprocs.slice` exists on Linux. Register/release `build_test` units with broker accounting endpoints (`/v1/subproc/register` and `/v1/subproc/release`), wrapping shell execution in `.pipe(Effect.ensuring(releaseSubprocOnce()))` for idempotent release on both normal exit and fiber interruption.
- **Prevention Rule**: Security and resource containment mechanisms must fail closed and default to enabled whenever the host cgroup slice exists; use opt-out guards (`!== "0"`), never opt-in (`=== "1"`). Pair external accounting registrations with idempotent finalizers in `Effect.ensuring` to prevent leaks on fiber cancellation.

### Learning 3: Binding Security-Sensitive Fields Inside Signed `params` & Default Delivery (`Findings 1 & 4`)
- **Symptom / Issue**: Passing `worktree_root`, `output_path`, `active_leads`, or `subagent_commitments_mib` only at the top level of an RPC JSON envelope left them outside `params_sha256` signature coverage. Calling `generate_image` without `output_path` or `worktree_root` also left the broker with no delivery destination before lease cleanup.
- **Root Cause**: Unsigned top-level envelope fields are vulnerable to parameter tampering or destination hijacking, and tools omitting canonical worktree resolution failed artifact delivery.
- **Verified Fix**: In `gpu-broker-client.ts`, `generate-image.ts`, and `godot-sandbox.ts`, include `worktree_root`, `output_path`, `active_leads`, and `subagent_commitments_mib` directly inside the canonical `params` object hashed by `params_sha256`. Derive default `output_path` inside `worktree_root` (`path.resolve(worktree_root, input.output_path ?? "artifacts/generated_image.png")`, rejecting `ERR_OUTPUT_PATH_ESCAPE`), and verify post-call that `response.ok === true`, `response.is_test_data !== true` / `synthetic_test_data !== true`, and `delivered_files.length > 0`.
- **Prevention Rule**: Every security-, routing-, or admission-relevant field must be placed inside the canonically hashed `params` dictionary rather than as unsigned top-level envelope fields; verify non-synthetic delivery before releasing resource leases.

### Learning 4: Supervised Worker Unit Isolation (`Restart=no`, `ProtectHome=read-only`, Headless Cache)
- **Symptom / Issue**: Supervised worker template services (`aquanox-worker-image@.service`, `aquanox-worker-godot@.service`) failed to report exit status cleanly to the orchestrator, and graphics runtimes crashed with `EROFS` / `EACCES` when writing shader or configuration files.
- **Root Cause**: Setting `Restart=on-failure` masks non-zero exit codes from `systemctl show -P ExecMainStatus` and causes failed tasks to restart indefinitely rather than failing fast. Setting `ProtectHome=yes` prevents workers from reading models/scripts under `/home`, while non-login service accounts with nonexistent home directories fail when tools write to default `$HOME`.
- **Verified Fix**: Configure worker units with `Restart=no` so failures propagate directly to `wait_for_worker_completion`. Use `ProtectHome=read-only` or explicit `BindReadOnlyPaths` to expose shared asset paths, and configure explicit `CacheDirectory=` / `XDG_CACHE_HOME` for headless workers.
- **Prevention Rule**: Supervised worker units must never set `Restart=on-failure`; always use `Restart=no` and explicit cache directory bindings for headless execution.

### Learning 5: Production CLI Binary Deployment, SHA-256 Parity & Inode Unlink vs ETXTBSY
- **Symptom / Issue**: Changes to TypeScript core/cli packages pass unit tests (`bun test`) but do not take effect in live systemd services (`opencode.service`), or running `sudo cp packages/cli/dist/opencode.exe /usr/lib/node_modules/@opencode/cli/bin/opencode.exe` fails with `cp: cannot create regular file ...: Text file busy` (`ETXTBSY`).
- **Root Cause**: Live daemon units execute the globally installed binary at `/usr/lib/node_modules/@opencode/cli/bin/opencode.exe`. Standard `cp` opens the destination with `O_WRONLY | O_TRUNC`, which the Linux kernel rejects with `ETXTBSY` when the executable inode is actively mapped with `VM_DENYWRITE` by running processes.
- **Verified Fix**: Rebuild the production binary via `cd packages/cli && bun run build`. Replace the live binary atomically using `sudo install -m 0755 packages/cli/dist/opencode.exe /usr/lib/node_modules/@opencode/cli/bin/opencode.exe` (or `sudo cp --remove-destination`), which unlinks the old directory entry and creates a fresh inode rather than truncating the running binary in place. Verify matching hashes via `sha256sum`.
- **Prevention Rule**: Always use `install -m 0755` or `cp --remove-destination` to replace live executables on Linux without triggering `ETXTBSY`, and verify SHA-256 parity between the workspace build artifact and the globally installed binary before running daemon smoke tests.

### Learning 6: Mount-Namespace D-Bus & Systemd Socket Reachability (`GPU-006`)
- **Symptom / Issue**: Inside containerized or sandbox mount namespaces, wrapping commands in `systemd-run --scope` failed immediately with `Failed to connect to bus: No such file or directory` or `Connection refused`, causing shell tools to crash before the command executed.
- **Root Cause**: `isAquanoxLeafCgroupHostAvailable()` checked only for cgroup v2 slice directory visibility (`/sys/fs/cgroup/aquanox-subprocs.slice`). In custom mount namespaces where `/run/systemd/private` or `/run/dbus/system_bus_socket` is not mounted, `systemd-run` cannot connect to systemd PID 1 via D-Bus.
- **Verified Fix**: Extended `isAquanoxLeafCgroupHostAvailable()` to verify both slice directory existence AND socket accessibility: `hasSlice && (existsSync("/run/systemd/private") || existsSync("/run/dbus/system_bus_socket"))`. If the control socket is inaccessible, execution falls back cleanly to unwrapped execution rather than failing.
- **Prevention Rule**: Never assume `/sys/fs/cgroup` visibility implies systemd control plane reachability; always verify `/run/systemd/private` or `/run/dbus/system_bus_socket` accessibility before delegating process execution to `systemd-run`.

### Learning 7: Host-Memory Admission Enforcement for Subprocesses & Subagents (`GPU-005`)
- **Symptom / Issue**: CPU subprocesses (both `build_test` and `fast_inspect`) and child subagents bypassed broker host-memory accounting whenever `systemd-run` wrapping was skipped or when the broker returned `503 ERR_SUBPROC_MEM_FLOOR_VIOLATION` / `ERR_HOST_MEM_FLOOR_VIOLATION`. Subprocesses were spawned anyway, risking OOM-kills on local LLM memory.
- **Root Cause**: `shell.ts` only attempted broker registration if `wrap.wrapped === true` and swallowed all errors from `registerSubproc`. In `subagent.ts`, child subagents spawned without querying broker host-memory admission via `evaluateAdmission`.
- **Verified Fix**: In `gpu-broker-client.ts`, `registerSubproc` returns a typed `RegisterSubprocBrokerResult` distinguishing admission denial from offline fallback (`ENOENT`/`ECONNREFUSED`). Broker checks host floor: `live_mem_available_mib - current_subproc_reserved_mib - memory_max_mib < 32768 => 503 ERR_SUBPROC_MEM_FLOOR_VIOLATION`. In `shell.ts`, both wrapped and unwrapped subprocesses register with `/v1/subproc/register` before `spawner.spawn`, failing closed immediately if denied. In `subagent.ts`, `evaluateAdmission({ new_request_mib })` evaluates admission before launching child turns, failing closed and purging acquired leases if host floors would breach.
- **Prevention Rule**: Always register external subprocesses and subagents with central resource admission brokers even when cgroup containerization is unavailable or skipped. Fail closed before process spawn when admission is denied, and provide explicit graceful offline fallback when the broker is unreachable.

### Learning 8: Dynamic Peer Process Identity & Startup D-State Quarantine (`GPU-002` & `GPU-010`)
- **Symptom / Issue**: Socket peer PID recycling allowed orphaned credentials after process restarts, and broker boot crashed or hung when surviving worker units entered unkillable kernel D-state.
- **Root Cause**: Kernel `SO_PEERCRED` checks without start time validation allow recycled PIDs to reuse active epochs. On broker startup, blindly resuming when a surviving unit is wedged in D-state risks hardware corruption.
- **Verified Fix**: Couple `SO_PEERCRED` with `/proc/<pid>/stat` field 22 `(main_pid, starttime_ticks)`. If peer identity diverges from authorized state, bump broker epoch to trigger clean rekeying (`401 ERR_BROKER_EPOCH_MISMATCH`). On broker startup, sweep surviving units; if teardown verification detects unkillable D-state (`td_res.unkillable_d_state`), pin hardware (`pin_until_reboot()`), enter `BrokerState.DEGRADED_3GPU_LOCKED`, and write persistent `QuarantineRecord` to disk.
- **Prevention Rule**: Authenticate local IPC peers using both PID and start time ticks; quarantine wedged hardware units to degraded pinned state upon unkillable D-state detection during boot recovery.

### Learning 9: Tool Execution Budget Normalization & Dynamic Client Socket Timeout (`GPU-023`)
- **Symptom / Issue**: `godot_sandbox` executions requesting up to 600s were killed prematurely at 120s or 200s, short or invalid budgets failed silently, and client HTTP sockets closed prematurely during valid 300s–600s captures.
- **Root Cause**: Field alias mismatches between caller schema (`timeout_seconds`), client driver (`timeout_s`), and broker staging (`timeout`) caused intermediate brokers to fall back to hardcoded 120s defaults. Concurrently, client HTTP socket timeouts were statically hardcoded (e.g. 200s in `godot-sandbox.ts`), severing the transport connection before 300s–600s runs finished.
- **Verified Fix**: Normalize `timeout_seconds`, `timeout_s`, and `timeout` across `godot-sandbox.ts`, `gpu-broker-client.ts`, and broker `server.py` into a canonical integer seconds budget. Enforce range `5 <= timeout <= 600` (rejecting out-of-bounds budgets with `400 ERR_INVALID_TIMEOUT`), propagate dynamically into systemd unit properties (`RuntimeMaxSec = timeout + 15s`), and scale client HTTP socket timeouts dynamically as `Math.max((timeoutSeconds + 60) * 1000, 180_000)` (`>= timeoutSeconds + 60s` teardown headroom).
- **Prevention Rule**: Eliminate timeout field name divergences across API tiers. Validate ranges strictly at the boundary, synchronize systemd runtime caps with requested budgets, and dynamically scale client socket timeouts with $\ge 60$s teardown headroom above the execution budget.

### Learning 10: Periodic Reactive Pressure Supervisors vs Passive Policy Functions (`GPU-022`)
- **Symptom / Issue**: Host and OpenCode memory pressure exceeded critical thresholds without reactive clamp or worker termination actions triggering in production.
- **Root Cause**: Reactive pressure policies were implemented as pure functions in telemetry modules but lacked a periodic supervisor loop to schedule and execute them.
- **Verified Fix**: Schedule a bounded periodic watchdog supervisor (`run_pressure_watchdog_tick()`) in the broker daemon to sample live telemetry, evaluate pressure policies, execute remediation actions (`clamp_cache`, `stop_worker_units`), and emit structured audit events.
- **Prevention Rule**: Safety policies must not remain passive functions; always schedule an active supervisor loop and verify live remediation actions under simulated pressure.

### Learning 11: Resident vs One-Shot Tool Parameter Forcing (`GPU-025`)
- **Symptom / Issue**: One-shot Godot operations requesting `resident: true` skipped completion monitoring and teardown, returning success for dead worker units and stranding GPU lease directories.
- **Root Cause**: One-shot capture/sandbox actions are inherently finite; accepting `resident: true` for finite workloads bypassed teardown without establishing a resident control socket.
- **Verified Fix**: In `godot-sandbox.ts`, `ONE_SHOT_GODOT_ACTIONS = ["capture", "sandbox", "import", "validate", "test"]` forces `resident: false` in `validateGodotSandboxInput` regardless of caller input. In `gpu-broker-client.ts`, `resident: Boolean(req.resident ?? false)` is explicitly bound inside the signed `params` dictionary (`params_sha256`), and tests assert rejection or fallback to non-resident execution (`79/79` passing).
- **Prevention Rule**: For finite/one-shot tools, strictly force `resident: false` at parameter validation; never trust client requests to mark finite jobs as persistent or resident without a verified long-running control supervisor.

### Learning 12: Resilient Release Retry & Server-Side Liveness Reconciliation (`GPU-028`)
- **Symptom / Issue**: Four dead `8192 MiB` `aquanox-subproc-build_test-*` leases (`32,768 MiB` total) remained in `active_subprocs` across broker restarts (`LoadState=not-found`, `ActiveState=inactive`, `MainPID=0`), causing subsequent `8192 MiB` `handle_subproc_register` requests at `MemAvailable=50000 MiB` to fail with `503 ERR_SUBPROC_MEM_FLOOR_VIOLATION`.
- **Root Cause**: On the client side, single-attempt `releaseSubproc` calls dropped during network glitches or broker rekeys, and SIGINT/SIGTERM interruptions bypassed exit handlers. On the server side, startup reloaded persisted `active_subprocs` from `broker-state.json`, but `reconcile_subprocs()` had no production caller, continuing to subtract ceilings for dead units.
- **Verified Fix**: In `gpu-broker-client.ts`, `releaseSubproc` enforces 3-attempt exponential backoff (`[100ms, 300ms]`) on transient 5xx, socket reset, `ECONNREFUSED`, `ENOENT`, or timeout, and calls `bootstrapOrRekey(true)` on `401/403` to transparently recover from credential rotation. In `shell.ts`, live `activeSubprocUnits` are tracked with `beforeExit`, `SIGINT`, and `SIGTERM` process hooks (`cleanupActiveSubprocUnits()`) to release reservations on signal interruption. On the server side, `reconcile_subprocs()` runs at broker startup, on watchdog ticks, and before every admission evaluation, verifying systemd state and cgroups with a `15.0s` write-ahead spawn grace period (`spawn_grace_s=15.0`) before durably pruning dead records.
- **Prevention Rule**: Never rely on single-attempt client release RPCs; retry release calls with backoff, attach signal handlers (`SIGINT`, `SIGTERM`, `beforeExit`) to flush active registrations, and reconcile persisted write-ahead reservations against live OS state with a bounded grace window for in-flight spawns.

### Learning 13: Liveness-First Reconciliation: Never Expire Confirmed-Live Workloads by TTL (`GPU-029`)
- **Symptom / Issue**: Confirmed-live background commands (`background: true`) and long-running compilations/tests running longer than 15 minutes (`> 900s`) had their `8,192 MiB` memory reservations silently pruned to `0 MiB` by `reconcile_subprocs()`, allowing subsequent admissions to breach the 32 GiB host floor while the process was still actively executing.
- **Root Cause**: `reconcile_subprocs()` checked `if age_s > max_ttl_s (900s)` *before* checking `unit_alive_probe`. This unconditionally pruned records past 15 minutes regardless of `confirmed_live=True`, treating orphan reclamation TTL as an accidental hard execution limit.
- **Verified Fix**: Liveness-first evaluation: `reconcile_subprocs()` queries `unit_alive_probe` FIRST. Live units retain their `confirmed_live` reservation for their entire actual duration (whether 901s or 3600s) until explicit client release or confirmed unit teardown. In `shell.ts` and `tool/plugin/shell.ts`, `Active.kill` is attached to background command records so `removeCommand` reliably terminates the child process and runs `releaseSubprocOnce` on eviction, while `isSubprocActive(unitName)` verifies live reservations across `> 15`-minute horizons (`81/81` tests passing). Age-based TTL (`max_ttl_s`) and spawn grace (`spawn_grace_s = 15s`) apply strictly to unconfirmed write-ahead records where no live unit ever appeared, or verified-dead units.
- **Prevention Rule**: Always evaluate active OS/cgroup liveness probes before wall-clock TTL in resource reconcilers; attach explicit `kill` and release finalizers to background command structs to guarantee cleanup upon task eviction.

### Learning 14: Process-Relative Cgroup V2 Metrics & Explicit Unavailable Telemetry (`GPU-030`)
- **Symptom / Issue**: Image worker and native diffusion audit manifests reported `0 MiB` current and peak RAM (`memory_current_bytes: 0`, `memory_peak_bytes: 0`) and zero VRAM (`vram_used_mib: 0`), while reporting host-wide anonymous memory (`anon_mib: 428866`), corrupting per-stage RAM envelopes and Gate 2B/5 resource calibration.
- **Root Cause**:
  1. Root Cgroup Fallback: Telemetry defaulted to root `/sys/fs/cgroup` rather than resolving the process's relative cgroup. On cgroup v2, the root cgroup lacks `memory.current` and `memory.peak` (evaluating to 0), but contains aggregate `memory.stat` reflecting hundreds of gigabytes across all host slices.
  2. Silent Fallback to Zero: When metric providers (`pynvml`, `torch.cuda`) were missing from the worker's python environment, sampling returned numeric `0` instead of failing or reporting missing instrumentation.
  3. Parent Allocator vs Child Process Footprint: The native diffusion child process generated images without updating parent allocator counters, masking actual peak allocation.
- **Verified Fix**: Resolve cgroup v2 paths from `/proc/self/cgroup` (`0::<path>`) joined to `/sys/fs/cgroup` or consume verified `AQUANOX_CGROUP_DIR`. Explicitly record missing providers as `status: "unavailable"`, `provider: "none"`, and reject acceptance gate/calibration manifests when required measurements are absent. Sample device-level NVML metrics across native child process lifetimes (including model load/unload spikes).
- **Prevention Rule**: Never fall back to root cgroups for process-level accounting; resolve cgroup v2 paths relative to `/proc/self/cgroup`. Never substitute numeric zero for missing metric providers—record explicit unavailable status and fail acceptance gates when telemetry is unverified.

### Learning 15: Persistent Shared Cache Staging & POSIX Default ACLs
- **Symptom / Issue**: Isolated worker processes or containers running under distinct service UIDs fail to access pre-seeded import/build/shader caches mounted from the host (`EACCES` / Permission Denied), falling back to redundant cold asset rebuilds (`~14s`).
- **Root Cause**: Host cache directories created by build/daemon processes do not grant permissions to unprivileged sandboxed worker users, and traditional `chmod 0755` fails when workers attempt to create or atomically replace cache files. Opening directories to world-writable (`0777`) creates a security vulnerability across multi-tenant workloads.
- **Verified Fix**: Enforce POSIX Default ACLs (`setfacl -R -m u:aquanox-godot:rwx,d:u:aquanox-godot:rwx /var/cache/aquanox-godot`) and setgid `2775`, and configure systemd drop-ins (`ReadWritePaths=-/var/cache/aquanox-godot` and `BindPaths=-/var/cache/aquanox-godot`), enabling workers to read and atomically refresh caches (`seed_warm_dot_godot_cache`) in `< 0.3s`.
- **Prevention Rule**: Shared persistent host caches mounted into unprivileged isolated containers must use POSIX Default ACLs and explicit systemd `ReadWritePaths` so worker sandboxes can read and atomically refresh caches without permission errors.

### Learning 16: Live Backend Slot Capacity Reconciliation & Inspection (`GPU-031`)
- **Symptom / Issue**: `inspect_system_resources` and tool prompt budgeters advertised `384k` / `128k` context windows and admitted large context prompts even when backend inference workers ran reduced per-slot memory allocations (e.g. `98,304 / 65,536 / 32,768` tokens), causing context overflow errors.
- **Root Cause**: Resource tools reported static architectural limits without querying active slot parameters (`n_ctx`) from `:8080/slots` or `:8080/props`.
- **Verified Fix**: Reconcile advertised context limits with live backend `/slots` and `/props`. Flag `capacityMismatch: true` in diagnostic output when advertised capacity exceeds backend allocation, and bound tool prompt generation to the active slot's real capacity (`98304 / 65536 / 32768`).
- **Prevention Rule**: System resource inspection tools and prompt budgeters must query live backend slot state to report authoritative per-slot capacity rather than hardcoded architectural maximums.

### Learning 17: Effect v4 Combinator Hygiene & Immediate Scoped Child Cleanup (`GPU-032`)
- **Symptom / Issue**: Native foreground subagent launches crashed immediately after acquiring child slot 2 with `TypeError: Effect.catchAll is not a function`, leaving slot 2 in `BUSY` state (`4 committed / 4 active quanta`).
- **Root Cause**:
  1. `effect@4.0.1` removed `Effect.catchAll` (replaced by `Effect.catch` and `Effect.catchCause`). Calling removed methods fails at runtime during pipeline construction.
  2. `SessionSlotLease.registerChildSession`, `acquireSubagentAsync`, and `GpuBrokerClient.evaluateAdmission` were executed outside/before entering the outer `Effect.onExit` cleanup scope.
- **Verified Fix**: Replace `Effect.catchAll` with `Effect.catch` / `Effect.catchCause`. Place child registration and slot acquisition inside the outer scoped cleanup block (`Effect.onExit`) so `SessionSlotLease.releaseSubagentSession(childId, { purge: true })` and `activeWriteScopes.delete(childId)` execute unconditionally on any failure or cancellation, and preserve `sessionID: ${child.id}` in `ToolFailure` responses.
- **Prevention Rule**: Prohibit removed Effect v3 combinators in Effect v4 codebases; always wrap resource allocation in an immediate outer `Effect.onExit` scope before performing fallible downstream initialization.

### Learning 18: Numeric Tool Schemas in Effect 4.0+ & DeepSeek DSML Grammar Coercion (`GPU-033`)
- **Symptom / Issue**: Native tool calls to `generate_image` (with `width: 1024, height: 1024, steps: 4, seed: 42`) and `godot_sandbox` from DeepSeek V4.1 (`:8080`) arrived at OpenCode tool validation as strings (`width: "1024", height: "1024", steps: "4", seed: "42"`) and failed with `Expected number`.
- **Root Cause**: In `effect@4.0.1`, `Schema.Number` exports a JSON Schema of `anyOf: [{"type": "number"}, {"type": "string", "enum": ["Infinity", "-Infinity", "NaN"]}]`. In `llama.cpp` (`common/parsers/deepseek.cpp:201-210` & `common/json-schema.cpp:453-459`), `param.schema->may_be_string()` returns `true` if *any* member of an `anyOf` union is a string schema, causing the DeepSeek DSML grammar to emit `string="true"` and `common/chat-peg-parser.cpp:411-417` to quote numeric values unconditionally.
- **Verified Fix**:
  1. Declare numeric tool inputs with `Schema.Finite` or `Schema.Int` (`PositiveInt` / `NonNegativeInt`), which export pure `{ "type": "number" }` / `{ "type": "integer" }` without non-finite string union variants (`generate_image`, `godot_sandbox`).
  2. Implement `stripNonFiniteNumberUnion(inlined)` in `packages/core/src/tool/runtime.ts` (`toJsonSchema`) to recursively prune `{ "type": "string", "enum": ["Infinity", "-Infinity", "NaN"] }` branches from `anyOf` number unions before passing schemas to the LLM.
  3. Implement `coerceNumericStrings(value)` in `validateInput` as defense-in-depth, converting valid finite numeric strings to numbers before tool execution (`11/11` tests passing in `gpu-tools-plugin.test.ts`).
- **Prevention Rule**: Never use raw `Schema.Number` in Effect 4.0+ tool input schemas exported to LLM grammar/PEG parsers; use `Schema.Finite` or `Schema.Int` and sanitize exported schemas with `stripNonFiniteNumberUnion` in `toJsonSchema`.

### Learning 19: Auto-Derived `worktree_root` for Ephemeral `output_path` & Headless Permission Defaults
- **Symptom / Issue**: In native `S06` (`ses_e51c1ca09ffeos0HuJ5DcpXGWJ`), the session ran with `directory: "/home/rjwits"` (`WorkingDirectory=/home/rjwits`) and the model passed `output_path: "/tmp/opencode/gpu-s06-test22-teapot.png"` without `worktree_root`. Defaulting `worktree_root` to `process.cwd()` (`/home/rjwits`) caused `path.relative("/home/rjwits", "/tmp/opencode/...")` to start with `".."`, throwing `ERR_OUTPUT_PATH_ESCAPE`. Separately, unconfigured `generate_image`/`godot_sandbox` actions in `permission.ts` defaulted to `"ask"`, which blocks headless `:4096` sessions on `Deferred.await`.
- **Root Cause**:
  1. Rigid Working Directory Assumption: Tool validation defaulted omitted `worktree_root` to `process.cwd()`, failing relative path checks (`path.relative(worktree_root, output_path).startsWith("..")`) when models directed outputs to standard absolute disposable locations (`/tmp/...`, `/var/tmp/...`).
  2. Headless Interactive Prompts: Unconfigured actions in `permission.ts` defaulted to `"ask"` effect, expecting interactive human approval that never arrives in headless or autonomous background sessions.
- **Verified Fix**:
  1. When `input.worktree_root` is omitted and `output_path` is an absolute path within `ALLOWED_WORKTREE_PREFIXES` (`/tmp`, `/var/tmp`, `/home/rjwits`, `/var/lib/aquanox-runner`, etc.) without `..` traversal, auto-derive `worktree_root = path.dirname(path.resolve(output_path))` and pre-create the directory tree (`0o775`) before Broker submission, while rejecting unauthorized prefix escapes (`generate-image.ts`, `godot-sandbox.ts`).
  2. In `permission.ts` (`evaluate()`) and built-in rulesets (`plugin/agent.ts`), default `generate_image` and `godot_sandbox` to `"allow"` across autonomous agent profiles.
- **Prevention Rule**: When tools accept an optional `worktree_root` and an `output_path` intended for disposable paths (`/tmp/...`), auto-derive `worktree_root` from the validated absolute `output_path` instead of `cwd`, and ensure headless service tools never fall back to interactive `"ask"` permission gates.

### Learning 20: Systemd Transient Subprocess Wrapping (`GPU-006`)
- **Symptom / Issue**: Executing subprocesses in leaf cgroups via `systemd-run --quiet --collect --wait` broke stdio piping, started processes in `/` instead of the session's working directory (`cwd`), and dropped session environment variables.
- **Root Cause**: Omitting `--pipe`, `--working-directory`, and `--setenv` flags. Without `--pipe`, `systemd-run` attaches child stdout/stderr to journald instead of stdio pipes. Without `--working-directory=<cwd>`, units default to root `/`. Without `--setenv=KEY=VAL`, transient units drop caller environment variables.
- **Verified Fix**:
  1. In `packages/core/src/util/cgroup-wrap.ts`, implement and export `collectSystemdSetenvArgs(env, baseEnv = process.env)`: merges allowlisted execution environment variables (`FORWARDED_EXECUTION_ENV_KEYS`), filters sensitive secrets/tokens (`_SECRET`, `_TOKEN`, `_PASSWORD`, `_API_KEY`), and serializes valid keys into formatted `--setenv=KEY=VAL` arguments.
  2. In `buildSystemdLeafWrapCommand`, always assemble transient execution arguments with `--pipe`, `--working-directory=<cwd>`, and the scrubbed array returned by `collectSystemdSetenvArgs(options?.env)`.
- **Prevention Rule**: Always pass `--pipe`, `--working-directory=<cwd>`, and `--setenv=KEY=VAL` via `collectSystemdSetenvArgs` when wrapping non-interactive subprocesses in transient `systemd-run` units.

### Learning 21: Pre-Validating Writable Artifact Subdirectories & Separating Worktree Boundary from Destination (`GPU-035`)
- **Symptom / Issue**: Native `generate_image` executed GPU inference successfully but failed during artifact delivery with `OSError: [Errno 13] Permission denied` when attempting to write `manifest.json` into the root working directory (`/home/rjwits`), discarding the generated image.
- **Root Cause**:
  1. Home Directory DAC: SSH `StrictModes` requires user home directories to have mode `0750` (non-group-writable). The unprivileged Broker service (`aquanox-broker`) has read/traverse permissions but cannot create new files directly in `/home/rjwits`.
  2. Bundle Destination Conflation: Broker treated `validated_wt_root` (`/home/rjwits`) as the bundle delivery directory for `manifest.json` rather than the caller's target artifact directory (`target_out.parent`, e.g. `artifacts/` or `/tmp/...`).
  3. Late Failure: Destination writability was checked only after completing expensive GPU diffusion inference.
- **Verified Fix**:
  1. In the caller (`generate-image.ts`, `godot-sandbox.ts`), pre-create the target artifact subdirectory with mode `0o775` before Broker RPC submission.
  2. In Broker (`server.py`), validate destination directory writability (`os.access(dest_dir, os.W_OK)`) before admitting work and launching worker compute.
  3. Deliver `manifest.json` and bundle artifacts into `target_out.parent` beside the requested output file rather than the containment root (`validated_wt_root`).
  4. Retain fallback artifact copies in `/tmp/opencode/retained-artifacts/<lease_id>/` if publication fails.
- **Prevention Rule**: When a tool's `worktree_root` defaults to the user's home directory (`/home/user`, which MUST stay `0750` for OpenSSH `StrictModes`) and `output_path` defaults to `artifacts/generated_image.png`, never stage `manifest.json.tmp` directly into `worktree_root`. Keep `validated_wt_root` as the path-traversal containment boundary, write `manifest.json` beside the output file inside `target_out.parent` (`artifacts/`), pre-validate destination writability (`0775`, `os.W_OK`) before launching the GPU worker, and retain artifacts in `/tmp/opencode/retained-artifacts/<lease_id>/` if publication fails.

## Key Invariants and Gotchas

- **Bounded Child Stdio Drain (`200ms` cap in `shell.ts`)**: Stream drain races against a `200ms` timeout on child `'exit'` to prevent backgrounded children inheriting open file descriptors from hanging tool return.
- **Denying `execute` hides Code-Mode-only tools**: `deny` on action `execute` removes Code Mode and hides MCP tools (unless `"codemode": false`), `opencode.*` helpers, and `browser.*`.
- **`grep` checks pattern, NOT search path**: Evaluates permission action `grep` against `pattern`—never checks `path` arg.
- **`@opencode/codemode` (`execute`) sandbox trap**: Runs in isolated V8 sandbox without Node `fs` or `child_process`. Built-in disk tools (`read`, `grep`, `glob`, `shell`) hardcode `options: { codemode: false }`.
- **Two-stage `request_synthesis({})` control tool**: Signals completion on autonomous `general` agents, switching next turn to `toolChoice: "none"` with elevated reasoning budget (`2048..2560`), preserving 100% KV prefix cache hit rate.
