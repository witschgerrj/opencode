export * as SessionContext from "./context.js"

import { Model } from "../model.js"
import { Permission } from "../permission.js"
import { Context, Effect, Layer, Schema } from "effect"
import { Agent } from "../agent.js"
import { CodeModeInstructions } from "../codemode/instructions.js"
import { Database } from "../database/database.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { Instructions } from "../instructions/index.js"
import { InstructionBuiltIns } from "../instructions/builtins.js"
import { Location } from "../location.js"
import { McpInstructions } from "../mcp/instructions.js"
import { McpTool } from "../tool/mcp.js"
import { ReferenceInstructions } from "../reference/instructions.js"
import { SkillInstructions } from "../skill/instructions.js"
import { Tool } from "../tool.js"
import { AgentNotFoundError } from "./error.js"
import { SessionHistory } from "./history.js"
import { InstructionEntry } from "./instruction-entry.js"
import { SessionMessage } from "./message.js"
import { SessionModelRequest } from "./model-request.js"
import { SessionRunnerModel } from "./runner/model.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"

export interface Selection {
  readonly session: SessionSchema.Info
  readonly agent: Agent.Selection & { readonly info: Agent.Info }
  readonly instructions: Instructions.List
  readonly volatileInstructions?: Instructions.List
  readonly tools: Tool.Snapshot
}

export interface Loaded {
  readonly session: SessionSchema.Info
  readonly agent: Agent.Selection & { readonly info: Agent.Info }
  readonly model: SessionRunnerModel.Resolved
  readonly initial: string
  readonly messages: ReadonlyArray<SessionMessage.Info>
  readonly tools: Tool.Snapshot
}

/**
 * Resolves model-request state in two phases: `select` fixes the Session,
 * agent, instruction sources, and tool snapshot; `load` adds the model and
 * active history for that selection. Auxiliary operations resolve only the
 * capabilities they need; request preparation stays separate from selection.
 */
export interface Interface {
  /** Selects the Session, agent, instructions, and tools used by subsequent work. */
  readonly select: (sessionID: SessionSchema.ID) => Effect.Effect<Selection, AgentNotFoundError>
  /** Resolves the model and active history for that selection. */
  readonly load: (selection: Selection) => Effect.Effect<Loaded, SessionRunnerModel.Error>
  readonly resolveModel: (
    session: SessionSchema.Info,
  ) => Effect.Effect<SessionRunnerModel.Resolved, SessionRunnerModel.Error>
  /** Selects auxiliary title capabilities without instruction or tool preflight. */
  readonly selectTitle: (session: SessionSchema.Info) => Effect.Effect<
    | {
        readonly agent: Agent.Info
        readonly primary: SessionRunnerModel.Resolved | undefined
        readonly selected: SessionRunnerModel.Resolved
      }
    | undefined
  >
  readonly request: SessionModelRequest.Interface
}

/** Location-scoped model-context loader for durable Session Steps. */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionContext") {}

interface EpochReminderState {
  readonly reminderText: string
  readonly initialIsoDate: string
}

const epochReminderCache = new Map<string, EpochReminderState>()
const frozenInitialCache = new Map<string, string>()

export function resetEpochCache(): void {
  epochReminderCache.clear()
  frozenInitialCache.clear()
}

function formatDateIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function parseIsoFromDateValue(val: unknown): string {
  if (typeof val === "string") {
    const d = new Date(val)
    if (!isNaN(d.getTime())) return formatDateIso(d)
  }
  return formatDateIso(new Date())
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const builtins = yield* InstructionBuiltIns.Service
    const model = yield* Model.Service
    const db = (yield* Database.Service).db
    const discovery = yield* InstructionDiscovery.Service
    const entries = yield* InstructionEntry.Service
    const location = yield* Location.Service
    const mcpInstructions = yield* McpInstructions.Service
    const mcpTools = yield* McpTool.Service
    const models = yield* SessionRunnerModel.Service
    const request = yield* SessionModelRequest.Service
    const referenceInstructions = yield* ReferenceInstructions.Service
    const skillInstructions = yield* SkillInstructions.Service
    const store = yield* SessionStore.Service
    const registry = yield* Tool.Service

    const resolveModel = (session: SessionSchema.Info) => models.resolve(session, model.available)

    const selectTitle = Effect.fn("SessionContext.selectTitle")(function* (session: SessionSchema.Info) {
      const agent = yield* agents.get(Agent.ID.make("title"))
      if (!agent) return
      const primary = yield* resolveModel(session).pipe(Effect.orElseSucceed(() => undefined))
      const candidate = yield* Effect.gen(function* () {
        if (agent.model) {
          const info = yield* model.get(agent.model.providerID, agent.model.id)
          return info && { info, variant: agent.model.variant ?? minimalVariant(info) }
        }
        if (!primary) return
        const small = yield* model.small(primary.ref.providerID)
        if (small) return { info: small, variant: minimalVariant(small) }
        // Without a lower variant, the primary model at its selected variant is already the fallback.
        const info = yield* model.get(primary.ref.providerID, primary.ref.id)
        const variant = info && lowerVariant(info, primary.ref.variant)
        return variant && { info, variant }
      })
      const preferred =
        candidate &&
        (yield* resolveModel({
          ...session,
          model: Model.Ref.make({
            providerID: candidate.info.providerID,
            id: candidate.info.id,
            ...(candidate.variant ? { variant: candidate.variant } : {}),
          }),
        }).pipe(Effect.orElseSucceed(() => undefined)))
      const selected = preferred ?? primary
      if (!selected) return
      return { agent, primary, selected }
    })

    const select = Effect.fn("SessionContext.select")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt

      yield* mcpTools.flush
      const agent = yield* agents.select(session.agent)
      if (!agent.info) return yield* new AgentNotFoundError({ sessionID: session.id, agent: session.agent ?? agent.id })
      // Session permissions narrow discovery the same way they narrow the tool snapshot.
      const permissions = Permission.merge(agent.info.permissions, session.permissions ?? [])
      const loaded = yield* Effect.all(
        {
          tools: registry.snapshot(permissions),
          builtins: builtins.load(),
          discovery: discovery.load(),
          skills: skillInstructions.load(permissions),
          references: referenceInstructions.load(),
          mcp: mcpInstructions.load(permissions),
          entries: entries.load(sessionID),
        },
        { concurrency: "unbounded" },
      )
      const isVolatile = (source: Instructions.Source) =>
        source.key === "core/date" || source.key === "core/environment"
      const staticBuiltins = loaded.builtins.filter((s) => !isVolatile(s))
      const volatileBuiltins = loaded.builtins.filter(isVolatile)

      return {
        session,
        agent: { ...agent, info: agent.info },
        // Ordered from most to least shared across sessions so the baseline stays a reusable
        // prompt-cache prefix: user-level catalog and guidance, then project instructions,
        // while volatile date and environment are relocated to the first user message.
        instructions: Instructions.combine([
          CodeModeInstructions.make(loaded.tools.codeModeCatalog),
          loaded.mcp,
          loaded.references,
          loaded.skills,
          loaded.discovery,
          staticBuiltins,
          loaded.entries,
        ]),
        volatileInstructions: volatileBuiltins,
        tools: loaded.tools,
      }
    })

    const load = Effect.fn("SessionContext.load")(function* (selection: Selection) {
      const model = yield* resolveModel(selection.session)
      const history = yield* SessionHistory.entriesForRunner(
        db,
        selection.session.id,
        selection.instructions,
        model.ref,
      )

      // Find first user or synthetic message to anchor the epoch
      const firstUserIndex = history.entries.findIndex(
        (e) => e.message.type === "user" || e.message.type === "synthetic",
      )
      const firstUserEntry = firstUserIndex >= 0 ? history.entries[firstUserIndex] : undefined
      const epochKey = `${selection.session.id}:${firstUserEntry?.message.id ?? "epoch0"}`

      // Prefix invariance: freeze the rendered initial instructions (<｜System｜>) per session epoch
      // so dynamic per-step loaded instructions never mutate <｜System｜> mid-session.
      let initial = frozenInitialCache.get(epochKey)
      if (initial === undefined) {
        initial = history.initial
        frozenInitialCache.set(epochKey, initial)
        if (frozenInitialCache.size > 256) {
          const oldest = frozenInitialCache.keys().next().value
          if (oldest !== undefined) frozenInitialCache.delete(oldest)
        }
      }

      let currentObservedDate: unknown = undefined
      let cachedReminder = epochReminderCache.get(epochKey)
      if (selection.volatileInstructions && selection.volatileInstructions.length > 0) {
        const observed = yield* Instructions.read(selection.volatileInstructions)
        const values: Record<string, Schema.Json> = {}
        for (const entry of observed) {
          if (entry.value !== Instructions.unavailable && entry.value !== Instructions.removed) {
            values[entry.key] = entry.value
            if (entry.key === "core/date") currentObservedDate = entry.value
          }
        }
        if (!cachedReminder) {
          const reminderText = Instructions.renderInitial(selection.volatileInstructions, values)
          const initialIsoDate = parseIsoFromDateValue(values["core/date"])
          cachedReminder = { reminderText, initialIsoDate }
          epochReminderCache.set(epochKey, cachedReminder)
          if (epochReminderCache.size > 256) {
            const oldest = epochReminderCache.keys().next().value
            if (oldest !== undefined) epochReminderCache.delete(oldest)
          }
        }
      }

      const reminderText = cachedReminder?.reminderText ?? ""
      const initialIsoDate = cachedReminder?.initialIsoDate ?? ""
      const liveIsoDate = parseIsoFromDateValue(currentObservedDate)

      // Identify the tail user message (for date rollover reminder on new user turns)
      let lastUserIndex = -1
      for (let i = history.entries.length - 1; i >= 0; i--) {
        const t = history.entries[i]?.message.type
        if (t === "user" || t === "synthetic") {
          lastUserIndex = i
          break
        }
      }

      let injected = false
      const messages = history.entries.map((entry, index) => {
        const msg = entry.message
        if (!injected && (msg.type === "user" || msg.type === "synthetic") && reminderText.length > 0) {
          injected = true
          const reminderBlock = `<system-reminder>\n${reminderText}\n</system-reminder>`
          return {
            ...msg,
            text: msg.text ? `${reminderBlock}\n\n${msg.text}` : reminderBlock,
          }
        }

        // Emit date rollover reminder ONLY on the tail user message on a new turn when live date differs
        if (
          index === lastUserIndex &&
          lastUserIndex > firstUserIndex &&
          initialIsoDate.length > 0 &&
          liveIsoDate !== initialIsoDate &&
          (msg.type === "user" || msg.type === "synthetic")
        ) {
          const rolloverTag = `[Date rollover: ${liveIsoDate}]`
          const alreadyTagged = msg.text?.includes("[Date rollover:")
          if (!alreadyTagged) {
            return {
              ...msg,
              text: msg.text ? `${rolloverTag}\n\n${msg.text}` : rolloverTag,
            }
          }
        }

        return msg
      })

      return {
        session: selection.session,
        agent: selection.agent,
        model,
        initial,
        messages,
        tools: selection.tools,
      }
    })

    return Service.of({ select, load, resolveModel, selectTitle, request })
  }),
)

/** Variant IDs that minimize reasoning output, in preference order. */
const MINIMAL_REASONING_VARIANTS = ["none", "minimal", "low"].map((id) => Model.VariantID.make(id))

const minimalVariant = (info: Model.Info) =>
  MINIMAL_REASONING_VARIANTS.find((id) => info.variants.some((item) => item.id === id))

/**
 * `none` and `minimal` always reduce reasoning. `low` can enable reasoning on a model whose default
 * does not reason, so it is only used when it ranks below the variant the session selected.
 */
const lowerVariant = (info: Model.Info, selected: Model.VariantID | undefined) => {
  const rank = (id: Model.VariantID | undefined) => info.variants.findIndex((item) => item.id === id)
  return MINIMAL_REASONING_VARIANTS.find((id) => rank(id) !== -1 && (id !== "low" || rank(id) < rank(selected)))
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Agent.node,
    Model.node,
    Database.node,
    InstructionBuiltIns.node,
    InstructionDiscovery.node,
    InstructionEntry.node,
    Location.node,
    McpInstructions.node,
    McpTool.node,
    ReferenceInstructions.node,
    SessionRunnerModel.node,
    SessionModelRequest.node,
    SessionStore.node,
    SkillInstructions.node,
    Tool.node,
  ],
})
