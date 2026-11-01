---
name: opencode-themes
description: Select, customize, and author OpenCode V2 terminal UI themes and appearance modes in cli.json and custom JSON theme files. Use for TUI theme selection, light/dark/system modes, base token trees, contrast-inverted hue scales, categorical agent hues, and dialog surfaces; use opencode-agents for per-agent hex badge colors.
---

# OpenCode Terminal Themes and Token Architecture

OpenCode V2 terminal themes style the full-screen TUI client (`opencode`), covering palettes, interactive states, diffs, source syntax, Markdown elements, raised panels, and contextual dialogs.

## Boundaries with Neighbor Skills

- **Per-agent six-digit hex badge colors (`agents.<id>.color`)**: Use `opencode-agents`.
- **TUI-only plugins declared in `cli.json`**: Use `opencode-plugins`.
- **Server and project runtime configuration (`opencode.json(c)`)**: Use `opencode-models`, `opencode-providers`, or `opencode-instructions`.

## Core Workflow

1. **Configure theme selection and appearance mode in `cli.json`**:
   - Select themes interactively in the TUI via `Ctrl+P` -> **Open settings** -> **Theme**, or declaratively in `~/.config/opencode/cli.json` (or `$XDG_CONFIG_HOME/opencode/cli.json`, overridable per process via `OPENCODE_CLI_CONFIG_CONTENT`).
   - Set `"theme": { "name": "<theme-name>", "mode": "system" | "dark" | "light" }`.
   - Use any of the 33 built-in named themes, `"system"` (when the terminal supports palette color reporting; truecolor terminals render exact colors), or a custom JSON theme stem.
2. **Scaffold and place custom V2 theme files**:
   - Store custom `.json` theme files globally in `~/.config/opencode/themes/<name>.json` or per project in `.opencode/themes/<name>.json` (closer project directories override parent or global themes with the same filename stem).
   - Always generate a complete starting file using OpenCode's built-in `theme` scaffold tool before customizing tokens.
   - Read [CLI settings, built-in catalog, hue scales, and complete token schema](references/theme-schema.md) before editing theme JSON.
3. **Customize hues, states, surfaces, and `@dialog` overrides**:
   - Override hue aliases (`accent`, `interactive`, `neutral`) in `light.hue` or `dark.hue` to retheme entire color families at once, or override individual token groups (`text`, `background`, `border`, `scrollbar`, `diff`, `syntax`, `markdown`, `background.raised`, `@dialog`).

## Critical Invariants and Gotchas

- **Themes belong in `cli.json`, never `opencode.json(c)`**: The terminal client owns `~/.config/opencode/cli.json`; the background OpenCode server ignores it. V2 replaces V1's layered `tui.json(c)` files with one global `cli.json` (auto-migrating global `tui.json` once when `cli.json` is absent; project-local `tui.json` files are not used in V2).
- **Self-contained `base` inheritance only**: Every V2 theme JSON file must declare one complete `base` token tree plus at least one `light` or `dark` hue palette. Modes inherit **only** from that same file's `base`—never from OpenCode's built-in default theme or from the sibling mode. Partial JSON snippets without a complete `base` tree fail validation.
- **Single-mode fallback**: If a custom theme defines only `dark` (or only `light`), OpenCode automatically uses that available mode even when `cli.json` requests the opposite mode.
- **Contrast-inverted 100-900 hue steps**: Step numbers follow contrast against the active mode's background—in **light** themes `100` is darkest and `900` is lightest, whereas in **dark** themes `100` is lightest and `900` is darkest.
- **`base.categorical` must be non-empty**: `categorical` defines the ordered base hues or aliases used to distinguish active agents and repeated UI items; an empty array `[]` is invalid in V2.
- **`.json` extension strictly required**: Theme discovery reads `.json` files only (not `.jsonc`); the filename without `.json` becomes the selectable `theme.name`.
