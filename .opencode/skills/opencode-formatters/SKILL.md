---
name: opencode-formatters
description: "Configure and debug OpenCode V2 post-edit file formatters (`formatter`), built-in formatter detection, boolean versus empty-object inheritance rules, custom command argv arrays (`$FILE`), and extension matching. Use for automatic formatting after `write`, `edit`, or `patch`; use `opencode-tools` for tool execution and `opencode-session-lifecycle` for general config precedence."
---

# OpenCode Formatters

OpenCode can automatically run code formatters on files modified by its built-in `write`, `edit`, or `patch` tools. Post-edit formatting is **disabled by default** until enabled in `opencode.json` or `opencode.jsonc`.

## Scope and Neighbor Boundaries

- **This skill owns**: `formatter` configuration (`true`, `false`, `{}`), built-in formatter prerequisites and overrides, custom formatter definitions (`command`, `extensions`, `environment`, `disabled`), `$FILE` expansion, extension matching, and fallback execution order.
- **Use sibling skills for**:
  - `` `opencode-tools` `` — `write`, `edit`, `patch`, and `shell` tool contracts.
  - `` `opencode-snapshots` `` — per-step Git snapshots and undo/revert behavior (which capture post-edit formatter rewrites).
  - `` `opencode-session-lifecycle` `` — general `opencode.json(c)` file discovery and precedence tiers.

Read [built-in formatters and matching reference](references/builtins-and-matching.md) for the complete built-in catalog, project detection rules, and schema details.

## Core Configuration Workflow

1. **Choose the right top-level enablement form** (inheritance matters!):
   - `"formatter": true` — enables all built-in formatters **and resets** any inherited formatter overrides or custom formatters from lower-precedence config files back to stock built-ins.
   - `"formatter": {}` — enables built-in formatters **while preserving** inherited custom formatters and overrides from lower-precedence configs.
   - `"formatter": false` — disables all post-edit formatting, overriding lower-precedence configs that enabled it.
2. **Customize a built-in or register a custom formatter**:
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
   - **Built-in overrides**: All fields (`disabled`, `command`, `environment`, `extensions`) are optional; omitted fields inherit from the built-in definition.
   - **New custom formatters**: Must define **both** `command` (non-empty `string[]`) and `extensions` (`string[]` with leading dots, e.g. `[".gd"]`), or they will never run.
3. **Verify binary and project prerequisites**:
   - OpenCode runs a built-in formatter only when its executable is on the OpenCode server process's `PATH` **and** any project-level marker requirement (such as `prettier` in `package.json`, `biome.json(c)`, `.clang-format`, `.ocamlformat`, or `laravel/pint` in `composer.json`) is satisfied.

## Key Invariants and Gotchas

- **`true` wipes lower-precedence custom formatters**: Setting `"formatter": true` in a system or inner project config resets custom formatters defined in global or outer project configs. Use `"formatter": {}` (or an object with specific overrides) when layering configs.
- **No shell parser (`command` is `string[]`)**: OpenCode spawns `command[0]` directly with the remaining array elements as literal arguments from the **active project root directory**. Shell pipes (`|`), redirections (`>`), globs (`*`), `&&`, and shell quoting do not work unless you explicitly invoke a shell executable.
- **`$FILE` is an absolute path**: Every `"$FILE"` element in `command` is replaced with the modified file's full absolute path, and `environment` entries merge onto OpenCode's inherited parent environment.
- **Case-sensitive final extension only**:
  - OpenCode extracts only the file's **final extension** and compares it **case-sensitively** against `extensions`.
  - Compound extensions like `".part.md"` or `".test.ts"` **never match** `notes.part.md` or `app.test.ts` (whose final extensions are `".md"` and `".ts"`). Uppercase extensions like `".C"` or `".R"` only match if explicitly listed.
- **Built-in-then-custom fallback order**: When multiple enabled formatters match an extension, OpenCode tries **built-ins first** (in their fixed built-in registration order), followed by **custom entries** (in JSON object key order). It stops after the **first command that exits `0`**; non-zero exits are logged and fall through to the next matching formatter.
- **`shell` edits bypass formatters**: Only `write`, `edit`, and `patch` trigger formatters; files mutated inside `shell` commands are untouched.
- **Offline & service `PATH` traps**: Avoid `npx`/`bunx` commands that fetch packages on demand in offline/air-gapped environments, and ensure formatter binaries reside on the background OpenCode daemon's `PATH` (restricted service environments often omit `~/.local/bin` or `~/.cargo/bin`).
