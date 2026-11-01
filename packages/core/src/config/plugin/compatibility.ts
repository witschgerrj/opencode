export * as ConfigCompatibilityPlugin from "./compatibility.js"

import { define } from "@opencode/plugin/effect/plugin"
import { FSUtil } from "@opencode/util/fs-util"
import path from "path"
import { Effect, FiberMap, PubSub, Semaphore, Stream } from "effect"
import { Config } from "../../config.js"
import { Watcher } from "../../filesystem/watcher.js"
import { Skill } from "../../skill.js"
import { SkillFile } from "./skill-file.js"
import { SkillScan } from "./skill-scan.js"
import { Agent } from "../../agent.js"
import { ConfigAgentPlugin } from "./agent.js"
import type { ConfigAgent } from "@opencode/schema/config/agent"
import { Global } from "@opencode/util/global" 

export const Plugin = define({
  id: "opencode.config.compatibility",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const watcher = yield* Watcher.Service
    const watches = yield* FiberMap.make<string>()
    const changes = yield* PubSub.sliding<string>(1)
    const lock = Semaphore.makeUnsafe(1)
    const skills: Skill.Info[] = []
    const agents = new Map<Agent.ID, ConfigAgent.Info>()
    const compatibility = () =>
      config.compatibility ? config.compatibility() : Effect.succeed({ claude: [], agents: [] })

    const watch = Effect.fn("ConfigCompatibilityPlugin.watch")(function* (
      target: string,
      type: "file" | "directory",
    ) {
      const updates = yield* watcher.subscribe(
        type === "directory" ? { path: target, type, ignore: SkillScan.ignore } : { path: target, type },
      )
      yield* FiberMap.run(
        watches,
        `${type}:${target}`,
        updates.pipe(Stream.runForEach((update) => PubSub.publish(changes, update.path).pipe(Effect.asVoid))),
        { onlyIfMissing: true, startImmediately: true },
      )
    })

    const refresh = Effect.fn("ConfigCompatibilityPlugin.refresh")(
      function* () {
        yield* FiberMap.clear(watches)
        const roots = yield* compatibility()
        const directories = [...roots.claude, ...roots.agents].map((root) => path.join(root, "skills"))
        const loaded = new Map<Skill.ID, Skill.Info>()
        for (const directory of directories) {
          const resolved = yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => undefined))
          if (!resolved) continue
          yield* watch(resolved, "directory")
          for (const filepath of yield* SkillScan.scan(resolved)) {
            const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.orElseSucceed(() => undefined))
            if (!content) continue
            const parsed = SkillFile.parse(resolved, filepath, content)
            if (parsed._tag === "Parsed") loaded.set(parsed.skill.id, parsed.skill)
          }
        }
        skills.splice(0, skills.length, ...loaded.values())

        const agentDirectories = [...roots.claude, ...roots.agents].map((root) => path.join(root, "agents"))
        const loadedAgents = new Map<Agent.ID, ConfigAgent.Info>()
        for (const directory of agentDirectories) {
          const resolved = yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => undefined))
          if (!resolved) continue
          yield* watch(resolved, "directory")
          const files = yield* fs
            .scan("{*.md,*/*.md}", { cwd: resolved, absolute: true, dot: true, symlink: true })
            .pipe(Effect.orElseSucceed(() => []))
          for (const filepath of files) {
            const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.orElseSucceed(() => undefined))
            if (!content) continue
            const document = yield* ConfigAgentPlugin.decode({ directory: resolved, filepath, primary: false }, content)
            if (!document) continue
            for (const [name, info] of Object.entries(document.info.agents ?? {})) {
              if (!info.disabled) {
                loadedAgents.set(Agent.ID.make(name), info)
              }
            }
          }
        }
        agents.clear()
        for (const [id, info] of loadedAgents) {
          agents.set(id, info)
        }
      },
      (effect) => lock.withPermit(effect),
    )

    let agentTransformRegistered = false
    const registerAgentTransform = Effect.gen(function* () {
      if (agentTransformRegistered || agents.size === 0) return
      agentTransformRegistered = true
      yield* ctx.agent.transform((editor) => {
        for (const [id, item] of agents) {
          if (editor.get(id) !== undefined) continue
          editor.update(id, (agent) => {
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
            if (item.permissions !== undefined) {
              agent.permissions.push(...ConfigAgentPlugin.expandPermissions(item.permissions, Global.Path.home))
            }
          })
        }
      })
    })

    const reload = refresh().pipe(
      Effect.andThen(registerAgentTransform),
      Effect.andThen(ctx.skill.reload()),
      Effect.andThen(Effect.suspend(() => (agentTransformRegistered ? ctx.agent.reload() : Effect.void))),
    )
    const updates = yield* PubSub.subscribe(changes)
    yield* Stream.fromSubscription(updates).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach(() => reload),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* config.changes().pipe(
      Stream.filterEffect((update) =>
        Effect.map(compatibility(), (roots) => isCompatibilitySource(roots, update.path)),
      ),
      Stream.runForEach((update) => PubSub.publish(changes, update.path).pipe(Effect.asVoid)),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* refresh()
    yield* ctx.skill.transform((editor) => {
      for (const skill of skills) editor.add(skill)
    })
    yield* registerAgentTransform
  }),
})

const sourceDirectories = [".claude", ".agents"] as const

function isCompatibilitySource(
  roots: { readonly claude: readonly string[]; readonly agents: readonly string[] },
  file: string,
) {
  return (
    sourceDirectories.some((name) => path.basename(file) === name) ||
    [...roots.claude, ...roots.agents].some((root) => FSUtil.contains(root, file))
  )
}
