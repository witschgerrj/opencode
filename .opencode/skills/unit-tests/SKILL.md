---
name: unit-tests
description: Fix flaky or slow bun unit test timeouts Windows CI turbo spawns
---

# Fast, Reliable Unit Tests

CI exec `bun turbo test --affected --concurrency=3` on 4-vCPU Linux + Windows (`.github/workflows/check-test.yml`). Each suite shares CPU with 2 others; Windows slower. Root causes: real-time wait, excessive proc spawn, wall-clock assert.

Prereqs:
- Root `AGENTS.md`: Testing + Style Guide sections.
- `packages/app/AGENTS.md` Tests (`packages/desktop`, `packages/gui-plugins` follow): 1 owner per contract, no test seams in prod.
- `packages/ai/AGENTS.md`: cassettes. `effect` skill: `it.effect`, `it.live`.

Sibling skills: `tui-tests`, `app-e2e-tests`, `component-tests`. This skill owns CLI subproc + service tests.

## Budget

- Bun default timeout: 5000ms. Check pkg `test` script:
  - 30s: ai, cli, desktop, http-recorder, latex, merman, simulation, theme, tui pass `--timeout 30000`; core `script/test.ts` passes `--timeout=30000`.
  - 5s: client, httpapi-codegen, sdk pass `--timeout 5000`; app, codemode, function, gui-plugins, plugin, plugin-browser, script, server, session-ui, ui, util default to 5000ms.
- Size Windows risk via spawn count, not local wall time:
  - `npm.test.ts` ("installs a Git package from an npm ::path: subdirectory at a branch") takes 0.4s local, hits 5000ms on Windows CI. Each `Npm.add` Git case → ~75 git proc events (3 `clone --recurse-submodules` running git-submodule shell script).
  - ~40ms per Git-for-Windows spawn (~24s for 564 spawns). Core file groups run 5-9x slower on Windows than local.
  - `test.each` cases (`npm.test.ts:223`, `:251`) hit 5000ms in 13/45 Windows core runs → core runner defaults to 30s (`packages/core/script/test.ts:38`).
- Timeout override only loosens budget if exceeding pkg default:
  - In 5s pkg, long work gets per-test timeout + comment naming work: `packages/server/test/fetch.test.ts:406-407` ("Real retries wait 18 \* 200 ms ...", `{ timeout: 10_000 }`). `test.each(table)(name, fn, 30_000)` takes 3rd arg. File-wide `setDefaultTimeout` ONLY if every test requires it.
  - Core runner defaults to 30s: file-level `setDefaultTimeout(30_000)` redundant; `{ timeout: 15_000 }` (`tool-shell.test.ts`, `session-generate.test.ts`) stricter than default. Never add values <= 30s in core.
- Never mask sleep/poll/prod interval with larger timeout, `--retry`, or `skipIf(win32)`. Skip on Windows ONLY if OS lacks capability + comment (`npm.test.ts:313`, symlinks).

## Control Time; Do Not Wait

- **Effect code**: `it.effect` (`packages/core/test/lib/effect.ts`) runs on `TestClock`; `testEffect(layer)` injects layer. server + cli import from `../../core/test/lib/effect`; ai uses `packages/ai/test/lib/effect.ts`.
- **Fork, then adjust**: Fork via `Effect.forkChild({ startImmediately: true })` (`packages/ai/test/http-timeout.test.ts:58`), or await Deferred completion → `Effect.yieldNow` (`:80-81`). Otherwise `TestClock.adjust` runs before sleep registers → join hangs until timeout.
- **Debounced streams/watchers**: `advance(condition)` + `drain` (`packages/core/test/lib/clock.ts`) alternate 1 real 1ms macrotask with 500ms adjusts (debounces register sleeps across fiber hops). Use `drain` (4 steps) before "nothing happened" assert instead of `Bun.sleep(25)`. `advance` bounded by 15s real time, not step count (`supervisor-reload.test.ts`).
- **Real I/O between virtual steps**: `TestClock.withLive(Effect.sleep("10 millis"))`. See `registered()` (`packages/cli/test/service.test.ts:740`) testing 5s registration watch with real file I/O under `it.effect`.
- **Real events require `it.live`**: Under `it.effect`, clock moves only via test adjust. Effect timeout on paths driven by real procs/sockets/FS never fires → missing event hangs. AppProcess tests (`packages/core/test/process/process.test.ts:13-14`) use `it.live` due to 1s post-exit capture deadline (`packages/util/src/cross-spawn-spawner.ts:322`).
- **Racing component clock isolation**: Provide separate `Clock` to component racing slow setup, test moves past deadline. `packages/core/test/browser-idle.test.ts:24-38` wraps live clock for `LocationActivity` (`:49-51`), adds TTL at `:84` post browser state attach. Avoids 2s TTL race on Windows CI.
- **Product Effect code on caller clock**: Read time via `Clock`, wait via `Effect.sleep` or `Schedule`, run nested effects with caller ctx.
  - Bare `Effect.runPromise` runs on default real clock (`packages/core/src/mcp/stdio.ts:66`, `:82`, `:109` → `packages/core/test/mcp.test.ts:832` waits real 2s `CLOSE_GRACE`).
  - Capture `yield* Effect.context()` → `Effect.runPromiseWith(context)` (`packages/cli/src/acp/agent.ts:27`).
- **Non-Effect code** (app, desktop, ui, session-ui): `jest.useFakeTimers()` + `setSystemTime` (`bun:test`), restore in `afterEach` (`packages/desktop/src/main/plugin/lifecycle.test.ts:27-32`, `packages/desktop/src/main/storage/drafts.test.ts:15-17`).
- **Advance fake timers to next timer**: `jest.advanceTimersToNextTimer()`, `jest.runOnlyPendingTimers()`. Avoid fixed small steps (`advance` 10ms steps in `lifecycle.test.ts:37` caused ~430k event-loop turns, 2.8-3.8s on Windows).

## Real-Time Waits: Deadlines, Not Attempt Counts

- Bound real-time poll in ms generously, exit early on success: `until` (`packages/cli/test/service-lifecycle.test.ts:267`, 30s), `eventually` (`packages/core/test/integration.test.ts:37`, 10s).
- Avoid attempt-count loops (collapse under CI load). Do not use `waitUntil` with fixed small intervals (`packages/core/test/config/reload.test.ts:371` 100 × 10ms; `packages/core/test/plugin/provider-azure.test.ts:219` 3000 × 1ms).
- Poll for every state asserted afterwards (`reload.test.ts:301-317` includes skills asserted at `:319-320`).
- Test releases child proc step, not timers: `integration.test.ts:230-254` writes release file after checking pending status instead of `Bun.sleep(50)`.
- Avoid tight child timer deltas: stdout/stderr ordering with 10ms vs 20ms failed on Windows CI; use 100ms vs 200ms (`packages/core/test/process/process.test.ts:59-67`).

## Waits in External Processes

TestClock cannot reach spawned servers/workers. Existing real-time costs:
- cli (~60s): 15s bind-retry (`Date.now() + 15_000` in `packages/cli/src/server-process.ts`), 5s registration watch (`packages/cli/src/services/service-registration.ts:63`), fixed sleeps (`Bun.sleep(8_000)` in `service.test.ts:620`, `Bun.sleep(5_500)` in `service-lifecycle.test.ts:237`).
- core (~8s): McpStdio `CLOSE_GRACE` 2s + `FORCE_KILL_AFTER` 2s (`stdio.ts:10-13`), Shell `forceKillAfter` 3s (`packages/core/src/shell.ts:306`, `:401`), 1s cross-spawn capture deadline.

Mitigations:
- Test timing logic in-process under `TestClock` (`registered()` tests at `service.test.ts:270-299`). Keep real procs for exit codes, signals, stdio, port binding (1 test per escalation path).
- Shorten prod durations via options, not sleep:
  - Product options: `Flock.Options` (`packages/util/src/flock.ts:41-47`), `idleTimeout`/`flushInterval` (`packages/client/src/solid/connection.ts`), `withEnsureTiming` seam (`packages/client/src/service-timing.ts:31`).
  - Spawned procs require passing param to child (e.g. `timeoutMs` in worker payload at `packages/core/test/util/flock.test.ts:50-58`).
  - app, desktop, gui-plugins forbid test seams; core, cli, util, client, tui permit.
- Retry timing belongs in core under `TestClock`. `packages/server/test/fetch.test.ts:363-408` wastes ~5.8s in 200ms bind retries (`packages/core/src/plugin/provider/openai.ts:21`). Keep fixed ports 1455/1457 only where contract requires; new tests cover routing/err mapping only. Otherwise bind port 0 (`packages/app/src/runtime/server/global-sync/bootstrap.test.ts:81`).

## Do Not Assert Wall-Clock Speed

- `expect(performance.now() - startedAt).toBeLessThan(500)` fails on Windows CI load spikes (`packages/ui/src/context/marked-parser.test.ts:84`, `packages/core/test/shell-scan/adversarial.test.ts:77`).
- Count ops, or pick inputs where regression causes timeout (`packages/codemode/test/openapi.test.ts:638`, depth 30 requires 2^30 ops without memoization). If asserting ratio between timings, use generous margins + mark timing-sensitive.

## Spawn Less

- **Proc startup cost**: `bun run src/index.ts` CLI boot costs ~1.3s CPU (preload loads TUI `.tsx` via `packages/cli/bunfig.toml`). Test parsing/validation in-proc; limit to 1-2 real subprocs per file. Cold bun MCP SDK import costs 1-3s; use in-proc `resourceServer()` (`packages/core/test/mcp.test.ts:90`).
- **Spawned CLIs**: Use `isolatedEnv(root)` (`packages/cli/test/fixture/environment.ts`): isolates HOME, XDG, DB, shares transpiler cache. Do not set private `XDG_CACHE_HOME` without `BUN_RUNTIME_TRANSPILER_CACHE_PATH` (forces recompile; avoid pattern in `upgrade.test.ts:98`, `debug-paths.test.ts:24`).
- **Git**:
  - Use `packages/core/test/fixture/git.ts`. `initGit(directory, ...initArgs)` (`:24-27`) runs single `git init`, appends fsmonitor, gpgsign, identity to `.git/config` in 1 write. `initRepo` (`:64-67`) adds empty root commit (2 spawns total vs 6 with separate `git config`). `gitRemote` builds on `initGit`.
  - Avoid per-file `git init` + `git config` scripts (`packages/server/test/vcs.test.ts:215-218`, `packages/server/test/worktree.test.ts:131-133`). Import core fixtures.
  - Use `-c user.name=… -c user.email=…` only for test-authored commits (`npm.test.ts:53`). Repos with prod commits (snapshot, worktree, vcs) require repo-local identity.
  - Keep git identity repo-local. CI unit job sets global identity, but core `script/test.ts` and cli `isolatedEnv` override HOME (invisible to core, visible to server/tui). Do not add global gitconfig in core.
- **Parallel subprocs**: Start concurrently via `Promise.all` (`packages/ai/test/exports.test.ts:63`). Avoid sequential `Bun.spawnSync` (`packages/app/test-browser/playwright-config.test.ts`) or sequential `pwsh` starts (`packages/desktop/script/windows-installer.test.ts`).
- **Contention / thresholds**: `flock.test.ts:46` uses bun workers; bound worker count to CI capacity (4 vCPUs). Do not hardcode massive datasets to hit prod limits: `packages/core/test/git.test.ts:354` wrote 2,100 files to exceed `looseObjectLimit = 2048` (`packages/core/src/git.ts:50`). Make threshold configurable, test with low value, assert default limit once.

## Windows-Only Failures

- **File lock on rename**: Renaming over open file fails with `EBUSY` (`packages/cli/test/service.test.ts:462` via `FileSystem.rename` in `service-registration.ts:39`). Close file handles in tests; if prod procs race, fix prod code.
- **SIGTERM handling**: `process.kill` terminates Windows proc immediately (exit code 1); shutdown handlers run POSIX-only. Assert platform differences via `catchesSigterm`, `stopSignal`, `stoppedExitCode` (`packages/client/test/fixture/service-fixture.ts:7-11`).
- **Port reuse races**: Never re-bind port to verify server shutdown. Windows ephemeral ports (>= 49152) get acquired by concurrent tasks → re-bind fails with `EADDRINUSE`. Assert via `expectNotListening` (`packages/client/test/fixture/service-fixture.ts:108-117`).
- **Temp path envs**: `os.tmpdir()` uses `TEMP` on Windows, `TMPDIR` on POSIX. Set both for child procs (`packages/util/test/global.test.ts:22-24`). Resolve 8.3 short names (`RUNNER~1`) via `fs.realpathSync.native` (`:84-86`).
- **Socket reset timing**: Reset test socket on `data` event, never `open`. Resetting on `open` races client write → returns connection/write error on Windows (`packages/util/src/retry.test.ts:25-30`).

## Temp Dirs, Files, Process State

- Core `script/test.ts` sets HOME, XDG\_\*, TMPDIR, USERPROFILE, TMP, TEMP to fresh dir per run. Per-test temp dirs: `tmpdir()` (`await using`), `tmpdirScoped`, or `withTempDir` (`packages/core/test/fixture/tmpdir.ts`).
- Close watchers, DB connections, child procs before dir cleanup. Open handles cause Windows `EBUSY`. `remove` in `tmpdir.ts` triggers GC + retries every 100ms (max 30 retries).
- Restore proc state: env vars via `withEnv` (`packages/core/test/fixture/env.ts`) in Effect tests or `afterEach`, restore fake timers via `setSystemTime()`.
- CI env overrides: `CI=true` set in CI workflow. Code checking `CI` branches differently; tests covering non-CI behavior must unset explicitly (`packages/http-recorder/test/websocket.test.ts:132` uses `withEnvironment("CI", undefined, ...)`).

## Keep Files Independent Without `--isolate`

- All files in suite run in single proc / module registry (core: 262 files) except `app`. State leaks across files.
- **Do not use `mock.module`**: leaks globally.
  - Forced app to use `--isolate`: unit tests slowed 2.4s → 9.9s local, 5.3s → 12-20s CI.
  - Leaks in non-isolated suites: `packages/cli/test/mini-config.test.ts:25`, `packages/core/test/plugin/provider-gitlab.test.ts:74`.
  - Fix: inject deps via test layer (Effect) or use constructor/fn params (app, desktop, gui-plugins).
- **Never add `--isolate` or `--parallel`** (`--parallel` implies `--isolate`): ai slowed 7.6s → 26.3s with `--parallel=2`.
  - Maintainers only: `--parallel=N --no-isolate` keeps shared registry, reduces wall time (0.47-0.68x) in core.
- **Import side effects**: `packages/desktop/src/main/storage/store.ts:3` imports `electron` → test suites download ~100MB Electron binary on cold runs (5.3s file init for 0.1s test run). Use `import type` for types (`packages/desktop/src/main/ipc-transport.test.ts:4`).

## Turbo Test Tasks

- `bun turbo test` runs pkgs with `test` script via generic task in `turbo.json` (`"dependsOn": ["transit"], "outputs": []`). Verify inclusion via `bun turbo test --dry=json`. Override via `@opencode/<pkg>#test` only when needed (e.g. desktop disables cache).
- `transit` task depends on `^transit` → test hash encompasses entire workspace closure. Global deps: root `package.json`, `bunfig.toml`, `patches/**`, `.npmrc`, `.github/actions/setup-bun/**`, `check-test.yml`.
- Tests must import source, not build artifacts: workspace pkgs export source (`"./*": "./src/*.ts"` in `packages/core/package.json`). Do not read `dist/`.
- TSC build exclusions: exclude test files in `tsconfig.build.json` (`"exclude": ["src/**/*.test.ts"]` in `packages/util/tsconfig.build.json`). Prevents `bun test` from executing compiled `.js` files alongside `.ts` files on Windows CI.

## CI Flake Diagnostics

- Suites run with `--only-failures`: `(fail) <name> [5000ms]` + `^ this test timed out after 5000ms`.
  - Followed by `killed 1 dangling process` + `# Unhandled error between tests` (`NpmInstallFailedError` via `SIGTERM` on `git clone`): proc was actively executing, not deadlocked.
  - Unhandled error = abandoned Effect aborting after Bun killed child proc.
- Check dev branch failures: `gh run list --workflow check-test.yml --branch dev --event push --status failure`.
- Inspect complete logs: `gh run view --log --job <id>` (`--log-failed` hides passing jobs containing baseline runtime stats).
- Assert child stderr before exit code: checking exit code first masks underlying stderr error (`packages/core/test/util/effect-flock.test.ts:327-328`).

## Pre-Push Checklist

Run from pkg dir using flags from `test` script (app requires `--conditions` and `--preload`). In core: `bun run script/test.ts <file> …` (forwards flags, isolates HOME, sets 30s timeout).

- [ ] `bun test <file> --rerun-each 10` passes 10/10. Test order independence with `--randomize`; reproduce with `--seed=<n>`.
- [ ] Profile durations: `--reporter=junit --reporter-outfile=<abs path>` (supported in `script/test.ts`). Audit any test > 1s.
- [ ] Windows spawn profiling: `GIT_TRACE=<abs file>` logs `trace: built-in:` / `trace: exec:`. Target ~40ms/spawn vs pkg timeout.
- [ ] Concurrency test: execute target test while running full pkg suite in parallel terminal (simulates CI 4-vCPU load).
- [ ] Diff check: grep for `Bun.sleep(`, `setTimeout(`, `Date.now() +`, `performance.now()`, `Effect.runPromise(`, `mock.module`, `git config`, literal port numbers.
- [ ] Post-CI log comparison: compare `Ran N tests across M files. [Xs]` line against baseline dev run.
- [ ] Workspace check: `bun turbo test --dry=json` includes `@opencode/<pkg>#test`.
