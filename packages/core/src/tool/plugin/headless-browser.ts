export * as HeadlessBrowserTool from "./headless-browser.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import fs from "fs"
import path from "path"
import dns from "node:dns"
import { spawn, type ChildProcess } from "node:child_process"
import { Permission } from "../../permission.js"
import { NonNegativeInt, PositiveInt, optional } from "../../schema.js"

export const name = "headless_browser"

// -----------------------------------------------------------------------------
// SSRF & URL Safety Validation
// -----------------------------------------------------------------------------

export function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0"
}

export function isPrivateOrBlockedIp(ip: string): boolean {
  const cleanIp = ip.toLowerCase().replace(/^::ffff:/, "")

  const ipv4Parts = cleanIp.split(".")
  if (ipv4Parts.length === 4 && ipv4Parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255)) {
    const [b0, b1, b2] = ipv4Parts.map(Number) as [number, number, number, number]
    // 0.0.0.0/8
    if (b0 === 0) return true
    // 10.0.0.0/8
    if (b0 === 10) return true
    // 127.0.0.0/8
    if (b0 === 127) return true
    // 100.64.0.0/10
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true
    // 169.254.0.0/16
    if (b0 === 169 && b1 === 254) return true
    // 172.16.0.0/12
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true
    // 192.168.0.0/16
    if (b0 === 192 && b1 === 168) return true
    // 192.0.0.0/24 or 192.0.2.0/24
    if (b0 === 192 && b1 === 0 && (b2 === 0 || b2 === 2)) return true
    // 198.51.100.0/24
    if (b0 === 198 && b1 === 51 && b2 === 100) return true
    // 203.0.113.0/24
    if (b0 === 203 && b1 === 0 && b2 === 113) return true
    // 224.0.0.0/4 (multicast) & 240.0.0.0/4 (reserved)
    if (b0 >= 224) return true
    return false
  }

  const cleanV6 = cleanIp.replace(/^\[|\]$/g, "")
  if (cleanV6 === "::1" || cleanV6 === "0:0:0:0:0:0:0:1" || cleanV6 === "::") return true
  // fe80::/10 link-local
  if (/^fe[89ab][0-9a-f]:/i.test(cleanV6) || cleanV6.startsWith("fe80:")) return true
  // fc00::/7 unique local (fc00:*, fd00:*)
  if (/^f[cd][0-9a-f]{2}:/i.test(cleanV6) || cleanV6.startsWith("fc00:") || cleanV6.startsWith("fd00:")) return true
  if (cleanV6.startsWith("::ffff:")) return isPrivateOrBlockedIp(cleanV6.substring(7))

  return false
}

export async function assertSafeBrowserUrl(rawUrl: string, allowLocalhost = false): Promise<URL> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`)
  }

  const protocol = parsed.protocol.toLowerCase()
  if (protocol !== "https:") {
    if (allowLocalhost && protocol === "http:" && isLocalHostname(parsed.hostname)) {
      // Allowed for local debugging if explicitly requested
    } else {
      throw new Error(`SSRF blocked: URL scheme '${protocol}' is not allowed. Only HTTPS is permitted.`)
    }
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (isLocalHostname(hostname)) {
    if (!allowLocalhost) {
      throw new Error(`SSRF blocked: Access to localhost or loopback address is denied (${hostname})`)
    }
    return parsed
  }

  if (isPrivateOrBlockedIp(hostname)) {
    throw new Error(`SSRF blocked: Access to private or reserved IP address is denied (${hostname})`)
  }

  try {
    const addresses = await dns.promises.lookup(hostname, { all: true })
    for (const item of addresses) {
      if (isLocalHostname(item.address) || isPrivateOrBlockedIp(item.address)) {
        throw new Error(`SSRF blocked: Hostname '${hostname}' resolved to private/loopback IP ${item.address}`)
      }
    }
  } catch (err: any) {
    if (err.message.startsWith("SSRF blocked:")) throw err
    throw new Error(`SSRF blocked: Unable to resolve hostname '${hostname}': ${err.message}`)
  }

  return parsed
}

// -----------------------------------------------------------------------------
// Chromium Discovery
// -----------------------------------------------------------------------------

export function findChromiumExecutable(): string {
  if (process.env.OPENCODE_BROWSER_EXECUTABLE && fs.existsSync(process.env.OPENCODE_BROWSER_EXECUTABLE)) {
    return process.env.OPENCODE_BROWSER_EXECUTABLE
  }

  const aquanoxPath =
    "/usr/local/share/aquanox-browsers/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell"
  if (fs.existsSync(aquanoxPath)) {
    return aquanoxPath
  }

  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }

  for (const name of ["chromium", "chromium-browser", "google-chrome"]) {
    for (const dir of (process.env.PATH ?? "").split(":")) {
      const p = path.join(dir, name)
      if (fs.existsSync(p)) return p
    }
  }

  throw new Error("No Chromium or chrome-headless-shell executable found on host.")
}

// -----------------------------------------------------------------------------
// CDP over Pipes Client
// -----------------------------------------------------------------------------

class PipeCdpClient {
  private child: ChildProcess
  private pipeWrite: NodeJS.WritableStream
  private pipeRead: NodeJS.ReadableStream
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private pending = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>()
  private listeners = new Map<string, ((params: any, sessionId?: string) => void)[]>()

  constructor(executable: string) {
    this.child = spawn(
      executable,
      [
        "--headless",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-zygote",
        "--remote-debugging-pipe",
      ],
      {
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
      },
    )

    const stdio = this.child.stdio as any[]
    this.pipeWrite = stdio[3]
    this.pipeRead = stdio[4]

    this.pipeRead.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      let idx: number
      while ((idx = this.buffer.indexOf(0)) !== -1) {
        const raw = this.buffer.subarray(0, idx).toString("utf8")
        this.buffer = this.buffer.subarray(idx + 1)
        try {
          const msg = JSON.parse(raw)
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id)!
            this.pending.delete(msg.id)
            if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
            else resolve(msg.result)
          } else if (msg.method) {
            const handlers = this.listeners.get(msg.method)
            if (handlers) {
              for (const h of handlers) {
                h(msg.params, msg.sessionId)
              }
            }
          }
        } catch {
          // JSON parse error
        }
      }
    })
  }

  send(method: string, params: Record<string, any> = {}, sessionId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      const payload: Record<string, any> = { id, method, params }
      if (sessionId) payload.sessionId = sessionId
      this.pipeWrite.write(JSON.stringify(payload) + "\0")
    })
  }

  on(event: string, callback: (params: any, sessionId?: string) => void) {
    const list = this.listeners.get(event) ?? []
    list.push(callback)
    this.listeners.set(event, list)
  }

  close() {
    try {
      this.child.kill("SIGKILL")
    } catch {
      // ignore
    }
  }
}

// -----------------------------------------------------------------------------
// Schema Definitions
// -----------------------------------------------------------------------------

const ActionSchema = Schema.Literals(["navigate", "render_html", "extract"])
export type Action = typeof ActionSchema.Type

export const Viewport = Schema.Struct({
  width: PositiveInt,
  height: PositiveInt,
})
export type Viewport = typeof Viewport.Type

export const BrowserStep = Schema.Struct({
  type: Schema.Literals(["click", "fill", "press", "evaluate", "wait_for"]),
  selector: Schema.String.pipe(optional),
  value: Schema.String.pipe(optional),
  expression: Schema.String.pipe(optional),
})
export type BrowserStep = typeof BrowserStep.Type

export const Input = Schema.Struct({
  action: ActionSchema.annotate({
    description: "Action to perform: 'navigate' (browse a URL), 'render_html' (render self-contained HTML/SVG sandbox), or 'extract' (DOM metrics & text extraction).",
  }),
  url: Schema.String.annotate({
    description: "Target URL (must be HTTPS; private/loopback/cloud metadata IPs are strictly blocked).",
  }).pipe(optional),
  html: Schema.String.annotate({
    description: "Self-contained HTML or SVG string for 'render_html'. External network requests are 100% blocked.",
  }).pipe(optional),
  viewport: Viewport.annotate({
    description: "Browser viewport dimensions (default: 1280x800).",
  }).pipe(optional),
  waitMs: NonNegativeInt.annotate({
    description: "Milliseconds to wait after navigation/rendering (0-10000, default 500).",
  }).pipe(optional),
  steps: Schema.Array(BrowserStep).annotate({
    description: "Optional interaction steps: click, fill, press, evaluate, or wait_for.",
  }).pipe(optional),
  screenshot: Schema.Boolean.annotate({
    description: "Whether to capture a PNG screenshot returned as vision multimodal content (default: true).",
  }).pipe(optional),
  fullPage: Schema.Boolean.annotate({
    description: "Whether screenshot should capture the entire scrollable page height (default: false).",
  }).pipe(optional),
})
export type Input = typeof Input.Type

export const InteractiveElement = Schema.Struct({
  tag: Schema.String,
  role: Schema.String.pipe(optional),
  text: Schema.String.pipe(optional),
  selector: Schema.String,
  href: Schema.String.pipe(optional),
})
export type InteractiveElement = typeof InteractiveElement.Type

export const HeadingItem = Schema.Struct({
  level: Schema.Number,
  text: Schema.String,
})
export type HeadingItem = typeof HeadingItem.Type

export const Output = Schema.Struct({
  action: ActionSchema,
  url: Schema.String,
  title: Schema.String,
  textPreview: Schema.String,
  headings: Schema.Array(HeadingItem),
  interactiveElements: Schema.Array(InteractiveElement),
  consoleErrors: Schema.Array(Schema.String),
  screenshotCaptured: Schema.Boolean,
})
export type Output = typeof Output.Type

// -----------------------------------------------------------------------------
// Plugin Implementation
// -----------------------------------------------------------------------------

export const Plugin = {
  id: "opencode.tool.headless_browser",
  effect: Effect.fn("HeadlessBrowserTool.Plugin")(function* (ctx: Context) {
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description:
            "Air-gapped and secure Chromium headless browser tool powered by chrome-headless-shell and bidirectional CDP pipes. Features comprehensive SSRF protection, interactive UI actions, console exception capture, and high-fidelity PNG screenshots for vision models.",
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = { type: "tool" as const, messageID: context.messageID, id: context.id }
              const resource = input.url ?? "browser://html"

              yield* permission.assert({
                action: name,
                resources: [resource],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })

              if (input.action === "navigate" || input.action === "extract") {
                if (!input.url) {
                  return yield* new ToolFailure({ message: `url is required for browser action '${input.action}'` })
                }
                yield* Effect.tryPromise({
                  try: () => assertSafeBrowserUrl(input.url!, false),
                  catch: (err) => new ToolFailure({ message: err instanceof Error ? err.message : String(err) }),
                })
              }

              if (input.action === "render_html") {
                if (!input.html || input.html.trim().length === 0) {
                  return yield* new ToolFailure({ message: "html string is required for action 'render_html'" })
                }
              }

              const executable = findChromiumExecutable()
              const client = new PipeCdpClient(executable)

              try {
                const { targetId } = yield* Effect.tryPromise({
                  try: () => client.send("Target.createTarget", { url: "about:blank" }),
                  catch: (err) => new ToolFailure({ message: `Failed to create browser target: ${String(err)}` }),
                })

                const { sessionId } = yield* Effect.tryPromise({
                  try: () => client.send("Target.attachToTarget", { targetId, flatten: true }),
                  catch: (err) => new ToolFailure({ message: `Failed to attach to target: ${String(err)}` }),
                })

                yield* Effect.tryPromise(() => client.send("Page.enable", {}, sessionId))
                yield* Effect.tryPromise(() => client.send("Runtime.enable", {}, sessionId))
                yield* Effect.tryPromise(() => client.send("Log.enable", {}, sessionId))
                yield* Effect.tryPromise(() =>
                  client.send("Fetch.enable", { patterns: [{ requestStage: "Request" }] }, sessionId),
                )

                const vpWidth = input.viewport?.width ?? 1280
                const vpHeight = input.viewport?.height ?? 800
                yield* Effect.tryPromise(() =>
                  client.send(
                    "Emulation.setDeviceMetricsOverride",
                    {
                      width: vpWidth,
                      height: vpHeight,
                      deviceScaleFactor: 1,
                      mobile: false,
                    },
                    sessionId,
                  ),
                )

                // Intercept Fetch requests
                client.on("Fetch.requestPaused", async (params, sId) => {
                  const reqUrl = params.request.url as string
                  const sid = sId || sessionId

                  if (input.action === "render_html") {
                    // Abort all network requests to guarantee 100% air-gapped sandboxing
                    if (
                      !reqUrl.startsWith("data:") &&
                      !reqUrl.startsWith("blob:") &&
                      !reqUrl.startsWith("about:")
                    ) {
                      await client.send(
                        "Fetch.failRequest",
                        { requestId: params.requestId, errorReason: "BlockedByClient" },
                        sid,
                      )
                      return
                    }
                  } else {
                    // Navigate / extract: enforce SSRF rules on redirects and subresources
                    if (
                      !reqUrl.startsWith("data:") &&
                      !reqUrl.startsWith("blob:") &&
                      !reqUrl.startsWith("about:")
                    ) {
                      try {
                        await assertSafeBrowserUrl(reqUrl, false)
                      } catch {
                        await client.send(
                          "Fetch.failRequest",
                          { requestId: params.requestId, errorReason: "BlockedByClient" },
                          sid,
                        )
                        return
                      }
                    }
                  }

                  try {
                    await client.send("Fetch.continueRequest", { requestId: params.requestId }, sid)
                  } catch {
                    // ignore if already handled
                  }
                })

                const consoleErrors: string[] = []
                client.on("Runtime.consoleAPICalled", (params) => {
                  if (params.type === "error" || params.type === "warning") {
                    const msg = params.args.map((a: any) => a.value ?? a.description ?? JSON.stringify(a)).join(" ")
                    consoleErrors.push(`[console.${params.type}] ${msg}`)
                  }
                })
                client.on("Runtime.exceptionThrown", (params) => {
                  const text =
                    params.exceptionDetails?.text ??
                    params.exceptionDetails?.exception?.description ??
                    "Uncaught exception"
                  consoleErrors.push(`[uncaught exception] ${text}`)
                })

                // Load content
                if (input.action === "render_html") {
                  const { frameTree } = yield* Effect.tryPromise(() =>
                    client.send("Page.getResourceTree", {}, sessionId),
                  )
                  const frameId = frameTree.frame.id
                  yield* Effect.tryPromise(() =>
                    client.send(
                      "Page.setDocumentContent",
                      {
                        frameId,
                        html: input.html!,
                      },
                      sessionId,
                    ),
                  )
                } else if (input.action === "navigate" || input.action === "extract") {
                  yield* Effect.tryPromise(() =>
                    client.send(
                      "Page.navigate",
                      {
                        url: input.url!,
                      },
                      sessionId,
                    ),
                  )
                }

                const waitMs = Math.min(10000, Math.max(0, input.waitMs ?? 500))
                if (waitMs > 0) {
                  yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, waitMs)))
                }

                // Execute interaction steps
                if (input.steps && input.steps.length > 0) {
                  for (const step of input.steps) {
                    if (step.type === "click" && step.selector) {
                      yield* Effect.tryPromise(() =>
                        client.send(
                          "Runtime.evaluate",
                          {
                            expression: `(() => {
                              const el = document.querySelector(${JSON.stringify(step.selector)});
                              if (!el) throw new Error("Element not found for click: " + ${JSON.stringify(step.selector)});
                              el.click();
                            })()`,
                          },
                          sessionId,
                        ),
                      )
                    } else if (step.type === "fill" && step.selector) {
                      yield* Effect.tryPromise(() =>
                        client.send(
                          "Runtime.evaluate",
                          {
                            expression: `(() => {
                              const el = document.querySelector(${JSON.stringify(step.selector)});
                              if (!el) throw new Error("Element not found for fill: " + ${JSON.stringify(step.selector)});
                              el.value = ${JSON.stringify(step.value ?? "")};
                              el.dispatchEvent(new Event("input", { bubbles: true }));
                              el.dispatchEvent(new Event("change", { bubbles: true }));
                            })()`,
                          },
                          sessionId,
                        ),
                      )
                    } else if (step.type === "press") {
                      yield* Effect.tryPromise(() =>
                        client.send(
                          "Runtime.evaluate",
                          {
                            expression: `(() => {
                              const el = ${step.selector ? `document.querySelector(${JSON.stringify(step.selector)})` : "document.activeElement"};
                              if (el) {
                                const key = ${JSON.stringify(step.value ?? "Enter")};
                                el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
                                el.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
                              }
                            })()`,
                          },
                          sessionId,
                        ),
                      )
                    } else if (step.type === "evaluate" && step.expression) {
                      yield* Effect.tryPromise(() =>
                        client.send(
                          "Runtime.evaluate",
                          {
                            expression: step.expression!,
                          },
                          sessionId,
                        ),
                      )
                    } else if (step.type === "wait_for" && step.selector) {
                      yield* Effect.tryPromise(() =>
                        client.send(
                          "Runtime.evaluate",
                          {
                            awaitPromise: true,
                            expression: `new Promise((resolve) => {
                              const start = Date.now();
                              const check = () => {
                                if (document.querySelector(${JSON.stringify(step.selector)})) return resolve(true);
                                if (Date.now() - start > 5000) return resolve(false);
                                setTimeout(check, 50);
                              };
                              check();
                            })`,
                          },
                          sessionId,
                        ),
                      )
                    }
                  }
                }

                // Extract DOM information
                const extractRes = yield* Effect.tryPromise(() =>
                  client.send(
                    "Runtime.evaluate",
                    {
                      returnByValue: true,
                      expression: `(() => {
                        const title = document.title || "";
                        const url = window.location.href || "";
                        const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
                          .map(h => ({ level: parseInt(h.tagName.substring(1), 10), text: (h.innerText || "").trim() }))
                          .filter(h => h.text.length > 0)
                          .slice(0, 30);
                        const textPreview = document.body ? (document.body.innerText || "").slice(0, 4000).trim() : "";
                        const interactiveElements = Array.from(document.querySelectorAll("button, a, input, select, textarea, [role='button']"))
                          .slice(0, 50)
                          .map(el => {
                            let selector = el.id ? "#" + el.id : el.className && typeof el.className === "string" ? el.tagName.toLowerCase() + "." + el.className.split(" ").filter(Boolean).slice(0, 2).join(".") : el.tagName.toLowerCase();
                            let text = (el.innerText || el.value || el.getAttribute("placeholder") || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim().slice(0, 100);
                            return {
                              tag: el.tagName.toLowerCase(),
                              role: el.getAttribute("role") || undefined,
                              text: text || undefined,
                              selector,
                              href: el.getAttribute("href") || undefined
                            };
                          });
                        return { title, url, headings, textPreview, interactiveElements };
                      })()`,
                    },
                    sessionId,
                  ),
                )

                const extracted = extractRes.result.value ?? {
                  title: "",
                  url: input.url ?? "about:blank",
                  headings: [],
                  textPreview: "",
                  interactiveElements: [],
                }

                // Screenshot
                let screenshotBase64: string | undefined
                if (input.screenshot !== false) {
                  const shot = yield* Effect.tryPromise(() =>
                    client.send(
                      "Page.captureScreenshot",
                      {
                        format: "png",
                        captureBeyondViewport: Boolean(input.fullPage),
                      },
                      sessionId,
                    ),
                  )
                  screenshotBase64 = shot.data
                }

                const out: Output = {
                  action: input.action,
                  url: extracted.url || (input.url ?? "about:blank"),
                  title: extracted.title,
                  textPreview: extracted.textPreview,
                  headings: extracted.headings,
                  interactiveElements: extracted.interactiveElements,
                  consoleErrors,
                  screenshotCaptured: Boolean(screenshotBase64),
                }

                const lines = [
                  `### Headless Browser: ${input.action.toUpperCase()} ${out.title ? `— "${out.title}"` : ""}`,
                  `URL: ${out.url}`,
                  ...(out.headings.length > 0
                    ? ["\n#### Headings:", ...out.headings.map((h) => `${"#".repeat(h.level)} ${h.text}`)]
                    : []),
                  ...(out.interactiveElements.length > 0
                    ? [
                        "\n#### Interactive Elements:",
                        ...out.interactiveElements
                          .slice(0, 20)
                          .map(
                            (el) =>
                              `- \`<${el.tag}>\` \`${el.selector}\`${el.text ? `: "${el.text}"` : ""}${el.href ? ` (${el.href})` : ""}`,
                          ),
                      ]
                    : []),
                  ...(consoleErrors.length > 0
                    ? ["\n#### Console Errors / Warnings:", ...consoleErrors.map((e) => `- ${e}`)]
                    : []),
                  ...(out.textPreview ? ["\n#### Text Preview:", out.textPreview] : []),
                ]

                const content: any[] = [{ type: "text", text: lines.join("\n") }]
                if (screenshotBase64) {
                  content.push({
                    type: "file",
                    uri: `data:image/png;base64,${screenshotBase64}`,
                    mime: "image/png",
                    name: "browser-screenshot.png",
                  })
                }

                return {
                  output: out,
                  content,
                  metadata: {
                    title: out.title,
                    url: out.url,
                    screenshotCaptured: out.screenshotCaptured,
                    consoleErrorsCount: consoleErrors.length,
                  },
                }
              } finally {
                client.close()
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({
                      message: `Browser operation failed: ${error instanceof Error ? error.message : String(error)}`,
                      error,
                    }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
