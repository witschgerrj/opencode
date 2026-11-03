export * as SkillInstructions from "./instructions.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { Context, Effect, Layer, Schema } from "effect"
import { Permission } from "../permission.js"
import { Skill } from "../skill.js"
import { Instructions } from "../instructions/index.js"

const Summary = Schema.Struct({
  id: Skill.ID,
  name: Skill.Name,
  description: Schema.String,
})
type Summary = typeof Summary.Type

const entries = (skills: ReadonlyArray<Summary>) =>
  skills.flatMap((skill) => [
    "  <skill>",
    `    <id>${skill.id}</id>`,
    `    <name>${skill.name}</name>`,
    `    <description>${skill.description}</description>`,
    "  </skill>",
  ])

const render = (skills: ReadonlyArray<Summary>) =>
  [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    "The user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the skill tool returns. A skill that is already present this way does not need to be invoked again.",
    ...(skills.length === 0
      ? ["No skills are currently available."]
      : ["<available_skills>", ...entries(skills), "</available_skills>"]),
  ].join("\n")

const update = (previous: ReadonlyArray<Summary>, current: ReadonlyArray<Summary>) => {
  const diff = Instructions.diffByKey(
    previous,
    current,
    (skill) => skill.id,
    (before, after) => before.name !== after.name || before.description !== after.description,
  )
  // Added, changed, and removed skills render as deltas; the full list is restated only when no entry differs.
  if (diff.added.length === 0 && diff.changed.length === 0 && diff.removed.length === 0)
    return [
      "The available skills have changed. This list supersedes the previous available skills list.",
      render(current),
    ].join("\n")
  return [
    ...(diff.added.length === 0
      ? []
      : ["New skills are available in addition to those previously listed:", ...entries(diff.added)]),
    ...(diff.changed.length === 0
      ? []
      : [
          "The following skills have changed. Each entry replaces the previously listed skill with the same ID:",
          ...entries(diff.changed.map((change) => change.current)),
        ]),
    ...(diff.removed.length === 0
      ? []
      : [
          `The following skill IDs are no longer available and must not be used: ${diff.removed.map((skill) => skill.id).join(", ")}.`,
        ]),
  ].join("\n")
}

export const isGlobalOrSystemSkill = (skill: { readonly path?: string; readonly scope?: string }): boolean => {
  if (skill.scope === "global" || skill.scope === "system" || skill.scope === "builtin") return true
  if (skill.scope === "project" || skill.scope === "workspace") return false
  const p = (skill.path ?? "").replaceAll("\\", "/")
  if (!p) return false
  if (
    p.startsWith("/builtin/") ||
    p.startsWith("/etc/opencode/") ||
    p.startsWith("/Library/Application Support/opencode/")
  ) {
    return true
  }
  const home = Global.Path.home.replaceAll("\\", "/").replace(/\/+$/, "")
  const configDir = (process.env.OPENCODE_CONFIG_DIR ?? Global.Path.config).replaceAll("\\", "/").replace(/\/+$/, "")
  const cacheDir = Global.Path.cache.replaceAll("\\", "/").replace(/\/+$/, "")
  if (
    p.startsWith(`${configDir}/`) ||
    p.startsWith(`${cacheDir}/`) ||
    p.startsWith(`${home}/.config/opencode/`) ||
    p.startsWith(`${home}/.agents/`) ||
    p.startsWith(`${home}/.claude/`) ||
    p.includes("/.config/opencode/skill")
  ) {
    return true
  }
  return false
}

export interface Interface {
  /** Lists skills the given ruleset does not deny; callers pass the merged agent and Session permissions. */
  readonly load: (permissions: Permission.Ruleset) => Effect.Effect<Instructions.List>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillInstructions") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skills = yield* Skill.Service

    return Service.of({
      load: Effect.fn("SkillInstructions.load")(function* (permissions) {
        const available = Skill.available(yield* skills.list(), permissions)
          .filter(
            (skill): skill is Skill.Info & { readonly description: string } =>
              skill.description !== undefined && skill.autoinvoke !== false,
          )
          .toSorted((a, b) => {
            const aGlobal = isGlobalOrSystemSkill(a)
            const bGlobal = isGlobalOrSystemSkill(b)
            if (aGlobal !== bGlobal) return aGlobal ? -1 : 1
            return a.id.localeCompare(b.id)
          })
          .map((skill) => ({ id: skill.id, name: skill.name, description: skill.description }))
        return Instructions.make<ReadonlyArray<Summary>>({
          key: Instructions.Key.make("core/skill-guidance"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          read: Effect.succeed(available.length === 0 ? Instructions.removed : available),
          render: {
            initial: render,
            changed: update,
            removed: () => "Skill guidance is no longer available. Do not use any previously listed skill.",
          },
        })
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Skill.node] })
