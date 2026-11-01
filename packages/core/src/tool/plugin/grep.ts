export * as GrepTool from "./grep.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai/effect"
import { Effect, Schema } from "effect"
import path from "path"
import { Environment } from "../../environment/index.js"
import { FileSystem } from "../../filesystem.js"
import { Location } from "../../location.js"
import { FileAccess } from "../../file-access.js"
import { Permission } from "../../permission.js"
import { Ripgrep } from "../../ripgrep.js"
import { RelativePath } from "../../schema.js"

export const name = "grep"

export const Input = Schema.Struct({
  pattern: Schema.optionalKey(
    FileSystem.GrepInput.fields.pattern
      .check(Schema.isMinLength(1, { message: "Pattern must not be empty" }))
      .annotate({
        description: "Regular expression or literal text to match in file contents.",
      }),
  ),
  queries: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Multiple regex patterns or literal search queries to execute concurrently.",
  }),
  path: Schema.optionalKey(RelativePath).annotate({
    description: "File or directory to search. Defaults to the current working directory.",
  }),
  include: FileSystem.GrepInput.fields.include.annotate({
    description: 'Glob pattern to filter files (for example, "*.js" or "*.{ts,tsx}")',
  }),
  literal: FileSystem.GrepInput.fields.literal.annotate({
    description: "Treat `pattern` as exact text instead of a regular expression (default: false).",
  }),
  caseSensitive: FileSystem.GrepInput.fields.caseSensitive.annotate({
    description: "Use case-sensitive matching (default: true).",
  }),
  limit: FileSystem.GrepInput.fields.limit.annotate({
    description: `Maximum number of matching lines to return (default: ${FileSystem.DEFAULT_SEARCH_LIMIT})`,
  }),
})

export const Output = Schema.Array(FileSystem.Match)
type EncodedOutput = typeof Output.Encoded

/** Format raw search matches into concise model content. */
export const toModelContent = (matches: EncodedOutput, truncated = false, relativeDir?: string) => {
  if (matches.length === 0) return "No matches found"

  const standardLines = [`Found ${matches.length} matches`]
  let current = ""
  for (const match of matches) {
    if (current !== match.entry.path) {
      if (current) standardLines.push("")
      current = match.entry.path
      standardLines.push(`${match.entry.path}:`)
    }
    standardLines.push(`  Line ${match.line}: ${match.text}`)
  }
  if (truncated)
    standardLines.push(
      "",
      `(Results are truncated: showing first ${matches.length} results. Consider using a more specific path or pattern.)`,
    )
  const standardOutput = standardLines.join("\n")

  // If output exceeds 6,144 bytes, group matches under ## <relativePath> headers (  L<line>: <text>)
  if (Buffer.byteLength(standardOutput, "utf8") > 6144) {
    const compactLines = [`Found ${matches.length} matches`]
    let activePath = ""
    for (const match of matches) {
      const displayPath = relativeDir ? path.relative(relativeDir, match.entry.path) : match.entry.path
      if (activePath !== displayPath) {
        compactLines.push("", `## ${displayPath}`)
        activePath = displayPath
      }
      compactLines.push(`  L${match.line}: ${match.text}`)
    }
    if (truncated) {
      compactLines.push(
        "",
        `(Results are truncated: showing first ${matches.length} results. Consider using a more specific path or pattern.)`,
      )
    }
    return compactLines.join("\n")
  }

  return standardOutput
}

/** Grep leaf that defaults its filesystem root to the active Location. */
export const Plugin = {
  id: "opencode.tool.grep",
  effect: Effect.fn("GrepTool.Plugin")(function* (ctx: Context) {
    const environment = yield* Environment.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const access = yield* FileAccess.Service
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description:
            "Search file contents using ripgrep's regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. Supports queries array for concurrent multi-pattern searches. Returns matching file paths, line numbers, and line previews.",
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const patterns = (
                input.queries && input.queries.length > 0
                  ? input.queries
                  : input.pattern
                    ? [input.pattern]
                    : []
              ).filter((p): p is string => typeof p === "string" && p.length > 0)

              if (patterns.length === 0) {
                return yield* new ToolFailure({ message: "Either pattern or queries must be provided" })
              }

              const source = { type: "tool" as const, messageID: context.messageID, id: context.id }
              const target = yield* access.resolve({ path: input.path ?? "." })
              yield* access.authorizeExternal([target], context)
              yield* permission.assert({
                action: name,
                resources: patterns,
                save: ["*"],
                metadata: {
                  root: ".",
                  path: input.path,
                  include: input.include,
                  literal: input.literal,
                  caseSensitive: input.caseSensitive,
                  limit: input.limit,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })
              const root = target.absolute
              const type = yield* Environment.typeFollowing(environment.files, root).pipe(
                Effect.catchTag("Environment.NotFound", () =>
                  Effect.fail(new ToolFailure({ message: `Search path does not exist: ${input.path ?? "."}` })),
                ),
              )
              const cwd = type === "directory" ? root : path.dirname(root)
              const limit = input.limit ?? FileSystem.DEFAULT_SEARCH_LIMIT

              const patternResults = yield* Effect.forEach(
                patterns,
                (pat) =>
                  ripgrep
                    .grep({
                      cwd,
                      pattern: pat,
                      file: type === "file" ? path.basename(root) : undefined,
                      include: input.include,
                      literal: input.literal,
                      caseSensitive: input.caseSensitive,
                      limit: limit + 1,
                    })
                    .pipe(
                      Effect.timeoutOrElse({
                        duration: FileSystem.DEFAULT_SEARCH_TIMEOUT_MS,
                        orElse: () =>
                          Effect.fail(
                            new ToolFailure({
                              message: `Search timed out after ${FileSystem.DEFAULT_SEARCH_TIMEOUT_MS / 1_000} seconds. Consider using a more specific path or pattern.`,
                            }),
                          ),
                      }),
                    ),
                { concurrency: 4 },
              )

              const seen = new Set<string>()
              const combinedMatches: FileSystem.Match[] = []
              for (const result of patternResults) {
                for (const match of result) {
                  const relPath = RelativePath.make(
                    path.relative(location.directory, path.resolve(cwd, match.entry.path)),
                  )
                  const key = `${relPath}:${match.line}`
                  if (!seen.has(key)) {
                    seen.add(key)
                    combinedMatches.push(
                      FileSystem.Match.make({
                        ...match,
                        entry: FileSystem.Entry.make({
                          ...match.entry,
                          path: relPath,
                        }),
                      }),
                    )
                  }
                }
              }

              combinedMatches.sort((a, b) => {
                const cmp = a.entry.path.localeCompare(b.entry.path)
                return cmp !== 0 ? cmp : a.line - b.line
              })

              const matches = combinedMatches.slice(0, limit)
              const truncated = combinedMatches.length > limit
              return { matches, truncated }
            }).pipe(
              Effect.map((result) => ({
                output: result.matches,
                content: toModelContent(
                  result.matches.map((match) => ({
                    ...match,
                    entry: { ...match.entry, path: path.resolve(location.directory, match.entry.path) },
                  })),
                  result.truncated,
                  location.directory,
                ),
                metadata: { matches: result.matches.length, truncated: result.truncated },
              })),
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : error instanceof Ripgrep.InvalidPatternError
                    ? new ToolFailure({ message: `Invalid regex pattern: ${error.message}` })
                    : new ToolFailure({
                        message: `Unable to grep for ${
                          (input.queries && input.queries.length > 0 ? input.queries : [input.pattern]).join(", ")
                        }`,
                        error,
                      }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
