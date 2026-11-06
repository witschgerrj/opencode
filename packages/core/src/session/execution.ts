export * as SessionExecution from "./execution.js"

import { and, asc, desc, eq, sql } from "drizzle-orm"
import { Cause, Context, Effect, Exit, Layer } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Job } from "../job.js"
import { Instance } from "../instance/service.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { SessionEvent } from "./event.js"
import { SessionMessage } from "./message.js"
import { SessionRunCoordinator } from "./run-coordinator.js"
import { SessionRunner } from "./runner/index.js"
import { SessionSchema } from "./schema.js"
import { SessionInboxTable, SessionMessageTable, SessionTable } from "./sql.js"
import { SessionStore } from "./store.js"
import { toSessionError } from "./to-session-error.js"
import { SessionInbox } from "./inbox.js"

export interface Interface {
  /** Snapshots active execution owned by this process. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** Checks process-local ownership, including interruption cleanup and terminal settlement. */
  readonly isActive: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  /** Starts execution while idle or joins the active execution. */
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Registers newly recorded work. Repeated wakeups may coalesce. */
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /**
   * Interrupt active work owned by this process. Idle interruption is a no-op. Resolves once
   * the interruption is accepted; cleanup settles asynchronously in the execution fiber.
   * Returns whether an active execution was interrupted. Compose with `awaitIdle` when
   * settlement matters.
   */
  readonly interrupt: (
    sessionID: SessionSchema.ID,
    options?: {
      readonly resume?: boolean
    },
  ) => Effect.Effect<boolean>
  /** Resolves once this process owns no active execution for the Session. Returns immediately when idle and never starts work. */
  readonly awaitIdle: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

/** Routes execution from a Session ID to its selected instance's runner. */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionExecution") {}

type InterruptReason = "user" | "shutdown"

export function terminal(exit: Exit.Exit<void, SessionRunner.RunError>, reason?: InterruptReason) {
  if (Exit.isSuccess(exit)) return { type: "succeeded" as const }
  if (Cause.hasInterrupts(exit.cause)) return { type: "interrupted" as const, reason: reason ?? "shutdown" }
  return { type: "failed" as const, error: toSessionError(Cause.squash(exit.cause)) }
}

/** Process-local execution: drains run in this process using the selected instance. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const instances = yield* Instance.Service
    const bus = yield* Bus.Service
    const jobs = yield* Job.Service
    const db = (yield* Database.Service).db
    const reportLifecycle = <A>(sessionID: SessionSchema.ID, effect: Effect.Effect<A>) =>
      effect.pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Failed to publish Session execution lifecycle", cause).pipe(
                Effect.annotateLogs({ sessionID }),
              ),
        ),
        Effect.asVoid,
      )
    // Write-ahead claim: starting records the durable intent that a turn is in flight, in the same
    // transaction as the started event. Terminals release it — except shutdown interruption, which
    // preserves the claim so the next server start resumes the turn. A claim that survives with no
    // terminal is the signature of a process that died without teardown (crash, SIGKILL, eviction);
    // recovery is a property of the database, never of a shutdown hook that may not run.
    const claimOnCommit = (sessionID: SessionSchema.ID) => ({
      commit: () => store.claim(sessionID),
    })
    const releaseOnCommit = (sessionID: SessionSchema.ID) => ({
      commit: () => store.release(sessionID),
    })
    const drain = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      force: boolean,
      continuation?: SessionRunner.Continuation,
      promotable: SessionInbox.Promotable = "input",
    ): Effect.fn.Return<void, SessionRunner.RunError> {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
      const result = yield* SessionRunner.Service.use((runner) =>
        runner.drain({ sessionID, force, continuation, promotable }),
      ).pipe(
        instances.provide(session),
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
        ),
      )
      return yield* SessionRunner.DrainResult.$match(result, {
        Complete: () => Effect.void,
        Moved: (result) => drain(sessionID, false, result.continuation, promotable),
        Reloaded: (result) => drain(sessionID, result.force, result.continuation, promotable),
      })
    })
    const reconcileSubagentToolMetadata = Effect.fnUntraced(function* (
      targetSessionID: SessionSchema.ID,
      filterChildID?: SessionSchema.ID,
    ) {
      const assistantRows = yield* db
        .select({
          id: SessionMessageTable.id,
          data: SessionMessageTable.data,
        })
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, targetSessionID), eq(SessionMessageTable.type, "assistant")))
        .all()
        .pipe(Effect.orDie)
      let updatedAny = false
      for (const row of assistantRows) {
        const data = row.data as Record<string, unknown>
        if (!Array.isArray(data.content)) continue
        let rowModified = false
        const nextContent: unknown[] = []
        for (const item of data.content) {
          if (typeof item !== "object" || item === null) {
            nextContent.push(item)
            continue
          }
          const part = item as Record<string, unknown>
          const state = typeof part.state === "object" && part.state !== null ? (part.state as Record<string, unknown>) : undefined
          const metadata =
            state && typeof state.metadata === "object" && state.metadata !== null
              ? (state.metadata as Record<string, unknown>)
              : undefined
          const childID = typeof metadata?.sessionID === "string" ? (metadata.sessionID as SessionSchema.ID) : undefined
          if (
            part.type === "tool" &&
            part.name === "subagent" &&
            state?.status === "completed" &&
            metadata?.status === "running" &&
            childID !== undefined &&
            (filterChildID === undefined || childID === filterChildID)
          ) {
            const childRow = yield* db
              .select({
                idle_outcome: SessionTable.idle_outcome,
                time_suspended: SessionTable.time_suspended,
              })
              .from(SessionTable)
              .where(eq(SessionTable.id, childID))
              .get()
              .pipe(Effect.orDie)
            const nextStatus =
              childRow?.idle_outcome === "succeeded" && childRow.time_suspended === null ? "completed" : "interrupted"
            nextContent.push({
              ...part,
              state: {
                ...state,
                metadata: {
                  ...metadata,
                  status: nextStatus,
                },
              },
            })
            rowModified = true
            updatedAny = true
          } else {
            nextContent.push(item)
          }
        }
        if (rowModified) {
          yield* db
            .update(SessionMessageTable)
            .set({
              // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
              data: { ...data, content: nextContent } as unknown as typeof SessionMessageTable.$inferInsert.data,
            })
            .where(and(eq(SessionMessageTable.id, row.id), eq(SessionMessageTable.session_id, targetSessionID)))
            .run()
            .pipe(Effect.orDie)
        }
      }
      return updatedAny
    })

    const reconcileInactiveInterrupt = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      yield* jobs.cancel(sessionID)
      const inboxRows = yield* db
        .select({ id: SessionInboxTable.id })
        .from(SessionInboxTable)
        .where(eq(SessionInboxTable.session_id, sessionID))
        .orderBy(asc(SessionInboxTable.enqueued_seq))
        .all()
        .pipe(Effect.orDie)
      for (const row of inboxRows) {
        yield* SessionInbox.projectCancelled(db, { sessionID, id: row.id }).pipe(
          Effect.catchCause(() => Effect.void),
        )
      }
      const sessionRow = yield* db
        .select({
          id: SessionTable.id,
          parent_id: SessionTable.parent_id,
          time_idle: SessionTable.time_idle,
          idle_outcome: SessionTable.idle_outcome,
          time_suspended: SessionTable.time_suspended,
        })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!sessionRow) return inboxRows.length > 0

      const reconciledOwnSubagents = yield* reconcileSubagentToolMetadata(sessionID)
      if (sessionRow.parent_id) {
        yield* reconcileSubagentToolMetadata(sessionRow.parent_id, sessionID)
      }

      const latestMessage = yield* db
        .select({
          id: SessionMessageTable.id,
          type: SessionMessageTable.type,
          seq: SessionMessageTable.seq,
          data: SessionMessageTable.data,
        })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(desc(SessionMessageTable.seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)

      const needsIdleReconcile =
        inboxRows.length > 0 ||
        reconciledOwnSubagents ||
        sessionRow.time_suspended !== null ||
        sessionRow.time_idle === null ||
        sessionRow.idle_outcome === null ||
        (latestMessage !== undefined && latestMessage.type !== "idle")

      if (!needsIdleReconcile) return false

      const now = Date.now()
      if (latestMessage?.type !== "idle") {
        yield* reportLifecycle(
          sessionID,
          bus.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: "user" }, releaseOnCommit(sessionID)),
        )
        const afterLatest = yield* db
          .select({
            id: SessionMessageTable.id,
            type: SessionMessageTable.type,
            seq: SessionMessageTable.seq,
          })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .orderBy(desc(SessionMessageTable.seq))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        if (afterLatest?.type !== "idle") {
          yield* db
            .insert(SessionMessageTable)
            .values({
              id: SessionMessage.ID.create(),
              session_id: sessionID,
              type: "idle",
              seq: (afterLatest?.seq ?? 0) + 1,
              time_created: now,
              // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
              data: {
                outcome: "interrupted",
                time: { created: now },
              } as unknown as typeof SessionMessageTable.$inferInsert.data,
            })
            .run()
            .pipe(Effect.orDie)
        }
      } else {
        const idleData = latestMessage.data as Record<string, unknown>
        if (idleData.outcome !== "interrupted") {
          yield* db
            .update(SessionMessageTable)
            .set({
              // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
              data: { ...idleData, outcome: "interrupted" } as unknown as typeof SessionMessageTable.$inferInsert.data,
            })
            .where(and(eq(SessionMessageTable.id, latestMessage.id), eq(SessionMessageTable.session_id, sessionID)))
            .run()
            .pipe(Effect.orDie)
        }
      }

      yield* db
        .update(SessionTable)
        .set({
          time_idle: sql`max(${now}, coalesce(${SessionTable.time_idle} + 1, ${now}))`,
          idle_outcome: "interrupted",
          time_suspended: null,
          resume_attempts: 0,
          time_updated: sql`${SessionTable.time_updated}`,
        })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)

      return true
    })

    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError, InterruptReason>({
      started: (sessionID) =>
        reportLifecycle(
          sessionID,
          bus.publish(SessionEvent.Execution.Started, { sessionID }, claimOnCommit(sessionID)),
        ),
      drain: (sessionID, force, promotable) => drain(sessionID, force, undefined, promotable),
      // One terminal observation per busy period, covering every coalesced drain.
      settled: (sessionID, exit, reason): Effect.Effect<void> =>
        reportLifecycle(
          sessionID,
          Effect.gen(function* () {
            const outcome = terminal(exit, reason)
            if (outcome.type === "succeeded") {
              yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID }, releaseOnCommit(sessionID))
              return
            }
            if (outcome.type === "interrupted") {
              // Deliberate stops release the claim; shutdown keeps it for restart continuity.
              if (outcome.reason !== "shutdown") {
                yield* jobs.cancel(sessionID)
                yield* reconcileSubagentToolMetadata(sessionID)
                const sessionRow = yield* db
                  .select({ parent_id: SessionTable.parent_id })
                  .from(SessionTable)
                  .where(eq(SessionTable.id, sessionID))
                  .get()
                  .pipe(Effect.orDie)
                if (sessionRow?.parent_id) {
                  yield* reconcileSubagentToolMetadata(sessionRow.parent_id, sessionID)
                }
              }
              yield* bus.publish(
                SessionEvent.Execution.Interrupted,
                { sessionID, reason: outcome.reason },
                outcome.reason === "shutdown" ? undefined : releaseOnCommit(sessionID),
              )
              return
            }
            // Clear stale doorbells from inbox items already consumed earlier in a multi-step
            // drain so settle does not spawn an empty successor drain that overwrites Failed.
            if ((yield* SessionInbox.nextPromotable(db, sessionID, "input")) === undefined) {
              yield* coordinator.interrupt(sessionID)
            }
            yield* bus.publish(
              SessionEvent.Execution.Failed,
              {
                sessionID,
                error: outcome.error,
              },
              releaseOnCommit(sessionID),
            )
          }),
        ),
    })

    return Service.of({
      active: coordinator.active,
      isActive: coordinator.isActive,
      interrupt: (sessionID, options) =>
        Effect.gen(function* () {
          const interrupted = yield* coordinator.interrupt(sessionID, "user")
          if (!options?.resume) {
            if (!interrupted) {
              return yield* reconcileInactiveInterrupt(sessionID)
            }
            return interrupted
          }
          // Resume steering input and between-turn control work from the interrupted
          // intent. Queued next-turn prompts stay parked: a steer-scoped drain never
          // promotes them, and a control item behind a queued prompt waits its turn.
          // Interruption acknowledges before cleanup settles, so this wake usually lands
          // on the stopping execution's doorbell and starts the successor at settle.
          // Reading the inbox concurrently with the dying drain is safe: delivery consumes
          // rows inside uninterruptible publications, so a steer row is either still
          // promotable here or was fully delivered and needs no resumption.
          const next = yield* SessionInbox.nextPromotable(db, sessionID, "input")
          if (next === undefined) return interrupted
          if (next.delivery === "steer" || next.type === "compaction" || next.type === "move")
            yield* coordinator.wake(sessionID, "steer")
          return interrupted
        }),
      resume: coordinator.run,
      wake: coordinator.wake,
      awaitIdle: coordinator.awaitIdle,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionStore.node, Instance.node, Bus.node, Database.node, Job.node],
})

/** Low-level compatibility layer for callers that only need durable Session recording. */
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    active: Effect.succeed(new Set()),
    isActive: () => Effect.succeed(false),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.succeed(false),
    awaitIdle: () => Effect.void,
  }),
)
