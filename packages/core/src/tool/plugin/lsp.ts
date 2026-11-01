export * as LspTool from "./lsp.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import path from "path"
import fs from "fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createRequire } from "node:module"
import { Location } from "../../location.js"
import { FileAccess } from "../../file-access.js"
import { Permission } from "../../permission.js"
import { PositiveInt, optional } from "../../schema.js"

export const name = "lsp"

const execFileAsync = promisify(execFile)

const ActionSchema = Schema.Literals(["symbols", "definition", "references", "hover", "diagnostics"])
export type Action = typeof ActionSchema.Type

export const Input = Schema.Struct({
  action: ActionSchema.annotate({
    description: "LSP operation: 'symbols' (outline or workspace search), 'definition', 'references', 'hover', or 'diagnostics'.",
  }),
  filePath: Schema.String.annotate({
    description: "Target file path relative to workspace or absolute.",
  }).pipe(optional),
  line: PositiveInt.annotate({
    description: "1-based line number for position-based actions (definition, references, hover).",
  }).pipe(optional),
  column: PositiveInt.annotate({
    description: "1-based column number for position-based actions. Optional; automatically resolved if symbol is provided.",
  }).pipe(optional),
  symbol: Schema.String.annotate({
    description: "Symbol name. If column is omitted, automatically finds the symbol on the specified line.",
  }).pipe(optional),
  query: Schema.String.annotate({
    description: "Search query for workspace symbol search when action is 'symbols'.",
  }).pipe(optional),
  limit: PositiveInt.annotate({
    description: "Maximum number of symbols or references to return (default: 50).",
  }).pipe(optional),
})
export type Input = typeof Input.Type

export const SymbolItem = Schema.Struct({
  name: Schema.String,
  kind: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  endLine: Schema.Number.pipe(optional),
  endColumn: Schema.Number.pipe(optional),
  containerName: Schema.String.pipe(optional),
  filePath: Schema.String.pipe(optional),
  signature: Schema.String.pipe(optional),
  docstring: Schema.String.pipe(optional),
})
export type SymbolItem = typeof SymbolItem.Type

export const DefinitionItem = Schema.Struct({
  filePath: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  preview: Schema.String,
})
export type DefinitionItem = typeof DefinitionItem.Type

export const ReferenceItem = Schema.Struct({
  filePath: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  isWriteAccess: Schema.Boolean,
  lineText: Schema.String,
})
export type ReferenceItem = typeof ReferenceItem.Type

export const HoverResult = Schema.Struct({
  signature: Schema.String,
  documentation: Schema.String.pipe(optional),
  tags: Schema.Array(Schema.String).pipe(optional),
})
export type HoverResult = typeof HoverResult.Type

export const DiagnosticItem = Schema.Struct({
  filePath: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  code: Schema.String,
  category: Schema.String,
  message: Schema.String,
})
export type DiagnosticItem = typeof DiagnosticItem.Type

export const Output = Schema.Struct({
  action: ActionSchema,
  filePath: Schema.String.pipe(optional),
  symbols: Schema.Array(SymbolItem).pipe(optional),
  definitions: Schema.Array(DefinitionItem).pipe(optional),
  references: Schema.Array(ReferenceItem).pipe(optional),
  hover: HoverResult.pipe(optional),
  diagnostics: Schema.Array(DiagnosticItem).pipe(optional),
})
export type Output = typeof Output.Type

// -----------------------------------------------------------------------------
// TypeScript LanguageService LRU Cache
// -----------------------------------------------------------------------------

interface TsInstance {
  readonly rootDir: string
  readonly ts: any
  readonly service: any
  readonly files: Set<string>
  readonly fileMtimes: Map<string, number>
}

const MAX_TS_PROJECTS = 4
const tsProjectsLru: TsInstance[] = []

function loadTypeScript(dir: string): any {
  try {
    const req = createRequire(path.join(dir, "package.json"))
    return req("typescript")
  } catch {
    try {
      const req = createRequire(import.meta.url)
      return req("typescript")
    } catch {
      return require("typescript")
    }
  }
}

function getTsInstance(rootDir: string): TsInstance {
  const existingIdx = tsProjectsLru.findIndex((p) => p.rootDir === rootDir)
  if (existingIdx >= 0) {
    const item = tsProjectsLru[existingIdx]!
    tsProjectsLru.splice(existingIdx, 1)
    tsProjectsLru.unshift(item)
    return item
  }

  const ts = loadTypeScript(rootDir)
  const files = new Set<string>()
  const fileMtimes = new Map<string, number>()

  let compilerOptions: any = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    esModuleInterop: true,
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    skipLibCheck: true,
  }

  const tsconfigPath = ts.findConfigFile(rootDir, ts.sys.fileExists)
  if (tsconfigPath) {
    try {
      const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
      if (configFile.config) {
        const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsconfigPath))
        compilerOptions = { ...compilerOptions, ...parsed.options }
        for (const file of parsed.fileNames) {
          files.add(path.resolve(file))
        }
      }
    } catch {
      // Fallback to default compiler options
    }
  }

  const host = {
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => Array.from(files),
    getScriptVersion: (fileName: string) => {
      try {
        const stat = fs.statSync(fileName)
        fileMtimes.set(fileName, stat.mtimeMs)
        return String(stat.mtimeMs)
      } catch {
        return "0"
      }
    },
    getScriptSnapshot: (fileName: string) => {
      try {
        if (!fs.existsSync(fileName)) return undefined
        const content = fs.readFileSync(fileName, "utf8")
        return ts.ScriptSnapshot.fromString(content)
      } catch {
        return undefined
      }
    },
    getCurrentDirectory: () => rootDir,
    getDefaultLibFileName: (options: any) => ts.getDefaultLibFilePath(options),
    fileExists: (fileName: string) => ts.sys.fileExists(fileName),
    readFile: (fileName: string) => ts.sys.readFile(fileName),
    readDirectory: (
      dir: string,
      extensions?: readonly string[],
      excludes?: readonly string[],
      includes?: readonly string[],
      depth?: number,
    ) => ts.sys.readDirectory(dir, extensions, excludes, includes, depth),
    directoryExists: (dirName: string) => ts.sys.directoryExists(dirName),
    getDirectories: (dirName: string) => ts.sys.getDirectories(dirName),
  }

  const service = ts.createLanguageService(host)
  const instance: TsInstance = { rootDir, ts, service, files, fileMtimes }

  tsProjectsLru.unshift(instance)
  if (tsProjectsLru.length > MAX_TS_PROJECTS) {
    tsProjectsLru.pop()
  }

  return instance
}

function resolveSymbolColumn(
  lines: string[],
  line: number,
  column: number | undefined,
  symbol: string | undefined,
): number {
  if (column !== undefined && column > 0) return column
  const lineText = lines[line - 1] ?? ""
  if (symbol && symbol.length > 0) {
    const idx = lineText.indexOf(symbol)
    if (idx >= 0) return idx + 1
  }
  return 1
}

function getCodePreview(fileLines: string[], targetLine: number): string {
  const start = Math.max(1, targetLine - 2)
  const end = Math.min(fileLines.length, targetLine + 2)
  const previewLines: string[] = []
  for (let l = start; l <= end; l++) {
    const prefix = l === targetLine ? "> " : "  "
    previewLines.push(`${prefix}${l}: ${fileLines[l - 1] ?? ""}`)
  }
  return previewLines.join("\n")
}

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs"])

// -----------------------------------------------------------------------------
// Python AST Backend
// -----------------------------------------------------------------------------

const PYTHON_SYMBOLS_SCRIPT = `
import ast, json, sys

path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as f:
        code = f.read()
    tree = ast.parse(code, filename=path)
except Exception as e:
    print(json.dumps([]))
    sys.exit(0)

symbols = []

def get_signature(node):
    if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return None
    args = []
    for a in node.args.args:
        ann = f": {ast.unparse(a.annotation)}" if a.annotation else ""
        args.append(f"{a.arg}{ann}")
    ret = f" -> {ast.unparse(node.returns)}" if getattr(node, "returns", None) else ""
    return f"def {node.name}({', '.join(args)}){ret}"

for node in tree.body:
    if isinstance(node, ast.ClassDef):
        symbols.append({
            "name": node.name,
            "kind": "class",
            "line": node.lineno,
            "column": node.col_offset + 1,
            "endLine": getattr(node, "end_lineno", node.lineno),
            "docstring": ast.get_docstring(node),
            "signature": f"class {node.name}"
        })
        for child in node.body:
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                symbols.append({
                    "name": child.name,
                    "kind": "method",
                    "containerName": node.name,
                    "line": child.lineno,
                    "column": child.col_offset + 1,
                    "endLine": getattr(child, "end_lineno", child.lineno),
                    "docstring": ast.get_docstring(child),
                    "signature": get_signature(child)
                })
    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        symbols.append({
            "name": node.name,
            "kind": "function",
            "line": node.lineno,
            "column": node.col_offset + 1,
            "endLine": getattr(node, "end_lineno", node.lineno),
            "docstring": ast.get_docstring(node),
            "signature": get_signature(node)
        })
    elif isinstance(node, ast.Assign):
        for target in node.targets:
            if isinstance(target, ast.Name):
                symbols.append({
                    "name": target.id,
                    "kind": "variable",
                    "line": target.lineno,
                    "column": target.col_offset + 1,
                    "endLine": getattr(node, "end_lineno", node.lineno),
                })

print(json.dumps(symbols))
`

const PYTHON_DIAGNOSTICS_SCRIPT = `
import ast, json, sys

path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as f:
        code = f.read()
    ast.parse(code, filename=path)
    print(json.dumps([]))
except SyntaxError as e:
    diags = [{
        "filePath": path,
        "line": e.lineno or 1,
        "column": e.offset or 1,
        "code": "PY_SYNTAX",
        "category": "error",
        "message": f"SyntaxError: {e.msg}"
    }]
    print(json.dumps(diags))
except Exception as e:
    diags = [{
        "filePath": path,
        "line": 1,
        "column": 1,
        "code": "PY_ERROR",
        "category": "error",
        "message": str(e)
    }]
    print(json.dumps(diags))
`

async function runPythonScript(script: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/python3", ["-c", script, ...args], { maxBuffer: 10 * 1024 * 1024 })
  return stdout.trim()
}

// -----------------------------------------------------------------------------
// Universal Fallback (Regex / Ripgrep)
// -----------------------------------------------------------------------------

function extractFallbackSymbols(filePath: string, content: string): SymbolItem[] {
  const lines = content.split("\n")
  const symbols: SymbolItem[] = []
  const symbolRegex =
    /^\s*(?:pub\s+)?(?:export\s+)?(?:async\s+)?(?:def|fn|func|function|class|struct|interface|type|enum)\s+([A-Za-z0-9_]+)/
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]!
    const match = symbolRegex.exec(lineText)
    if (match && match[1]) {
      const col = lineText.indexOf(match[1]) + 1
      symbols.push({
        name: match[1],
        kind: "symbol",
        line: i + 1,
        column: col,
        filePath,
        signature: lineText.trim(),
      })
    }
  }
  return symbols
}

function findFallbackDefinition(
  targetDir: string,
  symbol: string,
  ext: string,
): { filePath: string; line: number; column: number; preview: string } | undefined {
  const filesToScan: string[] = []
  function walk(current: string) {
    if (filesToScan.length > 200) return
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "target") continue
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile() && path.extname(entry.name) === ext) filesToScan.push(full)
      }
    } catch {
      // ignore
    }
  }
  walk(targetDir)

  const defRegex = new RegExp(
    `\\b(?:pub\\s+)?(?:export\\s+)?(?:async\\s+)?(?:def|fn|func|function|class|struct|interface|type|enum|const|let|var)\\s+${symbol}\\b`,
  )
  for (const f of filesToScan) {
    try {
      const text = fs.readFileSync(f, "utf8")
      const lines = text.split("\n")
      for (let i = 0; i < lines.length; i++) {
        if (defRegex.test(lines[i]!)) {
          const col = lines[i]!.indexOf(symbol) + 1
          return {
            filePath: f,
            line: i + 1,
            column: col,
            preview: getCodePreview(lines, i + 1),
          }
        }
      }
    } catch {
      // ignore
    }
  }
  return undefined
}

function findFallbackReferences(
  targetDir: string,
  symbol: string,
  ext: string,
  limit: number,
): ReferenceItem[] {
  const references: ReferenceItem[] = []
  const filesToScan: string[] = []
  function walk(current: string) {
    if (filesToScan.length > 200) return
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "target") continue
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile() && path.extname(entry.name) === ext) filesToScan.push(full)
      }
    } catch {
      // ignore
    }
  }
  walk(targetDir)

  const symRegex = new RegExp(`\\b${symbol}\\b`)
  for (const f of filesToScan) {
    try {
      const text = fs.readFileSync(f, "utf8")
      const lines = text.split("\n")
      for (let i = 0; i < lines.length; i++) {
        if (symRegex.test(lines[i]!)) {
          const col = lines[i]!.indexOf(symbol) + 1
          references.push({
            filePath: f,
            line: i + 1,
            column: col,
            isWriteAccess: false,
            lineText: lines[i]!.trim(),
          })
          if (references.length >= limit) return references
        }
      }
    } catch {
      // ignore
    }
  }
  return references
}

// -----------------------------------------------------------------------------
// Plugin Definition
// -----------------------------------------------------------------------------

export const Plugin = {
  id: "opencode.tool.lsp",
  effect: Effect.fn("LspTool.Plugin")(function* (ctx: Context) {
    const access = yield* FileAccess.Service
    const permission = yield* Permission.Service
    const location = yield* Location.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description:
            "Language Server Protocol (LSP) tool for code intelligence. Provides document outline & workspace symbols, definition lookup with 5-line previews and symbol-column auto-resolution, reference finding, type hover signatures & docs, and instant syntax/semantic diagnostics. Supports TypeScript/JavaScript, Python, and fallback languages.",
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = { type: "tool" as const, messageID: context.messageID, id: context.id }
              let resolvedTarget: FileAccess.Target | undefined

              if (input.filePath) {
                resolvedTarget = yield* access.resolve({ path: input.filePath, kind: "file" })
                yield* access.authorizeExternal([resolvedTarget], context)
                yield* permission.assert({
                  action: name,
                  resources: [resolvedTarget.resource],
                  save: ["*"],
                  metadata: input,
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
              } else {
                yield* permission.assert({
                  action: name,
                  resources: ["*"],
                  save: ["*"],
                  metadata: input,
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
              }

              const rootDir = location.directory
              const absFilePath = resolvedTarget ? resolvedTarget.absolute : undefined
              const ext = absFilePath ? path.extname(absFilePath).toLowerCase() : ""
              const limit = input.limit ?? 50

              // ---------------------------------------------------------------
              // 1. TypeScript / JavaScript Backend
              // ---------------------------------------------------------------
              if (!absFilePath || TS_EXTENSIONS.has(ext)) {
                const tsInstance = getTsInstance(rootDir)
                const { ts, service } = tsInstance

                if (absFilePath) {
                  tsInstance.files.add(absFilePath)
                }

                if (input.action === "symbols") {
                  if (absFilePath) {
                    if (!fs.existsSync(absFilePath)) {
                      return yield* new ToolFailure({ message: `File not found: ${absFilePath}` })
                    }
                    const navTree = service.getNavigationTree(absFilePath)
                    const sourceFile = service.getProgram()?.getSourceFile(absFilePath)
                    const symbols: SymbolItem[] = []

                    function walk(node: any, container?: string) {
                      if (!node) return
                      if (node.text && node.text !== "<global>") {
                        const span = node.spans?.[0]
                        let line = 1
                        let column = 1
                        let endLine = 1
                        let endColumn = 1
                        if (span && sourceFile) {
                          const startLoc = sourceFile.getLineAndCharacterOfPosition(span.start)
                          line = startLoc.line + 1
                          column = startLoc.character + 1
                          const endLoc = sourceFile.getLineAndCharacterOfPosition(span.start + span.length)
                          endLine = endLoc.line + 1
                          endColumn = endLoc.character + 1
                        }
                        symbols.push({
                          name: node.text,
                          kind: node.kind ?? "symbol",
                          line,
                          column,
                          endLine,
                          endColumn,
                          containerName: container,
                          filePath: absFilePath,
                        })
                      }
                      if (node.childItems) {
                        for (const child of node.childItems) {
                          walk(child, node.text && node.text !== "<global>" ? node.text : container)
                        }
                      }
                    }

                    walk(navTree)
                    const lines = [
                      `### Symbols for ${path.relative(rootDir, absFilePath)} (${symbols.length} found):`,
                      ...symbols.map(
                        (s) =>
                          `- \`${s.name}\` (${s.kind}) at line ${s.line}:${s.column}${s.containerName ? ` [in ${s.containerName}]` : ""}`,
                      ),
                    ]
                    return {
                      output: { action: "symbols" as const, filePath: absFilePath, symbols },
                      content: lines.join("\n"),
                    }
                  } else if (input.query) {
                    const navItems = service.getNavigateToItems(input.query, limit) ?? []
                    const symbols: SymbolItem[] = navItems.map((item: any) => {
                      const itemSource = service.getProgram()?.getSourceFile(item.fileName)
                      let line = 1
                      let column = 1
                      if (itemSource && item.textSpan) {
                        const loc = itemSource.getLineAndCharacterOfPosition(item.textSpan.start)
                        line = loc.line + 1
                        column = loc.character + 1
                      }
                      return {
                        name: item.name,
                        kind: item.kind,
                        line,
                        column,
                        containerName: item.containerName || undefined,
                        filePath: item.fileName,
                      }
                    })

                    const lines = [
                      `### Workspace Symbols for query "${input.query}" (${symbols.length} found):`,
                      ...symbols.map(
                        (s) =>
                          `- \`${s.name}\` (${s.kind}) in ${s.filePath ? path.relative(rootDir, s.filePath) : ""}:${s.line}:${s.column}`,
                      ),
                    ]
                    return {
                      output: { action: "symbols" as const, symbols },
                      content: lines.join("\n"),
                    }
                  } else {
                    return yield* new ToolFailure({ message: "Either filePath or query must be provided for 'symbols'" })
                  }
                }

                if (input.action === "definition") {
                  if (!absFilePath) {
                    return yield* new ToolFailure({ message: "filePath is required for 'definition'" })
                  }
                  if (!fs.existsSync(absFilePath)) {
                    return yield* new ToolFailure({ message: `File not found: ${absFilePath}` })
                  }
                  const fileContent = fs.readFileSync(absFilePath, "utf8")
                  const lines = fileContent.split("\n")
                  const line = input.line ?? 1
                  const column = resolveSymbolColumn(lines, line, input.column, input.symbol)

                  const sourceFile = service.getProgram()?.getSourceFile(absFilePath)
                  if (!sourceFile) {
                    return yield* new ToolFailure({ message: `Unable to parse source file: ${absFilePath}` })
                  }

                  const offset = sourceFile.getPositionOfLineAndCharacter(line - 1, column - 1)
                  const defs = service.getDefinitionAtPosition(absFilePath, offset) ?? []

                  const definitions: DefinitionItem[] = []
                  for (const def of defs) {
                    const defSource = service.getProgram()?.getSourceFile(def.fileName)
                    let defLine = 1
                    let defCol = 1
                    if (defSource) {
                      const loc = defSource.getLineAndCharacterOfPosition(def.textSpan.start)
                      defLine = loc.line + 1
                      defCol = loc.character + 1
                    }
                    let preview = ""
                    try {
                      const targetText = fs.readFileSync(def.fileName, "utf8")
                      preview = getCodePreview(targetText.split("\n"), defLine)
                    } catch {
                      preview = "(preview unavailable)"
                    }
                    definitions.push({
                      filePath: def.fileName,
                      line: defLine,
                      column: defCol,
                      preview,
                    })
                  }

                  const linesOut = [
                    `### Definitions for ${input.symbol ? `\`${input.symbol}\`` : `symbol at ${line}:${column}`} in ${path.relative(rootDir, absFilePath)} (${definitions.length} found):`,
                    ...definitions.map(
                      (d) =>
                        `\n**${path.relative(rootDir, d.filePath)}:${d.line}:${d.column}**\n\`\`\`typescript\n${d.preview}\n\`\`\``,
                    ),
                  ]
                  return {
                    output: { action: "definition" as const, filePath: absFilePath, definitions },
                    content: linesOut.join("\n"),
                  }
                }

                if (input.action === "references") {
                  if (!absFilePath) {
                    return yield* new ToolFailure({ message: "filePath is required for 'references'" })
                  }
                  if (!fs.existsSync(absFilePath)) {
                    return yield* new ToolFailure({ message: `File not found: ${absFilePath}` })
                  }
                  const fileContent = fs.readFileSync(absFilePath, "utf8")
                  const lines = fileContent.split("\n")
                  const line = input.line ?? 1
                  const column = resolveSymbolColumn(lines, line, input.column, input.symbol)

                  const sourceFile = service.getProgram()?.getSourceFile(absFilePath)
                  if (!sourceFile) {
                    return yield* new ToolFailure({ message: `Unable to parse source file: ${absFilePath}` })
                  }

                  const offset = sourceFile.getPositionOfLineAndCharacter(line - 1, column - 1)
                  const refSymbols = service.findReferences(absFilePath, offset) ?? []

                  const references: ReferenceItem[] = []
                  for (const sym of refSymbols) {
                    for (const ref of sym.references) {
                      const refSource = service.getProgram()?.getSourceFile(ref.fileName)
                      let refLine = 1
                      let refCol = 1
                      if (refSource) {
                        const loc = refSource.getLineAndCharacterOfPosition(ref.textSpan.start)
                        refLine = loc.line + 1
                        refCol = loc.character + 1
                      }
                      let lineText = ""
                      try {
                        const targetText = fs.readFileSync(ref.fileName, "utf8")
                        lineText = (targetText.split("\n")[refLine - 1] ?? "").trim()
                      } catch {
                        lineText = ""
                      }
                      references.push({
                        filePath: ref.fileName,
                        line: refLine,
                        column: refCol,
                        isWriteAccess: Boolean(ref.isWriteAccess),
                        lineText,
                      })
                      if (references.length >= limit) break
                    }
                    if (references.length >= limit) break
                  }

                  const linesOut = [
                    `### References (${references.length} found):`,
                    ...references.map(
                      (r) =>
                        `- ${path.relative(rootDir, r.filePath)}:${r.line}:${r.column}${r.isWriteAccess ? " [write]" : ""}: \`${r.lineText}\``,
                    ),
                  ]
                  return {
                    output: { action: "references" as const, filePath: absFilePath, references },
                    content: linesOut.join("\n"),
                  }
                }

                if (input.action === "hover") {
                  if (!absFilePath) {
                    return yield* new ToolFailure({ message: "filePath is required for 'hover'" })
                  }
                  if (!fs.existsSync(absFilePath)) {
                    return yield* new ToolFailure({ message: `File not found: ${absFilePath}` })
                  }
                  const fileContent = fs.readFileSync(absFilePath, "utf8")
                  const lines = fileContent.split("\n")
                  const line = input.line ?? 1
                  const column = resolveSymbolColumn(lines, line, input.column, input.symbol)

                  const sourceFile = service.getProgram()?.getSourceFile(absFilePath)
                  if (!sourceFile) {
                    return yield* new ToolFailure({ message: `Unable to parse source file: ${absFilePath}` })
                  }

                  const offset = sourceFile.getPositionOfLineAndCharacter(line - 1, column - 1)
                  const info = service.getQuickInfoAtPosition(absFilePath, offset)

                  if (!info) {
                    return {
                      output: { action: "hover" as const, filePath: absFilePath },
                      content: `No type information available at ${path.relative(rootDir, absFilePath)}:${line}:${column}`,
                    }
                  }

                  const signature = ts.displayPartsToString(info.displayParts)
                  const documentation = ts.displayPartsToString(info.documentation) || undefined
                  const tags = info.tags?.map((t: any) => `@${t.name} ${ts.displayPartsToString(t.text)}`.trim())

                  const hover: HoverResult = { signature, documentation, tags }
                  const markdown = [
                    `\`\`\`typescript\n${signature}\n\`\`\``,
                    ...(documentation ? ["\n" + documentation] : []),
                    ...(tags && tags.length > 0 ? ["\n" + tags.join("\n")] : []),
                  ].join("\n")

                  return {
                    output: { action: "hover" as const, filePath: absFilePath, hover },
                    content: markdown,
                  }
                }

                if (input.action === "diagnostics") {
                  if (!absFilePath) {
                    return yield* new ToolFailure({ message: "filePath is required for 'diagnostics'" })
                  }
                  if (!fs.existsSync(absFilePath)) {
                    return yield* new ToolFailure({ message: `File not found: ${absFilePath}` })
                  }

                  const syntactic = service.getSyntacticDiagnostics(absFilePath) ?? []
                  const semantic = service.getSemanticDiagnostics(absFilePath) ?? []
                  const allDiags = [...syntactic, ...semantic]

                  const sourceFile = service.getProgram()?.getSourceFile(absFilePath)
                  const diagnostics: DiagnosticItem[] = allDiags.map((d: any) => {
                    let line = 1
                    let column = 1
                    if (sourceFile && typeof d.start === "number") {
                      const loc = sourceFile.getLineAndCharacterOfPosition(d.start)
                      line = loc.line + 1
                      column = loc.character + 1
                    }
                    const categoryMap = ["warning", "error", "suggestion", "message"]
                    const category = categoryMap[d.category] ?? "error"
                    const message = ts.flattenDiagnosticMessageText(d.messageText, "\n")
                    return {
                      filePath: absFilePath,
                      line,
                      column,
                      code: `TS${d.code}`,
                      category,
                      message,
                    }
                  })

                  const contentOut =
                    diagnostics.length === 0
                      ? `No diagnostics found for ${path.relative(rootDir, absFilePath)} (0 errors, 0 warnings)`
                      : [
                          `### Diagnostics for ${path.relative(rootDir, absFilePath)} (${diagnostics.length} issues):`,
                          ...diagnostics.map(
                            (d) =>
                              `- [${d.category.toUpperCase()}] line ${d.line}:${d.column} (${d.code}): ${d.message}`,
                          ),
                        ].join("\n")

                  return {
                    output: { action: "diagnostics" as const, filePath: absFilePath, diagnostics },
                    content: contentOut,
                  }
                }
              }

              // ---------------------------------------------------------------
              // 2. Python Backend (.py)
              // ---------------------------------------------------------------
              if (ext === ".py" && absFilePath) {
                if (!fs.existsSync(absFilePath)) {
                  return yield* new ToolFailure({ message: `File not found: ${absFilePath}` })
                }

                if (input.action === "symbols") {
                  const stdout = yield* Effect.tryPromise({
                    try: () => runPythonScript(PYTHON_SYMBOLS_SCRIPT, [absFilePath]),
                    catch: (err) => new ToolFailure({ message: `Python AST symbols failed: ${String(err)}` }),
                  })
                  let rawSymbols: any[] = []
                  try {
                    rawSymbols = JSON.parse(stdout)
                  } catch {
                    rawSymbols = []
                  }
                  const symbols: SymbolItem[] = rawSymbols.map((s) => ({
                    name: s.name,
                    kind: s.kind,
                    line: s.line,
                    column: s.column,
                    endLine: s.endLine,
                    containerName: s.containerName || undefined,
                    filePath: absFilePath,
                    signature: s.signature || undefined,
                    docstring: s.docstring || undefined,
                  }))

                  const lines = [
                    `### Python Symbols for ${path.relative(rootDir, absFilePath)} (${symbols.length} found):`,
                    ...symbols.map(
                      (s) =>
                        `- \`${s.name}\` (${s.kind}) at line ${s.line}:${s.column}${s.containerName ? ` [in ${s.containerName}]` : ""}${s.docstring ? ` — "${s.docstring.split("\n")[0]}"` : ""}`,
                    ),
                  ]
                  return {
                    output: { action: "symbols" as const, filePath: absFilePath, symbols },
                    content: lines.join("\n"),
                  }
                }

                if (input.action === "diagnostics") {
                  const stdout = yield* Effect.tryPromise({
                    try: () => runPythonScript(PYTHON_DIAGNOSTICS_SCRIPT, [absFilePath]),
                    catch: (err) => new ToolFailure({ message: `Python diagnostics failed: ${String(err)}` }),
                  })
                  let diagnostics: DiagnosticItem[] = []
                  try {
                    diagnostics = JSON.parse(stdout)
                  } catch {
                    diagnostics = []
                  }
                  const contentOut =
                    diagnostics.length === 0
                      ? `No Python syntax errors found in ${path.relative(rootDir, absFilePath)}`
                      : [
                          `### Diagnostics for ${path.relative(rootDir, absFilePath)} (${diagnostics.length} issues):`,
                          ...diagnostics.map(
                            (d) =>
                              `- [${d.category.toUpperCase()}] line ${d.line}:${d.column} (${d.code}): ${d.message}`,
                          ),
                        ].join("\n")
                  return {
                    output: { action: "diagnostics" as const, filePath: absFilePath, diagnostics },
                    content: contentOut,
                  }
                }

                if (input.action === "definition" || input.action === "references" || input.action === "hover") {
                  const text = fs.readFileSync(absFilePath, "utf8")
                  const lines = text.split("\n")
                  const line = input.line ?? 1
                  const column = resolveSymbolColumn(lines, line, input.column, input.symbol)
                  const sym = input.symbol ?? (lines[line - 1]?.substring(column - 1).match(/^[A-Za-z0-9_]+/)?.[0] || "")

                  if (input.action === "definition") {
                    const def = findFallbackDefinition(rootDir, sym, ".py")
                    const definitions = def ? [def] : []
                    const linesOut = [
                      `### Definitions for \`${sym}\` (${definitions.length} found):`,
                      ...definitions.map(
                        (d) =>
                          `\n**${path.relative(rootDir, d.filePath)}:${d.line}:${d.column}**\n\`\`\`python\n${d.preview}\n\`\`\``,
                      ),
                    ]
                    return {
                      output: { action: "definition" as const, filePath: absFilePath, definitions },
                      content: linesOut.join("\n"),
                    }
                  }

                  if (input.action === "references") {
                    const references = findFallbackReferences(rootDir, sym, ".py", limit)
                    const linesOut = [
                      `### References for \`${sym}\` (${references.length} found):`,
                      ...references.map(
                        (r) => `- ${path.relative(rootDir, r.filePath)}:${r.line}:${r.column}: \`${r.lineText}\``,
                      ),
                    ]
                    return {
                      output: { action: "references" as const, filePath: absFilePath, references },
                      content: linesOut.join("\n"),
                    }
                  }

                  if (input.action === "hover") {
                    const def = findFallbackDefinition(rootDir, sym, ".py")
                    const sig = def ? def.preview.split("\n")[0] ?? `symbol: ${sym}` : `symbol: ${sym}`
                    const hover: HoverResult = { signature: sig }
                    return {
                      output: { action: "hover" as const, filePath: absFilePath, hover },
                      content: `\`\`\`python\n${sig}\n\`\`\``,
                    }
                  }
                }
              }

              // ---------------------------------------------------------------
              // 3. Universal Fallback
              // ---------------------------------------------------------------
              if (absFilePath) {
                if (!fs.existsSync(absFilePath)) {
                  return yield* new ToolFailure({ message: `File not found: ${absFilePath}` })
                }
                const content = fs.readFileSync(absFilePath, "utf8")
                const lines = content.split("\n")
                const line = input.line ?? 1
                const column = resolveSymbolColumn(lines, line, input.column, input.symbol)
                const sym = input.symbol ?? (lines[line - 1]?.substring(column - 1).match(/^[A-Za-z0-9_]+/)?.[0] || "")

                if (input.action === "symbols") {
                  const symbols = extractFallbackSymbols(absFilePath, content)
                  return {
                    output: { action: "symbols" as const, filePath: absFilePath, symbols },
                    content: `### Symbols for ${path.relative(rootDir, absFilePath)}:\n` + symbols.map((s) => `- ${s.name} (line ${s.line})`).join("\n"),
                  }
                }

                if (input.action === "definition") {
                  const def = findFallbackDefinition(rootDir, sym, ext)
                  const definitions = def ? [def] : []
                  return {
                    output: { action: "definition" as const, filePath: absFilePath, definitions },
                    content: `### Definition for ${sym}:\n` + definitions.map((d) => `${d.filePath}:${d.line}\n${d.preview}`).join("\n"),
                  }
                }

                if (input.action === "references") {
                  const references = findFallbackReferences(rootDir, sym, ext, limit)
                  return {
                    output: { action: "references" as const, filePath: absFilePath, references },
                    content: `### References for ${sym}:\n` + references.map((r) => `${r.filePath}:${r.line}: ${r.lineText}`).join("\n"),
                  }
                }

                if (input.action === "hover") {
                  const def = findFallbackDefinition(rootDir, sym, ext)
                  const sig = def ? def.preview.split("\n")[0] ?? sym : sym
                  return {
                    output: { action: "hover" as const, filePath: absFilePath, hover: { signature: sig } },
                    content: `\`\`\`\n${sig}\n\`\`\``,
                  }
                }

                if (input.action === "diagnostics") {
                  return {
                    output: { action: "diagnostics" as const, filePath: absFilePath, diagnostics: [] },
                    content: `Diagnostics for ${path.relative(rootDir, absFilePath)}: language server not configured for ${ext} files.`,
                  }
                }
              }

              return yield* new ToolFailure({ message: "Unsupported LSP action or missing parameters" })
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `LSP operation failed: ${error instanceof Error ? error.message : String(error)}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
