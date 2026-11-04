---
name: component-tests
description: Write, debug, review Playwright component tests mounting stories in packages/app
  or packages/session-ui with Vite harness
---

# Component tests

Each pkg suite starts one story server (plain Vite dev server for `packages/stories`), shared across workers (`packages/stories/playwright/config.ts:17-26`; CI uses 2 workers, `config.ts:15`). With `fullyParallel` (`config.ts:12`), tests run across workers in any order. No backend: server, SDK, sync modules mock in-page. Fresh ctx per test; `mount` = full page navigation to frame (`packages/stories/playwright/story.ts:37`). Flake/perf sources: shared server dep optimizer, module resolution layout, cold first story, mobile drawer product races, pre-mature actions.

Read first:
- `packages/stories/playwright/README.md` layout, run commands, adding tests.
- `packages/app/AGENTS.md` test existence rules, theme/dir cases, fail-before-fix rule.
- `packages/app/e2e/AGENTS.md` test hygiene.

## Stories and `mount`

- **Location**: Put story next to production component under `src/` in `ui`, `session-ui`, `app`, `gui-plugins`. Server indexes `*.stories.tsx` across four trees (`packages/stories/vite.config.ts`, `src/index-plugin.ts`), reading `export default { title, id }` + `export const` stories.
- **Story ID**: Meta `id` if set (`packages/session-ui/src/components/session-review.stories.tsx:25`), else kebab-cased `title` + `--` + kebab-cased export. Verify via `http://127.0.0.1:6006/?id=<id>` on running server (`bun --cwd packages/stories dev`). Bad ID → throws `No story has the id …` → `mount` hits 30s root wait (`story.ts:39`) → fail.
- **URL args**: `mount(id, { args, globals })` writes `key:value` pairs to URL (`story.ts:20-36`). Frame parses: boolean/number when story default matches, `!true`/`!false`/`!null`/`!undefined` preserve Storybook semantics, rest stay string.
  - Set typed defaults: `args: { split: false }` (`session-review.stories.tsx:129`) → `split:false` parses boolean.
  - Semicolons split pairs: select `;` values inside story via `scenario`-style arg.
- **Globals**: `theme` (default `light`), `direction`, `locale` (`packages/stories/src/frame.tsx`).
- **Portaled UI**: `mount` returns `#story-root`. Dialogs, menus, drawers render outside; locate via `page` (`packages/app/component-tests/composer.spec.ts:101-107`).
- **Server state**: Set via `resolve.alias` in `packages/stories/vite.config.ts` → points app server, SDK, sync modules to `packages/stories/mocks/app/**`. Extend mock, do not add server. Stories must not rely on mock-only exports (components lab renders stories in real app). Tests reset mock state on mount.
- **Unmocked reqs**: Route via `page.route` (server endpoints like `/api/fs/read` in `packages/session-ui/component-tests/read-image.spec.ts:20`, external URLs like favicons in `packages/session-ui/component-tests/markdown.spec.ts:217`).

## Fixtures imported by URL

Use when contracts invisible in story (init counts, unmount races, cache state).

- **Fixture file**: Put `*.fixture.tsx` in `component-tests/` or beside source (`packages/gui-plugins/src/browser/panel.fixture.tsx`). Export `mountX()` rendering into host with `data-testid` (`packages/session-ui/component-tests/basic-tool.fixture.tsx:7-46`). Never suffix with `.spec` or `.test`.
- **Mount procedure**:
  1. Mount light story (loads app styles).
  2. Import fixture + exec in `page.evaluate`.
  3. Locate via `page.getByTestId` (`packages/session-ui/component-tests/basic-tool.spec.ts:30-36`).
  Rendered outside frame decorators → must provide own providers (`packages/app/component-tests/browser-pane-restore.spec.ts:69-83`).
- **Module URLs**: Build via `sourceURL(new URL("<relative path with extension>", import.meta.url))` (`story.ts:10`) as string literal in spec (`browser-pane-restore.spec.ts:6-24`). Other patterns fail or load duplicate module instance missing page ctx (manual `/@fs//...` creates duplicate instance; `story.ts:6-9`). Literal required for pre-bundle scanner.
- **Aliases**: URL import loads real file. App code reaching same module via `vite.config.ts` alias loads mock (`browser-pane-restore.spec.ts:95-96`).
- **Spec imports**: Import source modules into spec with `import type` only (`browser-pane-restore.spec.ts:2-4`). Value imports exec browser code in Node runner.
- **Async ordering**: Control flow via fixture deferreds (`mountPluginHost`, `packages/app/component-tests/plugin-host.fixture.tsx:151`). Await resulting state (`plugin-host.spec.ts:38-69`) or poll state via `until` (`plugin-host.fixture.tsx:141-148`). Do not use fixed in-page `setTimeout` waits.

## Vite pre-bundling and reloads

`packages/stories/vite.config.ts` defines `optimizeDeps.entries`: `*.stories.tsx` and `*.worker.ts` under four `src/` trees, spec module literals (`./` or `../` ending `.ts`/`.tsx`), frame `index.html`. Vite pre-bundles bare imports before first page loads. Missed dep discovered on import → Vite logs `✨ optimized dependencies changed. reloading` → emits `full-reload` path `*` to all workers → stale `?v=` hashes fail with 504 "Outdated Optimize Dep".

- **Bar = 0 reloads**: Cold run must log neither `new dependencies optimized` nor `optimized dependencies changed`.
- **Scanner reachability**: Runtime paths, template literals, extensionless paths, specs not matching `*.spec.ts` skipped. Stories MUST match `*.stories.tsx`. Workers MUST match `*.worker.ts` (scanner ignores `new Worker(new URL(…))`). Use `optimizeDeps.include` only for un-scannable deps (`DEBUG=vite:deps` shows scan/discovery detail).
- **Symptoms**: `page.evaluate: Execution context was destroyed`, `Failed to fetch dynamically imported module …/@fs/…`, missing fixture state immediately post-`mount`.
- **Survival**: Only `mount()` survives reload (re-navigates). Reload destroys post-mount state: `page.evaluate` imports, mounted fixtures, click state, locator refs.
- **Fix in scan**: Never mask reloads via retries, timeouts, or import order tricks.
- **Clear cache to verify**: `getConfigHash` excludes `entries`; valid `_metadata.json` skips scan. Cold test check: `rm -rf packages/stories/node_modules/.vite`.
- **Package resolution**: Dedupe via pkg resolution in `vite.config.ts`, not hard paths to `node_modules` (e.g. `@tanstack/solid-query` deduped without `app/node_modules` path aliases).

## Cold vs warm, and mount cost

- **CI always cold**: Fresh runner per leg (`check-test.yml:239-240`) → cold story server + full scan.
- **Ignore first test**: First test per worker takes 5.7-7.0s (Linux), 14-15s (Windows). Warm tests median 1.5s (app) / 2.0s (session-ui) on Linux, 2.4-2.6s on Windows. Warm `mount` median 1.0s (app) / 1.5s (session-ui) on Linux, 1.7-1.9s on Windows. Evaluate perf on warm runs.
- **Local port reuse**: Playwright reuses existing port listener (`config.ts:20`; default 6006, `config.ts:3`), masking cold costs/reloads or cross-contaminating across worktrees. Override via `PLAYWRIGHT_STORIES_PORT` or `PLAYWRIGHT_STORIES_URL` (`config.ts:3-4`). Windows: use port < 49152 (avoid Hyper-V/WSL dynamic range). Multiple servers in same checkout collide on `packages/stories/node_modules/.vite` → use distinct worktrees.
- **Minimize mounts**: Single scenario per test; resize via `page.setViewportSize` (`composer.spec.ts:28-29`) instead of re-mounting. Video records on retry 1 in CI; local keeps `retain-on-failure` (`config.ts:27-30`).

## Mobile, touch and drawers

- **Touch emulation**: Inside `story.describe`, call `story.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })` (`packages/session-ui/component-tests/session-timeline-mobile.spec.ts:3-4`). Test-scoped → workers preserved. Verify emulation via `matchMedia("(hover: none)")` (`composer.spec.ts:244`); trigger actions with `tap()` or `page.touchscreen.tap` (`session-timeline-mobile.spec.ts:41-42`).
- **No `launchOptions`**: Worker-scoped → breaks parallelization.
- **Drawers**: Viewport < 768px renders pickers in bottom drawer (`composer.spec.ts:100-107`).
  - `@corvu/drawer@0.2.4` patch in root `package.json` (`patchedDependencies`) fixes close-on-open frame lock (trapped focus, `pointer-events: none`).
  - `composer.spec.ts:375-429` tests dismiss behavior before/during `data-opening`.
  - Wait until drawer fully in viewport without `data-transitioning` before measuring/screenshotting (`packages/app/e2e/regression/mobile-model-pickers.spec.ts:25-26`).
  - Stuck overlays = product bugs; fix in product, do not wait out.

## Geometry, platforms, known failures

- **Fonts**: Inter `@font-face` lacks `font-display` (`packages/app/src/index.css:13-18`) → layout shifts on fallback swap. Run `await page.evaluate(() => document.fonts.ready.then(() => undefined))` before measuring (`markdown.spec.ts:247`).
- **Page scroll**: Non-fullscreen wrapper = `calc(100vh - 2rem)` for 1rem padding (`packages/stories/src/frame.tsx`). Never set story root to `100vh` (forces 32px scroll, shifts layout coords). Measure relative to co-captured container or set `parameters: { layout: "fullscreen" }`.
- **Shortcuts**: Use `ControlOrMeta+…` (`browser-pane-restore.spec.ts:134`). Read labels via `navigator.platform` (`packages/app/component-tests/session-question-dock.spec.ts:121`).
- **Known failure**: macOS fails `browser-pane-restore.spec.ts:123` after `ControlOrMeta+w` (Meta+W, `:134-135`); passes CI (Control+W). Expected OS diff.
- **`story.fail`**: Consumes full 10s expect timeout (`packages/session-ui/component-tests/file-tool.spec.ts:49-50`). Fix product or check explicit terminal condition.

## Before push checklist

Run from package dir (`packages/session-ui` or `packages/app`):

1. **Worker repetition**: Verify zero flakes at CI worker level (`config.ts:14` sets 0 retries locally):
   ```sh
   bun run test:components -- component-tests/<file>.spec.ts --workers=2 --repeat-each=10
   ```
2. **Review duration**: Inspect `bunx playwright show-report component-tests/playwright-report`. Compare warm durations against CI medians.
3. **Throttling test**: Test layout races under CPU load:
   ```ts
   const cdp = await page.context().newCDPSession(page)
   await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
   ```
4. **Cold run verification**: Test after adding stories, fixtures, deps, workers, lazy imports, or editing `packages/stories`. Run from repo root:
   ```sh
   rm -rf packages/stories/node_modules/.vite
   PLAYWRIGHT_STORIES_PORT=6216 bun run --cwd packages/app test:components -- --workers=2 2>&1 | tee /tmp/app-components.log
   grep -E "new dependencies optimized|optimized dependencies changed" /tmp/app-components.log
   ```
   `grep` output must be empty.
5. **Windows validation**: Test platform keys, labels, font geometry. Do not increase timeouts/retries in `config.ts`. For heavy work, set `story.setTimeout(...)` with explanatory comment.
6. **Verify CI legs**: E2E skips push to dev (`check-test.yml:28`). Gate watches `@opencode/app`, `@opencode/stories` (`check-test.yml:60-61`). Verify execution of `e2e (<os>, session-ui-components)` and `e2e (<os>, app-components)`. If skipped in CI, include local cold run proof in PR.

## Debugging CI flakes

- **Download artifact**:
  ```sh
  gh run download <run-id> -n playwright-<linux|windows>-<session-ui|app>-components-<attempt> -D <dir>
  ```
  Check `<dir>/session-ui/component-tests/` or `<dir>/app/component-tests/`. Retry 1 contains trace and video in `test-results/<test>-components-retry1/`.
- **Identify reloads**: Check job log for `[WebServer]` output matching `optimized dependencies changed`. Trace evidence:
  - Repeated frame nav (`/?id=…`) + repeated `[vite] connecting...`
  - Changed dep `?v=` hashes across network reqs
  - 504 "Outdated Optimize Dep" on `deps/*.js`
