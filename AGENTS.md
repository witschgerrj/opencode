# OpenCode Repository Instructions (`Caveman Ultra`)

## 1. Architecture, Branch & Generation Rules
- Public Protocol / Server `HttpApi` change → run `bun run generate` from `packages/client` (never edit generated client files directly).
- Runtime dep DAG: `Schema → Core & Protocol → Server`. `Client → Schema & Protocol` (NEVER `Core` or `Server`). `sdk` composes `Client + Core + Server`.
- 0 Changesets (never add `.changeset` files).
- Default branch = `dev` (base branches/worktrees on `origin/dev`, target PRs at `dev`, diff vs `origin/dev`).
- Branch names: $\le 3$ hyphenated words, 0 slashes/type prefixes (`session-recovery`, `fix-scroll-state`, `regenerate-sdk`).
- Commits & PR titles: `type(scope): summary` (`feat|fix|docs|chore|refactor|test`, optional scope `core|opencode|tui|app|desktop|sdk|plugin`).
- User-facing `feat|fix|perf` PRs: include looping animated SVG (`240×72`, `currentColor` + opacity, CSS/SMIL only, `< 8 KB`, 0 scripts/ext refs, good static reduced-motion state) under `### Visual` in PR body.

## 2. Live TUI, Stories, Themes & Desktop Diagnostics
- **Live TUI**: Run `bun run dev:live [dir]` from worktree (discovers server via `opencode service status`, injects `opencode service get password`, uses `dev` storage channel). Prefer `dev:live` over `bun run dev`.
- **Desktop CDP**: `chromium.connectOverCDP(endpoint, { noDefaults: true })` (omitting `noDefaults` flashes light-mode emulation & clobbers focus/media prefs).
- **TUI Stories**: Add fixture story under `packages/tui/src/feature-plugins/system/storybook` + register in `index.tsx`. Render real prod component w/ local-only side effects, keybindings in `StoryFooter` + reset cmd. Run via `OPENCODE_STORY=<id> bun run dev:live` (test narrow & wide widths).
- **TUI Theme Tokens**: Select by semantic role (never raw `theme.hue` or borrowed role). `text.feedback`/`background.feedback` = status feedback; `formfield` = form controls/ordinals/markers; `action` = actions. Extend theme schema/defaults/resolution/types if role missing; verify light, dark, & custom-theme fallback.

## 3. Code Style & Effect Invariants
- Keep logic in 1 fn unless reused or naming a real boundary (`requireConfig`, `readMetadata`).
- Validate unknown inputs once at owning boundary (`Schema.UnknownFromJsonString`, `Schema.decodeUnknownOption`); pass typed values inward without redundant `typeof` checks.
- Explain concrete failure mode, likelihood, & cost before adding complexity for theoretical races/edge cases.
- Avoid `try`/`catch` & `any`. Use Bun APIs (`Bun.file()`). Rely on type inference. Prefer `flatMap/filter/map` w/ type guards over `for` loops.
- `src/config` modules: self-export at top (`export * as ConfigAgent from "./agent.js"`).
- Effect generators: bind services to named vars before calling methods (never `yield* (yield* Foo.Service).bar()`). Keep sync helpers synchronous (don't wrap in `Effect` unless effectful).
- Inline single-use vars (`await Bun.file(path.join(dir, "journal.json")).json()`).
- Prefer dot notation (`obj.a`) over unnecessary destructuring (`const { a } = obj`).
- **Imports**: 0 import aliases (`as`), 0 inline `import("...")` type refs, 0 star imports (`import * as`). Import module's exported namespace (`import { Project } from "@opencode/core/project"` → `Project.ID`). Use dynamic `await import(...)` inside branches for heavy startup-sensitive modules.
- **Variables & Control Flow**: `const` + ternaries/early returns over `let` & `else`.
- **Drizzle SQLite Schemas**: `snake_case` field keys matching column names (`project_id: text().notNull()`).

## 4. Testing & Typecheck
- 0 mocks / `globalThis.*` unless unavoidable; test real impl without duplicating logic.
- Never run tests from repo root (`do-not-run-tests-from-root`); run from pkg dir (`packages/core`).
- Load matching `.opencode/skills` skill before authoring tests: `` `unit-tests` ``, `` `tui-tests` ``, `` `app-e2e-tests` ``, or `` `component-tests` ``.
- **Checks**: Root full check = `bun run check`. Package iteration = `bun typecheck` (or `bun run typecheck:tsc` for `@typescript/native` source of truth; ignore `tsc`-only decl errors `TS5088`/`TS2883` in `bun check`).

## 5. Session Core Invariants
- **Minimal Durable Events**: Record irreducible new facts only; derive state by folding ordered history.
- **Inbox Admission vs Execution**: `Session.prompt(...)` emits `session.inbox.enqueued` (inserts 1 `session_inbox` row) → schedules `SessionExecution.wake(sessionID)` (unless `resume: false`). Delivery emits `session.inbox.delivered` (consumes inbox row + inserts visible message atomically).
- **Idempotency**: Reusing Session ID adopts Session. Reusing user/synthetic inbox item ID w/ matching Session+type is idempotent (first admission wins); cross-Session/cross-type fails.
- **Placement & Scope**: `SessionExecution` = process-global & Session-ID based (`SessionStore` + `LocationServiceMap.get(session.location)` at drain start). `SessionRunner`, model resolution, tools, permissions, & FS = Location-scoped.
- **Step Loop**: 1 step = 1 logical `llm.stream` call continuing from reloaded history (0 in-memory tool loops). Write-ahead execution claim marks busy period for crash/shutdown recovery (released on terminal completion/failure/user interrupt).
- **Delivery Priority**: Prompts `steer` by default. At step boundary: steered compaction → first steered move → remaining steers in enqueue order. At idle boundary: steers first, else 1 queued item. Promoting user input resets agent step allowance.

## 6. 2-Tier Caveman I/O Protocol
- **Internal / Skills / Subagents (`request_synthesis`, `send_message`, `memory`, mid-turn steps)**: **`Caveman Ultra`**.
- **Depth-0 Final User Response Tail**: **`Caveman Full + Team Lead Speaking`**.
