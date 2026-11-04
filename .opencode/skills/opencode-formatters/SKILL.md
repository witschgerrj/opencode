---
name: opencode-formatters
description: Configure debug OpenCode V2 post-edit formatters built-in detection inheritance
  custom command argv `$FILE` extension match.
---

# OpenCode Formatters

OpenCode auto-runs code formatters on files modified by built-in `write`, `edit`, `patch` tools. Post-edit formatting disabled by default; enable via `opencode.json` or `opencode.jsonc`.

## Scope and Neighbor Boundaries

- **Skill owns**: `formatter` config (`true`, `false`, `{}`), built-in prerequisites/overrides, custom definitions (`command`, `extensions`, `environment`, `disabled`), `$FILE` expansion, extension matching, fallback exec order.
- **Sibling skills**:
  - `opencode-tools` — `write`, `edit`, `patch`, `shell` tool contracts.
  - `opencode-snapshots` — per-step Git snapshots, undo/revert (captures post-edit rewrites).
  - `opencode-session-lifecycle` — `opencode.json(c)` discovery, precedence tiers.

Read `references/builtins-and-matching.md` for complete built-in catalog, project detection rules, schema spec.

## Core Configuration Workflow

1. **Top-level enablement form**:
   - `"formatter": true` — enable all built-in formatters; **reset** inherited overrides/custom entries from lower-precedence configs back to stock built-ins.
   - `"formatter": {}` — enable built-in formatters; **preserve** inherited custom entries/overrides from lower-precedence configs.
   - `"formatter": false` — disable all post-edit formatting; override lower-precedence configs.
2. **Customize built-in or register custom formatter**:
   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "formatter": {
       "prettier": {
         "disabled": true
       },
       "ruff": {
         "environment": { "RUFF_CACHE_DIR": ".cache/ruff" }
       },
       "deno-markdown": {
         "command": ["deno", "fmt", "$FILE"],
         "extensions": [".md"]
       }
     }
   }
   ```
   - **Built-in overrides**: Fields (`disabled`, `command`, `environment`, `extensions`) optional; omitted fields inherit from built-in spec.
   - **New custom formatters**: Require **both** `command` (non-empty `string[]`) and `extensions` (`string[]` with leading dots, e.g. `[".gd"]`); else never run.
3. **Verify binary and project prerequisites**:
   - OpenCode runs built-in formatter only when binary on server proc `PATH` **and** project marker req met (`prettier` in `package.json`, `biome.json(c)`, `.clang-format`, `.ocamlformat`, `laravel/pint` in `composer.json`).

## Key Invariants and Gotchas

- **`true` wipes lower-precedence custom formatters**: `"formatter": true` in system/inner project config resets custom formatters from global/outer configs. Use `"formatter": {}` (or override obj) when layering.
- **No shell parser (`command` is `string[]`)**: OpenCode spawns `command[0]` directly with array elements as literal args from active project root dir. Pipes (`|`), redirections (`>`), globs (`*`), `&&`, shell quotes do not work without explicit shell exec.
- **`$FILE` is absolute path**: `"$FILE"` in `command` replaced with modified file absolute path; `environment` merges onto OpenCode inherited env.
- **Case-sensitive final extension only**:
  - OpenCode extracts only final extension; compares case-sensitively against `extensions`.
  - Compound extensions (`".part.md"`, `".test.ts"`) **never match** `notes.part.md`, `app.test.ts` (final extensions `".md"`, `".ts"`). Uppercase extensions (`".C"`, `".R"`) match only if explicitly listed.
- **Built-in-then-custom fallback order**: Multiple matching formatters → try built-ins first (built-in reg order) → custom entries (JSON key order). Stop at first command exit `0`; non-zero exit logs err → falls through to next match.
- **`shell` edits bypass formatters**: Only `write`, `edit`, `patch` trigger formatters; files mutated via `shell` commands untouched.
- **Offline & service `PATH` traps**: Avoid `npx`/`bunx` fetching pkg on demand in offline/air-gapped env; ensure binaries reside on OpenCode daemon `PATH` (restricted service envs often omit `~/.local/bin`, `~/.cargo/bin`).
