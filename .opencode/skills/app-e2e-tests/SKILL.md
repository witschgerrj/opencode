---
name: app-e2e-tests
description: Write, review, and debug Playwright E2E tests in packages/app/e2e against mocked OpenCode servers and the Bun static server with per-test isolation, SW blocking, race-free mount/hover/clock synchronization, and CI flake analysis.
---

# App E2E Tests (`Caveman Ultra`)

Read `packages/app/e2e/AGENTS.md`, `packages/app/AGENTS.md` (Tests), & `packages/app/README.md` first. Paths below are relative to `packages/app` unless prefixed `packages/`, `services/`, or `.github/`. CI runs 2 shards/OS on 4-vCPU runners (`.github/workflows/check-test.yml:217-240`).

## 1. Test Harness & Mock Server

- **0 Real Backend**: `bun --cwd packages/app test:e2e:built --shard=<n>/2` (`check-test.yml:287-292`) builds once & starts 1 shared Bun static server (`e2e/utils/serve.ts`) on `127.0.0.1:${PLAYWRIGHT_PORT ?? 3000}` across 5 workers (`playwright.config.ts:23-27`). Never revert to `vite preview` (synchronously scans ~3,100 `dist/_assets` files per req on case-insensitive FS).
- **Per-Page In-Memory API Mock (`mockOpenCodeServer`, `e2e/utils/mock-server.ts:202`)**:
  - Routes `page.route("**/api/**")` via Effect `HttpApi`; fakes `/api/event` SSE via init-script `fetch`; serves PTY sockets via `routeWebSocket`.
  - Unmocked routes fail w/ `501 Unmocked API request` (`mock-server.ts:403-411`) → register in `mock-server.ts` once.
- **Helpers**:
  - `mockWorkspace`, `openSession`, `openDraft`, `openWorktreeDraft`, `mockRemoteServer`, `openSettings` (`e2e/utils/workspace.ts`).
  - `setupTimeline` (`e2e/utils/timeline.ts:209`), `mockServers` (`mock-server.ts:495`), `seed` (`e2e/utils/app.ts:61`), `holdRoute` (`app.ts:207`).
  - **SSE Events**: Use mock `push` (buffers until connect) or `installSseTransport` (`e2e/utils/sse-transport.ts:60`, `send` resolves on delivery; after `page.reload()`, await `transport.waitForConnection()` first, `timeline-stream.spec.ts:1700-1702`).
- **Windows Failures = Ordering Races**: Mock dirs are `C:/OpenCode/<name>` on all OSes (`workspace.ts:33`); lazy chunks/CSS/API finish out of order on Windows CI.

## 2. Isolation Rules

- **0 Shared State**: Fresh context/mock/init-script per test. Outside `e2e/service-worker` (`cache.spec.ts:21,:74`), ban `beforeAll`, serial mode, `test.extend`, & worker fixtures so `-g` & `PLAYWRIGHT_FULLY_PARALLEL=1` work.
- **Mutated Fixtures**: `mockOpenCodeServer`/`mockServers` mutate passed objects in place (`sessions` push `:839`, `session.title` `:1340`, `project.vcs` `:1019`; `mockWorkspace`/`openSession` copy, `workspace.ts:36-48`). Call `session()`/`project()` & stateful timeline builders (`assistantMessage`, `partUpdated`, `timeline.ts:165-198`) **inside** each test (only pure `toolPart` at module scope).
- **Seed Pre-`goto`**: `seed` writes once behind a `sessionStorage` marker (`app.ts:59-90`).

## 3. Speed & Route Discipline

- **Navigate Once**: Each `goto`/`reload` = ~150 uncached requests (~125 static files). Transition via UI/SSE unless reload persistence is the contract.
- **SW Blocked Suite-Wide (`serviceWorkers: "block"`, `playwright.config.ts:66-67`)**: Do not add per-file blocks. Only `e2e/service-worker/` (`check-test.yml:294-298`) uses `serviceWorkers: "allow"` (`clientsClaim: false`, `vite.pwa.ts:26-28`). Ignore Playwright's SW block warning via `captureConsoleWarnings` (`e2e/utils/command-palette.ts:15-26`).
- **Route Matchers = RegExp or Query-Aware Glob, NEVER Function**:
  - Function matcher intercepts `**/*` (250 static asset round-trips/test).
  - Use `/\/api\/vcs\/init\?/` or `"**/api/session?*"` (`command-palette.spec.ts:10,:28`).
- **Avoid Stress Fixture Unless Scale is Contract**: `fixture`/`mockStressTimeline`/`installStressSessionTabs` (`session-fixture.ts:336,:436,:448`) mounts 300-line diffs (4–11 s CI block, ~50% of flakes). Prefer `openSession`/`setupTimeline`.
- **Avoid Loop Assertions & Real Waits**: Failed web-first assertions backoff `100/250/500/1000ms`. Use `page.clock` installed pre-`goto` (`timeline-stream.spec.ts:1700`), keeping fast-forwards `< 45s` SSE idle timeout (`packages/client/src/solid/connection.ts:35`). Gate message paging via `beforeMessagesResponse` (not benchmark `sendAll`/`messageDelay`).

## 4. State Synchronization (CI Race Fixes)

- **Staged First Mount**: `openSession`/`expectSessionTitle` resolve before loading `<h1>` swap & cold timeline auto-scroll finish. Wait for final-mount row (`[data-timeline-row="UserMessage"]` or target button) before measuring/hovering (`session-summary.spec.ts:21-26`, `subagent-child-navigation.spec.ts:60-64`).
- **Late `goto` & Modals**: Open dialog sets `aria-hidden` on app root. Hold modal-triggering routes (e.g. What's New 500ms post-changelog, `whats-new.spec.ts:227-234`) until readiness is asserted.
- **Clock Install**: Install `page.clock` at explicit timestamp & `pauseAt` positive offset (`tabs.spec.ts:443-445`) to avoid `"Cannot fast-forward to the past"`.
- **Shortcuts & macOS**: Global shortcut handler ignores keys while `dialog.active` (`src/shell/commands/command.tsx:489`, `packages/ui/src/context/dialog.tsx:52,:87,:310-311`). Desktop Chrome profile sets `navigator.platform = "Win32"` (`IS_MAC = false` → expects `Ctrl`, while macOS `ControlOrMeta` sends `Meta`); pick modifier from page (`session-summary.spec.ts:29-30`) & never hard-edit tests for macOS.
- **Font Probes**: Late `@layer` CSS rebuilds font faces as unloaded → `await document.fonts.ready`, lay out new text, then check `document.fonts.check()` once (`timeline-cache.spec.ts:281-293`).
- **Harness Signals**: Use `holdRoute(...).arrived`, `transport.send`, & `setupTimeline(...).waitForPart` (`timeline.ts:328`). Fix product bugs when interleaving is user-reachable (`observe-element-offset.ts`, `artifact-view.tsx:612`, dialog close keys).

## 5. Scheduling & Worker Reuse

- **Projects (`playwright.config.ts:69-86`)**: `chromium` (file-serial unless `PLAYWRIGHT_FULLY_PARALLEL=1`) vs `chromium-touch-scroll` (`mobile-timeline-scroll.spec.ts`, `fullyParallel: true`, queues last → Shard 2).
- **Avoid Worker Forks**: `launchOptions/channel/headless/video/trace/screenshot/defaultBrowserType` fork new worker hash (`patch-border.spec.ts:5-9`). Use test-scoped options (`viewport/deviceScaleFactor/hasTouch/isMobile/userAgent/colorScheme/serviceWorkers/locale`) & copy needed fields instead of spreading WebKit `devices[...]` (`mobile-timeline-scroll.spec.ts:23-28`).
- **Timeouts**: `60s`/test, `10s`/assertion, `30s` `APP_READY_TIMEOUT` (`e2e/utils/waits.ts:4`). Scope long waits to specific assertion `{ timeout: 20_000 }` (`settings-wsl.spec.ts:268-276`); `test.setTimeout` does not extend assertion polls.

## 6. Pre-Push & CI Flake Diagnosis

- **Run Built Mode**: `PLAYWRIGHT_PORT=4310 bun run test:e2e:built -- e2e/regression/<file>.spec.ts` (keep port `< 49152` on Windows). Fast repeat: `VITE_OPENCODE_TEST_FIXTURES=1 bun run build` → `bun e2e/utils/serve.ts --host 127.0.0.1 --port 4310` → `PLAYWRIGHT_BUILD=1 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4310 bun run test:e2e -- --repeat-each=10 --workers=5 --retries=0 -g "<title>"` + 1 run w/ `PLAYWRIGHT_FULLY_PARALLEL=1`.
- **Rehearse Windows Races**: Delay lazy chunks/CSS/API `0.6–1.5s` via `holdRoute` (`page.context().route` for workers).
- **Typecheck**: `bun run typecheck:e2e` (0 new errors beyond 4 known baselines; update `test-browser/playwright-config.test.ts` if `playwright.config.ts` changes).
- **CI Artifacts**: `gh run download <run-id> -n playwright-windows-app-2-1 -D <dir>` → inspect `error-context.md` & `test-failed-1.png` in `<test>-<project>/`, or `bunx playwright show-trace ...-retry1/trace.zip` + `ffmpeg -i video.webm -vf fps=4 frame-%03d.png` + `bunx playwright show-report`.

## I/O Protocol: Execute & emit intermediate/subagent steps in Caveman Ultra; final Depth-0 user tail in Caveman Full + Team Lead.
