export * as ConfigAgentPlugin from "./agent.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Document, Info, type Entry } from "@opencode/schema/config"
import { ConfigAgent } from "@opencode/schema/config/agent"
import path from "path"
import { Effect, Option, PubSub, Schema, Stream } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { ConfigMarkdown } from "../markdown.js"
import { FSUtil } from "@opencode/util/fs-util"
import { ConfigAgentV1 } from "../../v1/config/agent.js"
import { ConfigMigrateV1 } from "../../v1/config/migrate.js"
import { Global } from "@opencode/util/global"
import { Permission } from "../../permission.js"
import type { FileAccess } from "../../file-access.js"
import type { ReadTool } from "../../tool/plugin/read.js"
import type { EditTool } from "../../tool/plugin/edit.js"
import { AbsolutePath } from "../../schema.js"

const legacySources = [
  { pattern: "{agent,agents}/**/*.md", primary: false },
  { pattern: "{mode,modes}/*.md", primary: true },
] as const
// Keep in sync with the legacySources patterns and the name-strip regex in decode.
const sourceDirectories = ["agent", "agents", "mode", "modes"] as const
const decodeAgent = Schema.decodeUnknownOption(ConfigAgent.Info)
const decodeLegacyAgent = Schema.decodeUnknownOption(ConfigAgentV1.Info)
type PathAction = FileAccess.ExternalDirectoryAuthorization["action"] | typeof ReadTool.name | typeof EditTool.name
const pathActions = ["external_directory", "read", "edit"] as const satisfies readonly PathAction[]
const agentKeys = new Set(["variant", ...Object.keys(ConfigAgent.Info.fields)])
// Fields only V2 understands. A file that uses any of them is read as V2, whatever else it contains.
const nativeKeys = ["permissions", "request", "system", "disabled"]

export const Plugin = define({
  id: "opencode.config.agent",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const loadEntry = Effect.fnUntraced(function* (entry: Entry) {
      if (entry.type === "document") return [entry]
      if (entry.type !== "directory") return []
      const files = yield* discover(fs, entry.path)
      return yield* Effect.forEach(files, (file) =>
        fs.readFileStringSafe(file.filepath).pipe(
          Effect.flatMap((content) => (content ? decode(file, content) : Effect.succeed(undefined))),
          Effect.orElseSucceed(() => undefined),
        ),
      ).pipe(Effect.map((documents) => documents.filter((document): document is Document => document !== undefined)))
    })
    const load = Effect.fn("ConfigAgentPlugin.load")(function* () {
      return yield* Effect.forEach(yield* config.entries(), loadEntry).pipe(Effect.map((documents) => documents.flat()))
    })
    const loaded = { documents: [] as Document[] }
    const reload = load().pipe(
      Effect.tap((documents) => Effect.sync(() => (loaded.documents = documents))),
      Effect.andThen(ctx.agent.reload()),
    )
    // One trigger feed serializes reloads and shares one debounce window;
    // subscribing before the initial scan means updates racing the scan still
    // trigger a rebuild. Each source is subscribed eagerly on its own fiber
    // (Stream.merge and Stream.debounce both open upstream a fiber hop later)
    // so no update slips through while the debounce starts its pull.
    const changes = yield* PubSub.sliding<void>(1)
    const notify = () => PubSub.publish(changes, undefined)
    yield* config.changes().pipe(
      Stream.filterEffect((update) => Effect.map(config.entries(), (entries) => isAgentSource(entries, update.path))),
      Stream.runForEach(notify),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* ctx.event
      .subscribe({ types: ["config.updated"] })
      .pipe(Stream.runForEach(notify), Effect.forkScoped({ startImmediately: true }))
    const updates = yield* PubSub.subscribe(changes)
    yield* Stream.fromSubscription(updates).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach(() => reload),
      Effect.forkScoped({ startImmediately: true }),
    )
    loaded.documents = yield* load()
    yield* ctx.agent.transform((editor) => {
      const permissions = expandPermissions(
        loaded.documents.flatMap((document) => document.info.permissions ?? []),
        global.home,
      )
      const configuredDefault = Config.latest(loaded.documents, "default_agent")
      if (configuredDefault !== undefined) editor.default(Agent.ID.make(configuredDefault))
      for (const current of editor.list()) {
        editor.update(current.id, (agent) => agent.permissions.push(...permissions))
      }

      for (const document of loaded.documents) {
        for (const [id, item] of Object.entries(document.info.agents ?? {})) {
          const agentID = Agent.ID.make(id)
          if (item.disabled) {
            editor.remove(agentID)
            continue
          }

          const exists = editor.get(agentID) !== undefined
          editor.update(agentID, (agent) => {
            if (!exists) agent.permissions.push(...permissions)
            if (item.model !== undefined)
              agent.model = {
                id: item.model.model,
                providerID: item.model.providerID,
                ...(item.model.variant === undefined ? {} : { variant: item.model.variant }),
              }
            if (item.request !== undefined) {
              Object.assign(agent.request.headers, item.request.headers ?? {})
              Object.assign(agent.request.body, item.request.body ?? {})
            }
            if (item.system !== undefined) agent.system = item.system
            if (item.description !== undefined) agent.description = item.description
            if (item.mode !== undefined) agent.mode = item.mode
            if (item.hidden !== undefined) agent.hidden = item.hidden
            if (item.color !== undefined) agent.color = item.color
            if (item.steps !== undefined) agent.steps = item.steps
            if (item.resources !== undefined) agent.resources = item.resources
            if (item.permissions !== undefined) {
              agent.permissions.push(...expandPermissions(item.permissions, global.home))
            }
          })
        }
      }
    })
  }),
})

// Matches anything at or under <root>/{agent,agents,mode,modes}. No file-suffix
// check: directory-level events such as renames carry no per-file paths.
function isAgentSource(entries: Entry[], file: string) {
  return entries.some(
    (entry) =>
      entry.type === "directory" &&
      sourceDirectories.some((name) => FSUtil.contains(path.join(entry.path, name), file)),
  )
}

export function expandPermissions(rules: Permission.Ruleset, home: string): Permission.Ruleset {
  // Expand only resources tools resolve as filesystem paths. Bash resources are raw shell text:
  // rewriting `$HOME/private/**` would miss `$HOME/private/key`, and safe expansion needs shell-aware parsing.
  return rules.map((rule) =>
    isPathAction(rule.action) ? { ...rule, resource: expandHome(rule.resource, home) } : rule,
  )
}

function isPathAction(action: string): action is PathAction {
  return pathActions.some((item) => item === action)
}

function expandHome(resource: string, home: string) {
  if (resource === "~" || resource === "$HOME") return home
  const relative = resource.startsWith("~/")
    ? resource.slice(2)
    : resource.startsWith("$HOME/") || resource.startsWith("$HOME\\")
      ? resource.slice(6)
      : undefined
  if (relative !== undefined) return (path.posix.isAbsolute(home) ? path.posix : path.win32).join(home, relative)
  return resource
}

function discover(fs: FSUtil.Interface, directory: string) {
  return Effect.forEach(legacySources, (source) =>
    fs
      .scan(source.pattern, { cwd: directory, absolute: true, dot: true, symlink: true })
      .pipe(
        Effect.map((files) => files.toSorted().map((filepath) => ({ directory, filepath, primary: source.primary }))),
      ),
  ).pipe(
    Effect.map((files) => files.flat()),
    Effect.orElseSucceed(() => []),
  )
}

const toolMapping: Record<string, readonly string[]> = {
  run_command: ["shell"],
  bash: ["shell"],
  shell: ["shell"],
  view_file: ["read"],
  read: ["read"],
  write_file: ["write"],
  write: ["write"],
  edit_file: ["edit", "patch"],
  edit: ["edit", "patch"],
  patch: ["patch"],
  invoke_subagent: ["subagent"],
  subagent: ["subagent"],
  search_web: ["websearch"],
  websearch: ["websearch"],
  read_url_content: ["webfetch"],
  webfetch: ["webfetch"],
  send_message: ["send_message"],
  manage_task: ["manage_task"],
  schedule: ["schedule"],
  inspect_system_resources: ["inspect_system_resources"],
}

const standardAutonomousTools: readonly string[] = [
  "skill",
  "lsp",
  "memory",
  "headless_browser",
  "render_artifact",
  "request_synthesis",
  "inspect_system_resources",
  "snapshot",
  "external_directory",
]

export function translateToolsArrayToRuleset(tools: readonly string[]): Permission.Ruleset {
  const allowedActions = new Set<string>()
  for (const tool of tools) {
    const mapped = toolMapping[tool]
    if (mapped) {
      for (const action of mapped) allowedActions.add(action)
    } else {
      allowedActions.add(tool)
    }
  }

  const rules: Permission.Rule[] = []
  for (const action of allowedActions) {
    rules.push({ action, resource: "*", effect: "allow" })
  }
  for (const action of standardAutonomousTools) {
    if (!allowedActions.has(action)) {
      rules.push({ action, resource: "*", effect: "allow" })
    }
  }

  const hasShell = tools.includes("run_command") || tools.includes("bash") || tools.includes("shell")
  const hasWrite = tools.includes("write_file") || tools.includes("write")
  const hasEdit = tools.includes("edit_file") || tools.includes("edit")

  if (!hasShell) {
    rules.push({ action: "shell", resource: "*", effect: "deny" })
  }
  if (!hasWrite) {
    rules.push({ action: "write", resource: "*", effect: "deny" })
  }
  if (!hasEdit) {
    rules.push({ action: "edit", resource: "*", effect: "deny" })
    rules.push({ action: "patch", resource: "*", effect: "deny" })
  }

  return rules
}

const ignoredExtraKeys = new Set(["name", "inheritCustomizations", "inheritMcp"])

export const decode = Effect.fnUntraced(function* (
  file: { directory: string; filepath: string; primary: boolean },
  content: string,
) {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return
  const rawRelative = path
    .relative(file.directory, file.filepath)
    .replaceAll("\\", "/")
    .replace(/^(agent|agents|mode|modes)\//i, "")
    .replace(/\.md$/i, "")
  const name = rawRelative.replace(/\/agent$/i, "")
  const body = markdown.content.trim()

  const rawData: Record<string, unknown> = { ...markdown.data }
  if (Array.isArray(rawData.tools)) {
    const toolsList = rawData.tools.filter((t): t is string => typeof t === "string")
    const rules = translateToolsArrayToRuleset(toolsList)
    rawData.permissions = [
      // SAFETY: existing permissions from frontmatter if present
      ...(Array.isArray(rawData.permissions) ? (rawData.permissions as Permission.Ruleset) : []),
      ...rules,
    ]
    delete rawData.tools
  }
  for (const key of ignoredExtraKeys) {
    delete rawData[key]
  }

  const keys = Object.keys(rawData)
  const unsupported = keys.filter((key) => !agentKeys.has(key))
  const legacy = unsupported.length > 0 && !keys.some((key) => nativeKeys.includes(key))
  if (!legacy && unsupported.length > 0)
    yield* Effect.logWarning("ignored unsupported agent fields", { path: file.filepath, fields: unsupported })
  // Join legacy model + variant without sending native request/permissions through migration.
  // Embedded and structured native selections, and a variant without a model, stay unchanged.
  const data =
    typeof rawData.model === "string" &&
    !rawData.model.includes("#") &&
    typeof rawData.variant === "string" &&
    /^[^#]+$/.test(rawData.variant)
      ? { ...rawData, model: `${rawData.model}#${rawData.variant}` }
      : rawData
  const agent = legacy
    ? Option.getOrUndefined(
        Option.map(
          decodeLegacyAgent({ name, ...rawData, prompt: body }, { errors: "all" }),
          ConfigMigrateV1.migrateAgent,
        ),
      )
    : Option.getOrUndefined(decodeAgent({ ...data, system: body }, { errors: "all" }))
  if (!agent) return
  const info = Info.make({
    agents: { [name]: file.primary ? ConfigAgent.Info.make({ ...agent, mode: "primary" }) : agent },
  })
  return new Document({ type: "document", path: AbsolutePath.make(file.filepath), info })
})
