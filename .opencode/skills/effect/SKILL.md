---
name: effect
description: Build Effect v4 TypeScript services schemas workflows tests
---

# Effect

Codebase uses Effect for typed composable TS services, schemas, workflows.

## Source Of Truth

Use current Effect v4 source; no memory / old v2/v3 examples.

1. `.opencode/references/effect` missing → clone `https://github.com/Effect-TS/effect` there (run in project repo root, not skill dir).
2. Search `.opencode/references/effect` for exact APIs, examples, tests, naming patterns before answering or writing Effect code.
3. Inspect repo code for local house style before adding patterns.
4. Back implementations with source files or nearby repo examples.

## Guidelines

- Current Effect v4 APIs + local patterns > external posts, examples, guesses.
- Multi-step workflows → `Effect.gen(function* () { ... })`.
- Reusable service methods / workflows → `Effect.fn("Name")` or `Effect.fnUntraced(...)`.
- API / domain shapes → Effect `Schema`. IDs → branded schemas. Typed domain errors → `Schema.TaggedErrorClass`.
- Thin HTTP handlers: decode input → read req ctx → call services → map transport errs. Business rules belong in services.
- Prefer Effect platform abstractions + deps over ad hoc promises where code already uses them.
- Explicit layer composition: avoid broad hidden provisioning hiding missing deps.
- Tests → prefer repo Effect test helpers + live tests for FS, git, child proc, locks, timing.
- Ban `any`, non-null assertions, unchecked casts, legacy Effect APIs.
- Never answer from memory; verify against `.opencode/references/effect` or nearby code first.

## Testing Patterns

- Effect services, layers, runtime ctx, scoped resources, platform integrations → use `testEffect(...)` from `packages/core/test/lib/effect.ts`.
- FS, git repos, HTTP servers, sockets, child procs, locks, real time, live platform behavior → use `it.live(...)`.
- Exec tests from pkg dirs (`packages/core`); never run pkg tests from repo root.
- Explicit test layers > ad hoc managed runtimes; keep dep provisioning visible in test file.
- Clean up resources via scoped fixtures + finalizers: temp dirs, flags, DBs, fibers, servers, global state.
