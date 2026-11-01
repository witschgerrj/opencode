import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { FileAccess } from "@opencode/core/file-access"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LspTool } from "@opencode/core/tool/plugin/lsp"
import { HeadlessBrowserTool, assertSafeBrowserUrl } from "@opencode/core/tool/plugin/headless-browser"
import { ArtifactTool, MAX_ARTIFACT_BYTES } from "@opencode/core/tool/plugin/artifact"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { permissionLayer } from "./lib/permission"
import { toolIdentity, executeTool, registerToolPlugin } from "./lib/tool"

const lspToolNode = makeLocationNode({
  name: "test/lsp-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(LspTool.Plugin)),
  deps: [Tool.node, FileAccess.node, Permission.node, Location.node],
})

const browserToolNode = makeLocationNode({
  name: "test/browser-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(HeadlessBrowserTool.Plugin)),
  deps: [Tool.node, Permission.node],
})

const artifactToolNode = makeLocationNode({
  name: "test/artifact-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(ArtifactTool.Plugin)),
  deps: [Tool.node, Permission.node, Location.node],
})

const sessionID = Session.ID.make("ses_intelligence_test")

const permission = permissionLayer({
  assert: () => Effect.void,
  assertNotDenied: () => Effect.void,
})

const withWorkspace = <A, E, R>(
  directory: string,
  body: (registry: Tool.Interface) => Effect.Effect<A, E, R>,
) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location(
        { directory: AbsolutePath.make(directory) },
        { projectDirectory: AbsolutePath.make(directory) },
      ),
    ),
  )

  const group = LayerNode.group([
    Tool.node,
    FileAccess.node,
    Environment.node,
    lspToolNode,
    browserToolNode,
    artifactToolNode,
  ])

  return Effect.gen(function* () {
    const registry = yield* Tool.Service
    return yield* body(registry)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(group, [
        Permission.node.replace(permission),
        Location.node.replace(activeLocation),
      ]),
    ),
  )
}

describe("LspTool", () => {
  test("TypeScript symbols, definition, references, hover, and diagnostics", async () => {
    const tmp = await tmpdir()
    try {
      const tsCode = `export interface Config {
  timeout: number
  retries: number
}

/**
 * Calculates budget using config parameters.
 */
export function calculateBudget(base: number, config: Config): number {
  return base * config.timeout
}

export const defaultBudget = calculateBudget(10, { timeout: 5, retries: 2 })
`
      fs.writeFileSync(path.join(tmp.path, "sample.ts"), tsCode, "utf8")

      const tsErrorCode = `const val: number = "this is a type error"
`
      fs.writeFileSync(path.join(tmp.path, "error.ts"), tsErrorCode, "utf8")

      await Effect.runPromise(
        withWorkspace(tmp.path, (registry) =>
          Effect.gen(function* () {
            // 1. Symbols outline
            const symbolsExec = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call_symbols",
                name: "lsp",
                input: { action: "symbols", filePath: "sample.ts" },
              },
            })
            expect(symbolsExec.status).toBe("completed")
            const symbolNames = symbolsExec.output.symbols.map((s: any) => s.name)
            expect(symbolNames).toContain("Config")
            expect(symbolNames).toContain("calculateBudget")
            expect(symbolNames).toContain("defaultBudget")

            // 2. Definition lookup with symbol auto-column resolution
            const defExec = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call_def",
                name: "lsp",
                input: {
                  action: "definition",
                  filePath: "sample.ts",
                  line: 13,
                  symbol: "calculateBudget",
                },
              },
            })
            expect(defExec.status).toBe("completed")
            expect(defExec.output.definitions.length).toBeGreaterThan(0)
            const targetDef = defExec.output.definitions[0]
            expect(targetDef.line).toBe(9)
            expect(targetDef.preview).toContain("export function calculateBudget")

            // 3. References lookup
            const refExec = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call_refs",
                name: "lsp",
                input: {
                  action: "references",
                  filePath: "sample.ts",
                  line: 9,
                  symbol: "calculateBudget",
                },
              },
            })
            expect(refExec.status).toBe("completed")
            expect(refExec.output.references.length).toBeGreaterThanOrEqual(2)

            // 4. Hover type signature and docstring
            const hoverExec = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call_hover",
                name: "lsp",
                input: {
                  action: "hover",
                  filePath: "sample.ts",
                  line: 9,
                  symbol: "calculateBudget",
                },
              },
            })
            expect(hoverExec.status).toBe("completed")
            expect(hoverExec.output.hover.signature).toContain(
              "function calculateBudget(base: number, config: Config): number",
            )
            expect(hoverExec.output.hover.documentation).toContain("Calculates budget using config parameters")

            // 5. Diagnostics catching TS type error
            const diagExec = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call_diags",
                name: "lsp",
                input: { action: "diagnostics", filePath: "error.ts" },
              },
            })
            expect(diagExec.status).toBe("completed")
            expect(diagExec.output.diagnostics.length).toBeGreaterThan(0)
            const d = diagExec.output.diagnostics[0]
            expect(d.code).toBe("TS2322")
            expect(d.message).toContain("Type 'string' is not assignable to type 'number'")
          }),
        ),
      )
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("Python symbols and syntax diagnostics", async () => {
    const tmp = await tmpdir()
    try {
      const pyCode = `class Greeter:
    """Greeter class docstring."""
    def say_hello(self, name: str) -> str:
        """Return a personalized greeting."""
        return f"Hello, {name}"

def compute_sum(a: int, b: int) -> int:
    return a + b
`
      fs.writeFileSync(path.join(tmp.path, "sample.py"), pyCode, "utf8")

      const pyErrorCode = `def invalid_syntax(
    return 42
`
      fs.writeFileSync(path.join(tmp.path, "error.py"), pyErrorCode, "utf8")

      await Effect.runPromise(
        withWorkspace(tmp.path, (registry) =>
          Effect.gen(function* () {
            // Symbols
            const symExec = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call_py_symbols",
                name: "lsp",
                input: { action: "symbols", filePath: "sample.py" },
              },
            })
            expect(symExec.status).toBe("completed")
            const names = symExec.output.symbols.map((s: any) => s.name)
            expect(names).toContain("Greeter")
            expect(names).toContain("say_hello")
            expect(names).toContain("compute_sum")

            // Diagnostics
            const diagExec = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call_py_diags",
                name: "lsp",
                input: { action: "diagnostics", filePath: "error.py" },
              },
            })
            expect(diagExec.status).toBe("completed")
            expect(diagExec.output.diagnostics.length).toBeGreaterThan(0)
            expect(diagExec.output.diagnostics[0].code).toBe("PY_SYNTAX")
          }),
        ),
      )
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("Universal fallback on non-TS/Py files (e.g. Rust)", async () => {
    const tmp = await tmpdir()
    try {
      const rsCode = `pub struct AgentWorker {
    pub id: String,
}

pub fn start_worker(id: &str) -> AgentWorker {
    AgentWorker { id: id.to_string() }
}
`
      fs.writeFileSync(path.join(tmp.path, "sample.rs"), rsCode, "utf8")

      await Effect.runPromise(
        withWorkspace(tmp.path, (registry) =>
          Effect.gen(function* () {
            const symExec = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call_rs_symbols",
                name: "lsp",
                input: { action: "symbols", filePath: "sample.rs" },
              },
            })
            expect(symExec.status).toBe("completed")
            const names = symExec.output.symbols.map((s: any) => s.name)
            expect(names).toContain("AgentWorker")
            expect(names).toContain("start_worker")
          }),
        ),
      )
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })
})

describe("HeadlessBrowserTool", () => {
  test("assertSafeBrowserUrl rejects SSRF targets and respects localhost policy", async () => {
    // Loopback IPv4
    await expect(assertSafeBrowserUrl("http://127.0.0.1:8080")).rejects.toThrow()
    // Private IPv4
    await expect(assertSafeBrowserUrl("https://192.168.50.1")).rejects.toThrow()
    // File URI
    await expect(assertSafeBrowserUrl("file:///etc/passwd")).rejects.toThrow()
    // Cloud metadata link-local IP
    await expect(assertSafeBrowserUrl("http://169.254.169.254")).rejects.toThrow()
    // Private IPv6
    await expect(assertSafeBrowserUrl("https://[fc00::1]")).rejects.toThrow()

    // Localhost rejected by default
    await expect(assertSafeBrowserUrl("http://localhost:3000", false)).rejects.toThrow()
    // Localhost allowed when explicitly requested
    const local = await assertSafeBrowserUrl("http://localhost:3000", true)
    expect(local.hostname).toBe("localhost")
  })

  test("render_html executes interaction step, blocks external requests, and returns PNG screenshot", async () => {
    const tmp = await tmpdir()
    try {
      const html = `<!DOCTYPE html>
<html>
<head><title>Visual Sandbox</title></head>
<body>
  <h1>Interactive Test UI</h1>
  <div id="output">ready</div>
  <button id="action-btn" onclick="document.getElementById('output').innerText = 'button-clicked'">Click Me</button>
  <img src="https://example.com/blocked-network-image.png" />
  <script>
    console.error("Test console error from sandbox");
  </script>
</body>
</html>`

      await Effect.runPromise(
        withWorkspace(tmp.path, (registry) =>
          Effect.gen(function* () {
            const browserExec = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call_render",
                name: "headless_browser",
                input: {
                  action: "render_html",
                  html,
                  steps: [{ type: "click", selector: "#action-btn" }],
                  screenshot: true,
                },
              },
            })

            expect(browserExec.status).toBe("completed")
            expect(browserExec.output.title).toBe("Visual Sandbox")
            expect(browserExec.output.headings[0].text).toBe("Interactive Test UI")
            expect(browserExec.output.screenshotCaptured).toBe(true)

            // Verify step updated DOM state
            expect(browserExec.output.textPreview).toContain("button-clicked")

            // Verify console error captured
            const hasConsoleError = browserExec.output.consoleErrors.some((e: string) =>
              e.includes("Test console error from sandbox"),
            )
            expect(hasConsoleError).toBe(true)

            // Verify interactive elements
            const btn = browserExec.output.interactiveElements.find((el: any) => el.selector === "#action-btn")
            expect(btn).toBeDefined()

            // Verify multimodal screenshot content (PNG base64 header iVBORw0KGgo)
            const filePart = browserExec.content?.find((c) => c.type === "file")
            expect(filePart).toBeDefined()
            if (filePart && filePart.type === "file") {
              expect(filePart.mime).toBe("image/png")
              expect(filePart.uri).toMatch(/^data:image\/png;base64,iVBORw0KGgo/)
            }
          }),
        ),
      )
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })
})

describe("ArtifactTool", () => {
  test("renders html, svg, and mermaid artifacts and sanitizes refresh meta tags", async () => {
    const tmp = await tmpdir()
    try {
      await Effect.runPromise(
        withWorkspace(tmp.path, (registry) =>
          Effect.gen(function* () {
            // 1. HTML artifact with dangerous refresh tag stripped
            const htmlWithRefresh = `<html><head><meta http-equiv="refresh" content="0;url=http://evil.com"></head><body><h1>Widget</h1></body></html>`
            const htmlExec = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call_art_html",
                name: "render_artifact",
                input: {
                  kind: "html",
                  title: "Dashboard Widget",
                  summary: "Interactive KPI widget",
                  content: htmlWithRefresh,
                  saveToPath: true,
                },
              },
            })
            expect(htmlExec.status).toBe("completed")
            expect(htmlExec.output.kind).toBe("html")
            expect(htmlExec.output.title).toBe("Dashboard Widget")
            expect(htmlExec.output.content).not.toContain("http-equiv")
            expect(htmlExec.output.path).toBeDefined()
            expect(fs.existsSync(htmlExec.output.path!)).toBe(true)
            expect(htmlExec.metadata?.artifact.kind).toBe("html")

            // 2. SVG artifact
            const svgContent = `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="teal"/></svg>`
            const svgExec = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call_art_svg",
                name: "render_artifact",
                input: {
                  kind: "svg",
                  title: "Teal Circle",
                  content: svgContent,
                },
              },
            })
            expect(svgExec.status).toBe("completed")
            expect(svgExec.output.kind).toBe("svg")
            expect(svgExec.output.content).toBe(svgContent)

            // 3. Mermaid artifact
            const mermaidContent = `flowchart TD
  Start --> Stop`
            const mermaidExec = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call_art_mmd",
                name: "render_artifact",
                input: {
                  kind: "mermaid",
                  title: "Simple Flowchart",
                  content: mermaidContent,
                },
              },
            })
            expect(mermaidExec.status).toBe("completed")
            expect(mermaidExec.output.kind).toBe("mermaid")
            expect(mermaidExec.output.content).toBe(mermaidContent)

            // 4. Oversized content rejection (> 256KB)
            const oversized = "x".repeat(MAX_ARTIFACT_BYTES + 10)
            const overExec = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call_art_over",
                name: "render_artifact",
                input: {
                  kind: "markdown",
                  title: "Too Large",
                  content: oversized,
                },
              },
            })
            expect(overExec.status).toBe("error")
            expect(overExec.error?.message).toContain("Artifact content too large")
          }),
        ),
      )
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })
})
