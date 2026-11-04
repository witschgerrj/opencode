---
name: opencode-themes
description: Configure, author, debug OpenCode V2 terminal TUI themes, appearance
  modes, base token trees, hue scales in cli.json and theme JSON files.
---

# OpenCode Terminal Themes and Token Architecture

OpenCode V2 terminal themes style full-screen TUI client (`opencode`): palettes, interactive states, diffs, source syntax, Markdown elements, raised panels, contextual dialogs.

## Boundaries with Neighbor Skills

- **Per-agent hex badge colors (`agents.<id>.color`)**: Use `opencode-agents`.
- **TUI-only plugins in `cli.json`**: Use `opencode-plugins`.
- **Server/project runtime config (`opencode.json(c)`)**: Use `opencode-models`, `opencode-providers`, or `opencode-instructions`.

## Core Workflow

1. **Configure theme selection and mode in `cli.json`**:
   - Interactive selection: `Ctrl+P` → **Open settings** → **Theme**.
   - Declarative config: `~/.config/opencode/cli.json` (or `$XDG_CONFIG_HOME/opencode/cli.json`, override via `OPENCODE_CLI_CONFIG_CONTENT`).
   - Set config:
     ```json
     "theme": { "name": "<theme-name>", "mode": "system" | "dark" | "light" }
     ```
   - Target options: 33 built-in named themes, `"system"` (terminal palette reporting req; truecolor renders exact), or custom JSON stem.
2. **Scaffold and place custom V2 theme files**:
   - Store paths: global `~/.config/opencode/themes/<name>.json`, project `.opencode/themes/<name>.json` (project dir overrides parent/global).
   - Generate initial file via built-in `theme` scaffold tool before edit.
   - Read `references/theme-schema.md` before editing theme JSON.
3. **Customize hues, states, surfaces, `@dialog` overrides**:
   - Override hue aliases (`accent`, `interactive`, `neutral`) in `light.hue` or `dark.hue` → rethemes color family.
   - Override specific token groups: `text`, `background`, `border`, `scrollbar`, `diff`, `syntax`, `markdown`, `background.raised`, `@dialog`.

## Critical Invariants and Gotchas

- **Themes belong in `cli.json`, never `opencode.json(c)`**: Terminal client owns `~/.config/opencode/cli.json`; background server ignores it. V2 replaces V1 layered `tui.json(c)` with single global `cli.json` (auto-migrates global `tui.json` once if `cli.json` absent; project-local `tui.json` ignored in V2).
- **Self-contained `base` inheritance only**: Theme JSON must declare complete `base` token tree + min 1 mode (`light` or `dark`). Modes inherit **only** from same file `base`—never built-in default or sibling mode. Missing `base` tree fails validation.
- **Single-mode fallback**: Theme defines only `dark` (or `light`) → engine falls back to available mode when `cli.json` reqs opposite.
- **Contrast-inverted 100-900 hue steps**: Step numbers define contrast against mode background:
  - **Light mode**: `100` = darkest, `900` = lightest.
  - **Dark mode**: `100` = lightest, `900` = darkest.
- **`base.categorical` must be non-empty**: Defines ordered base hues/aliases for agent badges/repeated UI items; `[]` invalid in V2.
- **`.json` extension strictly required**: Engine discovers `.json` files only (no `.jsonc`). Filename stem becomes `theme.name`.
