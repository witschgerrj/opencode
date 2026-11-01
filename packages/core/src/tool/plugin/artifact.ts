export * as ArtifactTool from "./artifact.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import fs from "fs"
import path from "path"
import { Location } from "../../location.js"
import { Permission } from "../../permission.js"
import { FileAccess } from "../../file-access.js"
import { optional } from "../../schema.js"

export const name = "render_artifact"

export const MAX_ARTIFACT_BYTES = 256 * 1024 // 256 KB
export const MAX_DELIVERABLE_BYTES = 24 * 1024 * 1024 // 24 MiB

const DELIVERABLE_MIMES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
}

export function detectDeliverableMime(filename: string): string | undefined {
  const ext = path.extname(filename).toLowerCase()
  return DELIVERABLE_MIMES[ext]
}

const KindSchema = Schema.Literals(["html", "svg", "mermaid", "markdown"])
export type Kind = typeof KindSchema.Type

export const Input = Schema.Struct({
  kind: KindSchema.annotate({
    description: "Type of visual artifact: 'html' (interactive UI/app), 'svg' (vector graphic), 'mermaid' (diagram), or 'markdown' (formatted document).",
  }).pipe(optional),
  type: KindSchema.annotate({
    description: "Alias for 'kind'.",
  }).pipe(optional),
  title: Schema.String.annotate({
    description: "Descriptive title for the artifact.",
  }),
  content: Schema.String.annotate({
    description: "Content of the artifact (HTML, SVG, Mermaid syntax, or Markdown; max 256KB).",
  }).pipe(optional),
  summary: Schema.String.annotate({
    description: "Short 1-2 sentence description of what the interactive artifact visualizes or enables.",
  }).pipe(optional),
  saveToPath: Schema.Boolean.annotate({
    description: "Whether to persist a durable copy under .opencode/artifacts/ in the project directory (default: false, stays virtual in session metadata).",
  }).pipe(optional),
  files: Schema.Array(Schema.String).annotate({
    description:
      "Optional list of deliverable file paths (e.g. .mp4, .webm, .gif, .png, max 24 MiB each) to attach for inline playback & download.",
  }).pipe(optional),
})
export type Input = typeof Input.Type

export const ArtifactPayload = Schema.Struct({
  id: Schema.String,
  kind: KindSchema,
  title: Schema.String,
  summary: Schema.String,
  content: Schema.String,
  path: Schema.String.pipe(optional),
  files: Schema.Array(Schema.String).pipe(optional),
})
export type ArtifactPayload = typeof ArtifactPayload.Type

export const Output = ArtifactPayload
export type Output = typeof Output.Type

export function sanitizeArtifactContent(content: string, kind: Kind): string {
  if (kind === "html" || kind === "svg") {
    // Strip automatic refresh / redirect meta tags to protect the parent iframe container
    return content.replace(/<\s*meta[^>]+http-equiv\s*=\s*['"]?refresh['"]?[^>]*>/gi, "")
  }
  return content
}

function getFileExtension(kind: Kind): string {
  switch (kind) {
    case "html":
      return ".html"
    case "svg":
      return ".svg"
    case "mermaid":
      return ".mmd"
    case "markdown":
      return ".md"
  }
}

export const Plugin = {
  id: "opencode.tool.artifact",
  effect: Effect.fn("ArtifactTool.Plugin")(function* (ctx: Context) {
    const permission = yield* Permission.Service
    const location = yield* Location.Service
    const access = yield* FileAccess.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description:
            "Render interactive HTML, SVG charts/graphics, Mermaid diagrams, or rich Markdown artifacts into the user interface. Artifacts are safely sandboxed and emitted in structured metadata.",
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const hasFiles = input.files !== undefined && input.files.length > 0
              const kind = input.kind ?? input.type ?? (hasFiles ? "markdown" : undefined)
              if (!kind) {
                return yield* new ToolFailure({
                  message: "Artifact 'kind' (or 'type') must be one of: 'html', 'svg', 'mermaid', 'markdown'",
                })
              }

              if (!input.title || input.title.trim().length === 0) {
                return yield* new ToolFailure({ message: "Artifact 'title' must not be empty" })
              }

              const rawContent = input.content ?? ""
              if (!hasFiles && rawContent.trim().length === 0) {
                return yield* new ToolFailure({ message: "Artifact 'content' must not be empty" })
              }

              const byteLength = Buffer.byteLength(rawContent, "utf8")
              if (byteLength > MAX_ARTIFACT_BYTES) {
                return yield* new ToolFailure({
                  message: `Artifact content too large (${byteLength} bytes exceeds ${MAX_ARTIFACT_BYTES} byte limit)`,
                })
              }

              const source = { type: "tool" as const, messageID: context.messageID, id: context.id }
              yield* permission.assert({
                action: name,
                resources: [kind],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })

              type ContentPart =
                | { type: "text"; text: string }
                | { type: "file"; uri: string; mime: string; name: string }

              const attachedContent: ContentPart[] = []
              const attachedFilePaths: string[] = []

              if (hasFiles) {
                for (const filePath of input.files!) {
                  const mime = detectDeliverableMime(filePath)
                  if (!mime) {
                    return yield* new ToolFailure({
                      message: `Unsupported deliverable file type for "${filePath}". Supported: .png, .jpeg, .jpg, .gif, .webp, .mp4, .webm`,
                    })
                  }

                  const target = yield* access.authorizeRead(filePath, context).pipe(
                    Effect.mapError(
                      (err) =>
                        new ToolFailure({
                          message: `Failed to authorize deliverable file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
                          error: err,
                        }),
                    ),
                  )

                  const fileBuf = yield* Effect.tryPromise({
                    try: async () => {
                      const stat = await fs.promises.stat(target.absolute)
                      if (stat.size > MAX_DELIVERABLE_BYTES) {
                        throw new Error(
                          `File size (${stat.size} bytes) exceeds maximum deliverable limit of 24 MiB (${MAX_DELIVERABLE_BYTES} bytes)`,
                        )
                      }
                      return await fs.promises.readFile(target.absolute)
                    },
                    catch: (err) =>
                      new ToolFailure({
                        message: `Failed to read deliverable file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
                        error: err,
                      }),
                  })

                  const fileName = path.basename(target.absolute)
                  attachedFilePaths.push(target.absolute)
                  attachedContent.push({
                    type: "file",
                    uri: `data:${mime};base64,${fileBuf.toString("base64")}`,
                    mime,
                    name: fileName,
                  })
                }
              }

              const sanitized = sanitizeArtifactContent(rawContent, kind)
              const id = `art_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
              let savedPath: string | undefined

              if (input.saveToPath) {
                const artifactsDir = path.join(location.directory, ".opencode", "artifacts")
                yield* Effect.tryPromise({
                  try: async () => {
                    await fs.promises.mkdir(artifactsDir, { recursive: true })
                    const ext = getFileExtension(kind)
                    const filePath = path.join(artifactsDir, `${id}${ext}`)
                    await fs.promises.writeFile(filePath, sanitized, "utf8")
                    savedPath = filePath
                  },
                  catch: (err) =>
                    new ToolFailure({
                      message: `Failed to save artifact to disk: ${err instanceof Error ? err.message : String(err)}`,
                    }),
                })
              }

              const payload: Output = {
                id,
                kind,
                title: input.title.trim(),
                summary: (input.summary ?? "").trim(),
                content: sanitized,
                ...(savedPath ? { path: savedPath } : {}),
                ...(attachedFilePaths.length > 0 ? { files: attachedFilePaths } : {}),
              }

              const markdownSummary = [
                `### Rendered ${kind.toUpperCase()} Artifact: ${payload.title}`,
                ...(payload.summary ? [`> ${payload.summary}\n`] : []),
                `- **ID**: \`${id}\``,
                `- **Kind**: \`${kind}\``,
                `- **Size**: ${byteLength} bytes`,
                ...(savedPath ? [`- **Saved to**: \`${savedPath}\``] : []),
                ...(attachedFilePaths.length > 0
                  ? [`- **Attached Deliverables**: ${attachedFilePaths.map((p) => `\`${path.basename(p)}\``).join(", ")}`]
                  : []),
                kind === "mermaid" && payload.content
                  ? `\n\`\`\`mermaid\n${payload.content}\n\`\`\``
                  : kind === "svg" && payload.content
                    ? `\n\`\`\`xml\n${payload.content.slice(0, 300)}...\n\`\`\``
                    : "",
              ]
                .filter(Boolean)
                .join("\n")

              const content: ContentPart[] = [{ type: "text", text: markdownSummary }, ...attachedContent]

              return {
                output: payload,
                content,
                metadata: {
                  artifact: payload,
                },
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({
                      message: `Render artifact failed: ${error instanceof Error ? error.message : String(error)}`,
                      error,
                    }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)


  }),
}
