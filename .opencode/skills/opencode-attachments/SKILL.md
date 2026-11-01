---
name: opencode-attachments
description: "Configure and construct OpenCode V2 prompt and command file attachments (`file://` and `data:` URIs, 1-based `?start=&end=` line spans, magic-byte sniffing, 20 MiB caps, supported text/SVG/image/PDF formats, and `media.image` auto-resize settings). Use for user input attachments and image normalization; use `opencode-messages-parts` for downloading tool output media and `opencode-references` for named external directory aliases."
---

# OpenCode Attachments

Attachments inject local files, line ranges, directory listings, images, or PDFs directly into an OpenCode V2 user prompt or slash command, and share `media.image` normalization rules with the built-in `read` tool.

## Scope and Neighbor Boundaries

- **This skill owns**: Prompt/command attachment input objects (`uri`, `name`, `description`, `mention`), `file://` URIs (including `?start=&end=` line spans and immediate directory listings), inline Base64 `data:` URIs, 20 MiB item/picker caps, raw magic-byte format detection, model modality fallback notes, and `media.image` configuration (`auto_resize`, `max_width`, `max_height`, `max_base64_bytes`).
- **Use sibling skills for**:
  - `` `opencode-messages-parts` `` — rendering transcript parts and retrieving **output** media produced by tools (`experimental.media.get` / `media:<sha256>`).
  - `` `opencode-references` `` — named external directory/Git aliases (`references` config).
  - `` `opencode-tools` `` — `read` tool text paging and `webfetch` for HTTP/HTTPS URLs.
  - `` `opencode-models` `` / `` `opencode-providers` `` — declaring model image/PDF input modality support.

Read [attachment formats, limits, and image processing](references/attachment-formats-and-media.md) for complete URI syntax, format matrices, and resize pipeline details.

## Core Workflow

1. **Construct valid V2 attachment descriptors** (on `session.prompt` or `session.command` `files` arrays):
   - **Server-accessible file or directory (`file:` URI)**:
     ```json
     {
       "uri": "file:///abs/path/to/project/src/server.ts?start=20&end=60",
       "name": "server.ts",
       "description": "HTTP server entrypoint"
     }
     ```
     Use positive 1-based `start` and `end` query parameters (`?start=20&end=60`) on text `file:` URIs to slice line ranges.
   - **Inline payload (`data:` Base64 URI)**:
     ```json
     {
       "uri": "data:text/plain;base64,SGVsbG8sIE9wZW5Db2RlIQ==",
       "name": "greeting.txt"
     }
     ```
   - **Never pass `http://` or `https://` URLs** as attachments—OpenCode rejects them before admitting the prompt.
2. **Match attachment formats to active model modalities**:
   - **Always visible (even on text-only models)**: UTF-8 text files, **SVG** files (decoded as text), and directory `file://` URIs (non-recursive immediate listing).
   - **Multimodal-dependent**: `PNG`, `JPEG`, `GIF`, `WebP` (require image-capable model) and `PDF` (requires PDF-capable model). When the active model lacks that input modality, OpenCode substitutes a short fallback note—unless custom model config misdeclared image support, in which case the upstream text-only provider may reject the request!
3. **Configure `media.image` normalization (`opencode.jsonc`)** (applies to both prompt attachments and `read` tool image reads):
   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "media": {
       "image": {
         "auto_resize": true,
         "max_width": 2000,
         "max_height": 2000,
         "max_base64_bytes": 5242880
       }
     }
   }
   ```

## Key Invariants and Gotchas

- **Pre-admission validation & 20 MiB caps**:
  - OpenCode reads every attachment **before** admitting the prompt, rejecting invalid URLs, unreadable paths, special device/socket nodes, and any item over **20 MiB decoded** (two 12 MiB items pass per-item admission).
  - The Desktop file picker enforces a **20 MiB combined total** per selection (two 12 MiB files exceed picker selection). Custom client uploaders should cap decoded file sizes at `<= 20 MiB` so accepted uploads do not fail at prompt admission.
- **Magic-byte sniffing defeats extension/MIME spoofing**: OpenCode detects media type from raw byte headers. Renaming a binary to `.txt` or changing a `data:` MIME header will not expose unsupported binaries (`AVIF`, `BMP`, audio, video, executables); convert `BMP`/`AVIF` to `PNG`/`JPEG` or binaries to UTF-8 text first.
- **Line-range URI syntax trap**: V2 `file:` URIs select line spans with query parameters (`?start=20&end=60`), not `#L20-L60` URL hash fragments used in Markdown links.
- **`auto_resize` can mutate output MIME type**: When `auto_resize: true` (default), OpenCode scales oversized images down preserving aspect ratio and tries progressively smaller `PNG` and `JPEG` encodings to fit `max_base64_bytes`—so an oversized `WebP` or `GIF` can become `PNG` or `JPEG`. When `auto_resize: false`, any image exceeding any bound fails immediately.
- **`max_base64_bytes` excludes the `data:` prefix**: Only the Base64-encoded payload characters count toward `max_base64_bytes` (e.g., `SGVsbG8=` counts as 8 bytes).
- **Not a security boundary**: If the host image resizer is unavailable, OpenCode passes oversized images through unchanged, and upstream providers still enforce their own dimension, count, and byte limits after OpenCode processing.
