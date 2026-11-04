---
name: opencode-attachments
description: Configure construct OpenCode V2 prompt command file attachments line
  spans magic byte sniffing 20MiB caps media image resize
---

# OpenCode Attachments

Attachments inject local files, line ranges, dir listings, images, PDFs into OpenCode V2 prompt/command. Share `media.image` normalization rules with `read` tool.

## Scope and Neighbor Boundaries

- **Owns**: Prompt/command attachment input objects (`uri`, `name`, `description`, `mention`), `file://` URIs (line spans `?start=&end=`, immediate dir listings), inline Base64 `data:` URIs, 20 MiB item/picker caps, raw magic-byte format detection, model modality fallback notes, `media.image` config (`auto_resize`, `max_width`, `max_height`, `max_base64_bytes`).
- **Sibling skills**:
  - `opencode-messages-parts` — render transcript parts, retrieve output media (`experimental.media.get` / `media:<sha256>`).
  - `opencode-references` — named external dir/Git aliases (`references` config).
  - `opencode-tools` — `read` tool text paging, `webfetch` for HTTP/HTTPS URLs.
  - `opencode-models` / `opencode-providers` — model image/PDF input modality spec.

Read `references/attachment-formats-and-media.md` for URI syntax, format matrices, resize pipeline details.

## Core Workflow

1. **Construct V2 attachment descriptors** (`session.prompt` or `session.command` `files` array):
   - **Server-accessible file/dir (`file:` URI)**:
     ```json
     {
       "uri": "file:///abs/path/to/project/src/server.ts?start=20&end=60",
       "name": "server.ts",
       "description": "HTTP server entrypoint"
     }
     ```
     Use positive 1-based `start`/`end` query params (`?start=20&end=60`) on text `file:` URIs to slice line ranges.
   - **Inline payload (`data:` Base64 URI)**:
     ```json
     {
       "uri": "data:text/plain;base64,SGVsbG8sIE9wZW5Db2RlIQ==",
       "name": "greeting.txt"
     }
     ```
   - **Never pass `http://` or `https://` URLs** as attachments → OpenCode rejects before prompt admission.
2. **Match attachment formats to active model modalities**:
   - **Always visible (text-only models too)**: UTF-8 text, **SVG** (decoded as text), dir `file://` URIs (non-recursive immediate listing).
   - **Multimodal-dependent**: `PNG`, `JPEG`, `GIF`, `WebP` (req image support), `PDF` (req PDF support). Lacking modality → OpenCode substitutes short fallback note. Misdeclared support in custom config → upstream text-only provider rejects req.
3. **Configure `media.image` normalization (`opencode.jsonc`)** (affects prompt attachments and `read` tool):
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
  - OpenCode reads attachments **before** prompt admission. Rejects invalid URLs, unreadable paths, special device/socket nodes, items > **20 MiB decoded** (two 12 MiB items pass per-item admission).
  - Desktop file picker enforces **20 MiB combined total** per selection (two 12 MiB files fail picker). Custom client uploaders must cap decoded sizes `<= 20 MiB`.
- **Magic-byte sniffing defeats extension/MIME spoofing**: Media type detected via raw byte headers. Renaming binary to `.txt` or changing `data:` MIME header fails for unsupported binaries (`AVIF`, `BMP`, audio, video, executables). Convert `BMP`/`AVIF` → `PNG`/`JPEG` or binary → UTF-8 text first.
- **Line-range URI syntax trap**: V2 `file:` URIs select line spans via query params (`?start=20&end=60`), NOT `#L20-L60` Markdown hash fragments.
- **`auto_resize` mutates output MIME type**: `auto_resize: true` (default) → scales down, preserves aspect ratio, iterates smaller `PNG`/`JPEG` encodings to fit `max_base64_bytes`. Oversized `WebP`/`GIF` may become `PNG`/`JPEG`. `auto_resize: false` → any image exceeding bounds errs immediately.
- **`max_base64_bytes` excludes `data:` prefix**: Only Base64 payload chars count (`SGVsbG8=` = 8 bytes).
- **Not security boundary**: Host image resizer unavailable → oversized images pass through unresized. Upstream providers enforce own dimension, count, byte limits downstream.
