export * as ScheduleTool from "./schedule.js"

import crypto from "node:crypto"
import fsp from "node:fs/promises"
import path from "node:path"
import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Global } from "@opencode/util/global"
import { Effect, Predicate, Schema, Stream } from "effect"
import { Permission } from "../../permission.js"
import { NonNegativeInt, PositiveInt, optional } from "../../schema.js"
import { Session } from "../../session.js"

export const name = "schedule"

export const Action = Schema.Literals(["create_timer", "create_cron", "list", "cancel"])
export type Action = typeof Action.Type

export const Delivery = Schema.Literals(["steer", "queue"])
export type Delivery = typeof Delivery.Type

export const ScheduleKind = Schema.Literals(["timer", "cron"])
export type ScheduleKind = typeof ScheduleKind.Type

export const ScheduleStatus = Schema.Literals(["active", "completed", "cancelled"])
export type ScheduleStatus = typeof ScheduleStatus.Type

export const ScheduleInfo = Schema.Struct({
  id: Schema.String,
  kind: ScheduleKind,
  targetSessionID: Schema.String,
  directory: Schema.String,
  prompt: Schema.String,
  summary: Schema.String.pipe(optional),
  delivery: Delivery,
  delaySeconds: PositiveInt.pipe(optional),
  intervalSeconds: PositiveInt.pipe(optional),
  cronExpression: Schema.String.pipe(optional),
  createdAt: Schema.Number,
  nextRunAt: Schema.Number,
  runsCompleted: NonNegativeInt,
  maxIterations: PositiveInt.pipe(optional),
  status: ScheduleStatus,
})
export type ScheduleInfo = typeof ScheduleInfo.Type

export const Input = Schema.Struct({
  action: Action.annotate({
    description:
      "Operation to perform: 'create_timer' for one-shot timer; 'create_cron' for recurring schedule; 'list' shows active and recent schedules; 'cancel' cancels an active schedule.",
  }).pipe(optional),
  scheduleID: Schema.String.annotate({
    description: "ID of the schedule to cancel (alias 'id').",
  }).pipe(optional),
  id: Schema.String.annotate({
    description: "Alias for scheduleID.",
  }).pipe(optional),
  delaySeconds: PositiveInt.annotate({
    description: "Delay in seconds for 'create_timer' (1 to 86400).",
  }).pipe(optional),
  intervalSeconds: PositiveInt.annotate({
    description: "Recurring interval in seconds for 'create_cron' (minimum 10).",
  }).pipe(optional),
  cronExpression: Schema.String.annotate({
    description: "Standard 5-field cron expression for 'create_cron' (e.g. '*/5 * * * *').",
  }).pipe(optional),
  prompt: Schema.String.annotate({
    description: "Autonomous wakeup instructions delivered to the target session when the schedule fires.",
  }).pipe(optional),
  summary: Schema.String.annotate({
    description: "Short 3-10 word label summarizing the schedule task.",
  }).pipe(optional),
  targetSessionID: Schema.String.annotate({
    description: "Target session ID to wake. Defaults to the calling session.",
  }).pipe(optional),
  delivery: Delivery.annotate({
    description:
      "Inbox delivery mode when schedule fires: 'queue' (default, resumes target when idle) or 'steer' (injects at next step).",
  }).pipe(optional),
  maxIterations: PositiveInt.annotate({
    description: "Maximum number of iterations for recurring cron before auto-completing (default: 24).",
  }).pipe(optional),
})

export const Output = Schema.Struct({
  action: Action,
  schedule: ScheduleInfo.pipe(optional),
  schedules: Schema.Array(ScheduleInfo).pipe(optional),
  scheduleID: Schema.String.pipe(optional),
})
export type Output = typeof Output.Type

export const description =
  "Autonomous non-blocking timer & recurring schedule tool. Agents schedule delayed followups ('create_timer') or periodic background checks ('create_cron') without sleep-polling or burning active inference slots. Wakes the target session automatically with synthetic wakeup instructions."

interface PersistedSchedule {
  id: string
  kind: "timer" | "cron"
  targetSessionID: Session.ID
  directory: string
  prompt: string
  summary?: string
  delivery: "steer" | "queue"
  delaySeconds?: number
  intervalSeconds?: number
  cronExpression?: string
  createdAt: number
  nextRunAt: number
  runsCompleted: number
  maxIterations?: number
  status: "active" | "completed" | "cancelled"
}

interface SchedulesFile {
  schedules: Record<string, PersistedSchedule>
}

const loadSchedulesFile = async (filePath: string): Promise<SchedulesFile> => {
  try {
    const raw = await fsp.readFile(filePath, "utf-8")
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.schedules === "object") return parsed as SchedulesFile
    return { schedules: {} }
  } catch {
    return { schedules: {} }
  }
}

const saveSchedulesAtomic = async (filePath: string, data: SchedulesFile): Promise<void> => {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${crypto.randomUUID()}.tmp`
  await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8")
  await fsp.rename(tmpPath, filePath)
}

const matchCronField = (expr: string, value: number, minVal: number, maxVal: number): boolean => {
  const trimmed = expr.trim()
  if (trimmed === "*") return true
  if (trimmed.startsWith("*/")) {
    const step = parseInt(trimmed.slice(2), 10)
    return !isNaN(step) && step > 0 && (value - minVal) % step === 0
  }
  const parts = trimmed.split(",")
  for (const part of parts) {
    if (part.includes("-")) {
      const [startStr, endStr] = part.split("-")
      const start = parseInt(startStr!, 10)
      const end = parseInt(endStr!, 10)
      if (!isNaN(start) && !isNaN(end) && value >= start && value <= end) return true
    } else {
      const num = parseInt(part, 10)
      if (!isNaN(num) && num === value) return true
    }
  }
  return false
}

const matches5FieldCron = (cronExpr: string, date: Date): boolean => {
  const fields = cronExpr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const [minExpr, hrExpr, domExpr, monExpr, dowExpr] = fields
  const minute = date.getMinutes()
  const hour = date.getHours()
  const dayOfMonth = date.getDate()
  const month = date.getMonth() + 1
  let dayOfWeek = date.getDay()
  if (dowExpr === "7") dayOfWeek = 7

  return (
    matchCronField(minExpr!, minute, 0, 59) &&
    matchCronField(hrExpr!, hour, 0, 23) &&
    matchCronField(domExpr!, dayOfMonth, 1, 31) &&
    matchCronField(monExpr!, month, 1, 12) &&
    matchCronField(dowExpr!, dayOfWeek, 0, 7)
  )
}

export const Plugin = {
  id: "opencode.tool.schedule",
  effect: Effect.fn("ScheduleTool.Plugin")(function* (ctx: Context) {
    const global = yield* Global.Service
    const sessions = yield* Session.Service
    const permissions = yield* Permission.Service
    const effectContext = yield* Effect.context()
    const runFork = Effect.runForkWith(effectContext)

    const schedulesPath = path.join(global.data, "schedules.json")
    const activeTimers = new Map<string, NodeJS.Timeout>()
    const activeIntervals = new Map<string, NodeJS.Timeout>()

    const clearHandle = (id: string): void => {
      const t = activeTimers.get(id)
      if (t) {
        clearTimeout(t)
        activeTimers.delete(id)
      }
      const i = activeIntervals.get(id)
      if (i) {
        clearInterval(i)
        activeIntervals.delete(id)
      }
    }

    const fireSchedule = (id: string) =>
      Effect.gen(function* () {
        const file = yield* Effect.promise(() => loadSchedulesFile(schedulesPath))
        const schedule = file.schedules[id]
        if (!schedule || schedule.status !== "active") return

        const targetExists = yield* sessions
          .get(Session.ID.make(schedule.targetSessionID))
          .pipe(
            Effect.as(true),
            Effect.catchTag("Session.NotFoundError", () => Effect.succeed(false)),
            Effect.orElseSucceed(() => true),
          )
        if (!targetExists) {
          schedule.status = "cancelled"
          clearHandle(id)
          yield* Effect.promise(() => saveSchedulesAtomic(schedulesPath, file))
          return
        }

        const syntheticText = [
          `<scheduled-wakeup schedule_id="${schedule.id}" kind="${schedule.kind}">`,
          schedule.prompt,
          `</scheduled-wakeup>`,
        ].join("\n")

        const desc = `[Scheduled wakeup: ${schedule.kind}] ${schedule.summary ?? schedule.prompt.slice(0, 48)}`

        yield* sessions
          .synthetic({
            sessionID: schedule.targetSessionID,
            text: syntheticText,
            description: desc,
            delivery: schedule.delivery,
            resume: true,
            metadata: {
              source: "schedule",
              scheduleID: schedule.id,
              kind: schedule.kind,
              summary: schedule.summary,
            },
          })
          .pipe(Effect.catch(() => Effect.void))

        schedule.runsCompleted += 1

        if (schedule.kind === "timer") {
          schedule.status = "completed"
          clearHandle(id)
        } else if (schedule.kind === "cron") {
          const max = schedule.maxIterations ?? 24
          if (schedule.runsCompleted >= max) {
            schedule.status = "completed"
            clearHandle(id)
          } else {
            const nextDelayMs = (schedule.intervalSeconds ?? 60) * 1000
            schedule.nextRunAt = Date.now() + nextDelayMs
          }
        }

        yield* Effect.promise(() => saveSchedulesAtomic(schedulesPath, file))
      }).pipe(Effect.catch(() => Effect.void))

    const armTimer = (schedule: PersistedSchedule): void => {
      clearHandle(schedule.id)
      const now = Date.now()
      const delayMs = Math.max(50, schedule.nextRunAt - now)
      const handle = setTimeout(() => {
        runFork(fireSchedule(schedule.id))
      }, delayMs)
      handle.unref?.()
      activeTimers.set(schedule.id, handle)
    }

    const armCron = (schedule: PersistedSchedule): void => {
      clearHandle(schedule.id)
      if (schedule.intervalSeconds) {
        const intervalMs = schedule.intervalSeconds * 1000
        const handle = setInterval(() => {
          runFork(fireSchedule(schedule.id))
        }, intervalMs)
        handle.unref?.()
        activeIntervals.set(schedule.id, handle)
      } else if (schedule.cronExpression) {
        let lastMinuteChecked = -1
        const handle = setInterval(() => {
          const now = new Date()
          const currentMinute = now.getMinutes()
          if (currentMinute !== lastMinuteChecked) {
            if (matches5FieldCron(schedule.cronExpression!, now)) {
              lastMinuteChecked = currentMinute
              runFork(fireSchedule(schedule.id))
            }
          }
        }, 15_000)
        handle.unref?.()
        activeIntervals.set(schedule.id, handle)
      }
    }

    // Startup reload of non-expired persisted schedules for this directory
    yield* Effect.gen(function* () {
      const file = yield* Effect.promise(() => loadSchedulesFile(schedulesPath))
      const dirStr = String(ctx.location.directory)
      for (const s of Object.values(file.schedules)) {
        if (s.directory === dirStr && s.status === "active") {
          if (s.kind === "timer") {
            armTimer(s)
          } else if (s.kind === "cron") {
            armCron(s)
          }
        }
      }
    }).pipe(Effect.catch(() => Effect.void))

    if (ctx.event?.subscribe) {
      yield* ctx.event
        .subscribe({ types: ["session.deleted"] })
        .pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              const deletedID = (event as { properties?: { sessionID?: string } }).properties?.sessionID
              if (!deletedID) return
              const file = yield* Effect.promise(() => loadSchedulesFile(schedulesPath))
              let mutated = false
              for (const s of Object.values(file.schedules)) {
                if (s.targetSessionID === deletedID && s.status === "active") {
                  s.status = "cancelled"
                  clearHandle(s.id)
                  mutated = true
                }
              }
              if (mutated) {
                yield* Effect.promise(() => saveSchedulesAtomic(schedulesPath, file))
              }
            }).pipe(Effect.catch(() => Effect.void)),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )
        .pipe(Effect.catch(() => Effect.void))
    }

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const action: Action =
                input.action ??
                (input.delaySeconds
                  ? "create_timer"
                  : input.intervalSeconds || input.cronExpression
                    ? "create_cron"
                    : input.scheduleID || input.id
                      ? "cancel"
                      : "list")

              yield* permissions
                .assert({
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: {
                    type: "tool",
                    messageID: context.messageID,
                    id: context.id,
                  },
                  action: name,
                  resources: [input.scheduleID ?? input.id ?? action],
                })
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Permission denied for ${name}`, error }),
                  ),
                )

              const targetSessionID = Session.ID.make(input.targetSessionID ?? context.sessionID)
              const delivery: Delivery = input.delivery ?? "queue"
              const dirStr = String(ctx.location.directory)

              if (action === "create_timer") {
                const delay = input.delaySeconds
                if (!delay || delay <= 0 || delay > 86400) {
                  return yield* new ToolFailure({
                    message: "Action 'create_timer' requires delaySeconds between 1 and 86400 seconds (24h).",
                  })
                }
                const prompt = input.prompt?.trim()
                if (!prompt || prompt.length === 0) {
                  return yield* new ToolFailure({
                    message: "Action 'create_timer' requires prompt (autonomous instructions to execute on wakeup).",
                  })
                }

                const now = Date.now()
                const nextRunAt = now + delay * 1000
                const id = `sch_tm_${now.toString(36)}_${crypto.randomBytes(3).toString("hex")}`

                const schedule: PersistedSchedule = {
                  id,
                  kind: "timer",
                  targetSessionID,
                  directory: dirStr,
                  prompt,
                  ...(input.summary ? { summary: input.summary.trim() } : {}),
                  delivery,
                  delaySeconds: delay,
                  createdAt: now,
                  nextRunAt,
                  runsCompleted: 0,
                  status: "active",
                }

                const file = yield* Effect.promise(() => loadSchedulesFile(schedulesPath))
                file.schedules[id] = schedule
                yield* Effect.promise(() => saveSchedulesAtomic(schedulesPath, file))

                armTimer(schedule)

                const humanNext = new Date(nextRunAt).toISOString()
                const message = `Created timer ${id} (delay: ${delay}s, fires at: ${humanNext}). Target session ${targetSessionID} will wake non-blockingly.`

                return {
                  content: message,
                  output: {
                    action: "create_timer" as const,
                    schedule,
                  },
                  metadata: {
                    scheduleID: id,
                    kind: "timer",
                    nextRunAt,
                  },
                }
              }

              if (action === "create_cron") {
                const prompt = input.prompt?.trim()
                if (!prompt || prompt.length === 0) {
                  return yield* new ToolFailure({
                    message: "Action 'create_cron' requires prompt (instructions to execute on each scheduled run).",
                  })
                }

                const intervalSeconds = input.intervalSeconds
                const cronExpr = input.cronExpression?.trim()

                if (!intervalSeconds && !cronExpr) {
                  return yield* new ToolFailure({
                    message: "Action 'create_cron' requires either intervalSeconds (>= 10) or a 5-field cronExpression.",
                  })
                }
                if (intervalSeconds !== undefined && intervalSeconds < 10) {
                  return yield* new ToolFailure({
                    message: "Action 'create_cron' requires intervalSeconds to be at least 10 seconds.",
                  })
                }
                if (cronExpr && cronExpr.split(/\s+/).length !== 5) {
                  return yield* new ToolFailure({
                    message: `Invalid cronExpression "${cronExpr}". Standard 5-field cron required (e.g. '*/5 * * * *').`,
                  })
                }

                const now = Date.now()
                const id = `sch_cr_${now.toString(36)}_${crypto.randomBytes(3).toString("hex")}`
                const initialDelayMs = (intervalSeconds ?? 60) * 1000
                const nextRunAt = now + initialDelayMs
                const maxIterations = input.maxIterations ?? 24

                const schedule: PersistedSchedule = {
                  id,
                  kind: "cron",
                  targetSessionID,
                  directory: dirStr,
                  prompt,
                  ...(input.summary ? { summary: input.summary.trim() } : {}),
                  delivery,
                  ...(intervalSeconds ? { intervalSeconds } : {}),
                  ...(cronExpr ? { cronExpression: cronExpr } : {}),
                  createdAt: now,
                  nextRunAt,
                  runsCompleted: 0,
                  maxIterations,
                  status: "active",
                }

                const file = yield* Effect.promise(() => loadSchedulesFile(schedulesPath))
                file.schedules[id] = schedule
                yield* Effect.promise(() => saveSchedulesAtomic(schedulesPath, file))

                armCron(schedule)

                const cadenceDesc = intervalSeconds
                  ? `every ${intervalSeconds}s`
                  : `cron '${cronExpr}'`
                const message = `Created recurring schedule ${id} (${cadenceDesc}, maxIterations=${maxIterations}). Non-blocking wakeup delivered to session ${targetSessionID}.`

                return {
                  content: message,
                  output: {
                    action: "create_cron" as const,
                    schedule,
                  },
                  metadata: {
                    scheduleID: id,
                    kind: "cron",
                    nextRunAt,
                  },
                }
              }

              if (action === "list") {
                const file = yield* Effect.promise(() => loadSchedulesFile(schedulesPath))
                const list = Object.values(file.schedules).filter((s) => s.directory === dirStr)
                let mutated = false
                for (const s of list) {
                  if (s.status === "active") {
                    const exists = yield* sessions
                      .get(Session.ID.make(s.targetSessionID))
                      .pipe(
                        Effect.as(true),
                        Effect.catchTag("Session.NotFoundError", () => Effect.succeed(false)),
                        Effect.orElseSucceed(() => true),
                      )
                    if (!exists) {
                      s.status = "cancelled"
                      clearHandle(s.id)
                      mutated = true
                    }
                  }
                }
                if (mutated) {
                  yield* Effect.promise(() => saveSchedulesAtomic(schedulesPath, file))
                }
                list.sort((a, b) => b.createdAt - a.createdAt)

                const lines = [
                  `Schedules for workspace (${list.length}):`,
                  ...(list.length === 0
                    ? ["- (no schedules configured)"]
                    : list.map(
                        (s) =>
                          `- ${s.id} [${s.kind}/${s.status}] target=${s.targetSessionID} next=${new Date(s.nextRunAt).toISOString()} runs=${s.runsCompleted}/${s.maxIterations ?? 1} : "${s.summary ?? s.prompt.slice(0, 40)}"`,
                      )),
                ]

                return {
                  content: lines.join("\n"),
                  output: {
                    action: "list" as const,
                    schedules: list,
                  },
                  metadata: { count: list.length },
                }
              }

              if (action === "cancel") {
                const targetID = input.scheduleID ?? input.id
                if (!targetID || targetID.trim().length === 0) {
                  return yield* new ToolFailure({
                    message: "Action 'cancel' requires scheduleID (or id).",
                  })
                }
                const id = targetID.trim()

                const file = yield* Effect.promise(() => loadSchedulesFile(schedulesPath))
                const schedule = file.schedules[id]
                if (!schedule) {
                  return yield* new ToolFailure({
                    message: `Schedule "${id}" was not found.`,
                  })
                }

                schedule.status = "cancelled"
                clearHandle(id)
                yield* Effect.promise(() => saveSchedulesAtomic(schedulesPath, file))

                const message = `Cancelled schedule ${id} (${schedule.kind}).`
                return {
                  content: message,
                  output: {
                    action: "cancel" as const,
                    scheduleID: id,
                    schedule,
                  },
                  metadata: { scheduleID: id, status: "cancelled" },
                }
              }

              return yield* new ToolFailure({ message: `Unsupported action: ${action}` })
            }),
        }),
      )
      .pipe(Effect.orDie)

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.sync(() => {
        if (event.tool !== name || !Predicate.isObject(event.input)) return
        const raw = event.input as Record<string, unknown>
        if (raw.id && typeof raw.id === "string" && !raw.scheduleID) {
          raw.scheduleID = raw.id.trim()
          delete raw.id
        }
      }),
    )
  }),
}
