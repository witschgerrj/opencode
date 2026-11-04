---
name: tui-tests
description: Write fix review OpenTUI tests frames clocks mocks inputs timeouts packages/tui
  packages/cli.
---

# TUI tests

`packages/tui` runs ~170 test files in single `bun test` proc. CI runs beside <=2 suites on 4-vCPU runners (`bun turbo test --affected --concurrency=3` in `.github/workflows/check-test.yml`), taking 136-146s Linux, 147-171s Windows, mostly idle on frame pacing, prod timers, sleeps. Flakes come from waiting wrong signal → frame budget exhaustion on loaded runner.

Read root `AGENTS.md` Testing section (no `globalThis` mocks, run from pkg dir) + TUI Stories section. Drive real TUI → `opencode-dev`. CLI subprocesses, service deadlines, Effect `TestClock`, turbo test tasks → `unit-tests`.

## Frame budgets != time

- `waitForFrame`, `waitFor`, `flush` abort after `maxPasses` (default 20). `waitForVisualIdle` aborts after `maxFrames` (default 20). 1 pass = 1 rendered frame (`DEFAULT_MAX_PASSES` in `@opentui/core/testing`). "Timed out waiting for frame predicate after 20 passes" = frame budget exhausted, not Bun timeout.
- **Started renderer** (`setup.renderer.start()`, e.g. `createAppFixture` at `packages/tui/test/fixture/app.ts:28`): frames tick at default 30 fps → 20 passes ≈ 0.66s. Prod renders at `targetFps: 60` (`packages/tui/src/app.tsx:241`) → test frames 2x slower than real app.
- **Not started** (default for `testRender`, `createTestRenderer`): `waitFor`, `waitForFrame` fail in ms when no render scheduled (`isRunning: false`). `flush()`, `waitForVisualIdle()` ret immediately without err; no wait for fetches/timers. Await signal → `renderOnce()`.
- Wait on frames ONLY for frame-produced artifacts. Otherwise await underlying signal:
  - **Focus via timer:** `DialogSelect` focuses filter via `setTimeout(..., 1)` (`packages/tui/src/ui/dialog-select.tsx:702`), ~15ms on Windows. `typeText` targets focused elem → early keys dropped → Enter picks default option. Put focus check in predicate (`packages/tui/test/command-selection.test.tsx:68-70`, `:75-80`): `setup.renderer.currentFocusedRenderable instanceof InputRenderable`. If wait fails with focus predicate, investigate state race, not budget.
  - **Markdown/code text:** `<markdown>` (`packages/tui/src/routes/session/message-parts.tsx:182`) draws no text until tree-sitter worker replies. Plain `waitForFrame` burns 20 passes while text pending. Use `waitForHighlightedFrame(setup, predicate, options?)` (`packages/tui/test/fixture/frame.ts`). Awaits inflight `CodeRenderable.highlightingDone` inside predicate without burning passes. Or inject `new MockTreeSitterClient({ autoResolveTimeout: 0 })` (`packages/tui/test/mini/scrollback.surface.test.ts:87`).
  - **Requests/state:** Await deferred res from fetch handler. Without signal, poll wall-clock deadline instead of increasing `maxPasses`: poll `captureCharFrame()` every 10ms up to 2s (`command-selection.test.tsx:117`). See `wait` (`packages/tui/test/cli/tui/data.test.tsx:37`), `waitForModel` (`packages/tui/test/fixture/local.tsx:109`).
- `waitForVisualIdle` returns on first frame with `cellsUpdated === 0`. Frame waiting on highlight is quiet → wait for text before measuring layout: `session-home.test.tsx:227` calls `waitForHighlightedFrame` after `waitForVisualIdle()`.
- Settle steps cost frames: `waitForVisualIdle({ quietFrames: 3 })` takes >=3 frames (~100ms at 30 fps). Wait for target frame directly instead.
- Never use `maxPasses` as clock (assumes 33ms frames):
  - `app-lifecycle.test.tsx:792`: 120 passes for 1s reconnect delay
  - `app-lifecycle.test.tsx:1721-1723`: 200 passes/sec for retry-countdown
  - `component/dialog-shell-output.test.tsx:144`: 100 passes for 1s poll, plus `Bun.sleep(1100)`
  - `session-panel.test.tsx:590`: 120 passes in `ready()` for init load

  Higher frame rates break pass-based clocks. Large budget only valid for long frame-driven sequences (e.g. scrolling 50 rows).

## Pick renderer mode and clock

- **Component logic:** `testRender(() => <X />, { width, height })` without `start()`. Mutate state → `await app.renderOnce()` → assert `captureCharFrame()`. Deterministic, single frame.
- **Time-driven renderables:** pass `clock: new ManualClock()`, call `renderer.pause()`, advance clock → `renderOnce()` (`packages/tui/test/component/retry-provider.test.tsx:8`). `pause()` prevents `requestLive()` (spinners, animations) starting loop.
- **Clock order:** inject clock first (`ManualClock`; Effect `TestClock` for Effect code). Use `jest.useFakeTimers()` only as fallback; restore via `jest.useRealTimers()` in `finally` (`packages/tui/test/util/delayed-presence.test.ts:24-26`).
- **Whole app:** `createAppFixture` (`packages/tui/test/fixture/app.ts`) provides started renderer, in-proc `Bun.serve`, `kittyKeyboard: true`. `await setup.ready` before first wait. Custom `config` replaces `{ animations: false }` default → explicitly include `animations: false`. First call in proc pays cold `await import("../../src/app")` (~1s idle, 12-25s under load). Use only across routes/data.
- **Server behavior:** use `createFetch` / `createEventStream` (`packages/tui/test/fixture/tui-client.ts:15, :69`), no spawned servers. E.g. persistent PTY faked via `/api/experimental/persistent-pty/...` routes + `Bun.serve` websocket (`packages/tui/test/session-wheel-focus.test.tsx:52`); real PTY tested in `packages/server/test/persistent-pty.test.ts`. Fixture servers listen on `port: 0` (`fixture/app.ts:32`), access via `server.url`. Never hardcode ports (conflicts with Windows ephemeral range >=49152).

## Keyboard and mouse

- Use `setup.mockInput`: `pressKey`, `typeText`, `pressEnter`, `pressEscape`, `pressArrow`, `pasteBracketedText`.
- Init renderers with `kittyKeyboard: true` to prevent dropped modifiers:

  | Input | Without kitty mode | With kitty mode |
  | --- | --- | --- |
  | `pressKey("u", { ctrl: true, shift: true })` | `ctrl+u` | `ctrl+shift+u` |
  | `pressKey("2", { ctrl: true })` | `2` | `ctrl+2` |
  | `pressEnter({ shift: true })` | `return` | `shift+return` |
  | `pressEscape()` then `pressKey("a")` | `meta+a` (lone Escape held 20ms) | `escape`, `a` |

- Click <=500ms (renderer clock) within 1 cell = word/line selection. Avoid `Bun.sleep(550)` (`packages/tui/test/session-activity-anchor.test.tsx:120`). Call `setup.renderer.clearSelection()` to reset history, click >=2 cells away, or call `clock.advance(501)` with `ManualClock`.

## Terminal sizes

- Always supply `width` and `height`. Otherwise defaults to `process.stdout.columns` (local terminal size; 80 in CI).
- Test layout narrow + wide: `test.each([100, 44])` (`packages/tui/test/app-lifecycle.test.tsx:13`). After `setup.resize(w, h)`, call `await setup.renderOnce()` or `flush()` before asserting. Run real-time sequences at single width only.
- Assert by count, not duration: mounted rows (`packages/tui/test/session-mount-budget.test.tsx`), rendered diff lines (`packages/tui/test/cli/tui/diff-viewer.test.tsx:2198`). Avoid `performance.now()` thresholds.

## Timers, cleanup, shared state

- Test >1s usually waits on hardcoded prod const → make injectable. Examples: shell output poll `setTimeout(poll, more ? 0 : 1_000)` (`packages/tui/src/component/dialog-shell-output.tsx:73`), `reconnectDelay = 1_000` (`packages/client/src/solid/connection.ts:33`). Add options beside existing `idleTimeout` / `flushInterval`.
- Clean up via `await using` or `finally`: cancel timers → destroy renderer → stop fixture server. Uncancelled timers throw "TextBuffer is destroyed" in subsequent tests.
- Remove tmpdir last: destroy renderer and await app task first (`fixture/app.ts:63` `[Symbol.asyncDispose]`). Deleting during active write causes "Failed to persist" / flock "lock is compromised".
- `TestTuiContexts` (`packages/tui/test/fixture/tui-environment.tsx:32-35`) defaults `home` and `state` to fixed `/tmp/opencode/...`. If mounting state-writing provider (`StorageProvider` in `src/context/storage.tsx:145`, `LocalProvider`, prompt history, frecency, stash), pass isolated `paths={{ state, home }}` via `tmpdir()` (`test/fixture/fixture.ts:8`). Shared paths prevent worker parallelization.
- Bun keeps running timed-out test body → causes cascading errors / "Unhandled error between tests". Debug first failure in file.
- Cross-pkg test helper imports: relative paths allowed only within workspace dependency closure. `@opencode/tui#test` depends on `transit` in `turbo.json` (folds closure into hash). Pkgs outside closure skip hashing → risk stale test passes.

## Timeouts and failures

- Script timeout: `bun test --timeout 30000` (Bun default = 5s). Headroom exists for cold `src/app` import, not slow waits.
- Frame budget failure != timeout issue. Increasing test timeout or `maxPasses` masks broken waits.
- Custom timeouts <30s (e.g. 15000 in `session-group-navigation.test.tsx:249`) must accommodate cold import when executed isolated. Document purpose in comment.
- Deterministic frame-budget failure across runs on branch = regression, not flake. Do not bump budget.
- Never use `skipIf(process.platform === "win32")` for timing races. Windows timers have ~15ms granularity; fix underlying wait.

## Verification checklist

- From `packages/tui`: `bun test --timeout 30000 test/<file>` (shows per-test ms).
- Run stability loop: `bun test --timeout 30000 test/<file> --rerun-each 10` (must pass 10/10). Test beside background load (`bun run test` in `packages/core`). Timeout on iteration 1 = cold import overhead.
- Verify race fix: artificially delay timer/res (e.g. set focus `setTimeout` to 150ms). Must still pass. Revert after.
- Negative control: inject impossible predicate. Test must fail fast via frame dump, not hang until timeout.
- Windows checks: timers <16ms, open file renames, proc kills, path formats in frames. CI `unit (windows)` job: inspect `@opencode/tui:test:` log for `cache miss, executing`, verify pass, check `Ran N tests across M files. [Xs]`.
