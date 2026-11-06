export * as Shell from "./shell.js"

import path from "path"
import { Context, Deferred, Duration, Effect, Fiber, Latch, Layer, Schema, Schedule, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { produce } from "immer"
import { Shell } from "@opencode/schema/shell"
import { AppProcess } from "@opencode/util/process"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Bus } from "./bus.js"
import { Environment } from "./environment/index.js"
import { FileRetention } from "./file-retention.js"
import { Location } from "./location.js"
import { Global } from "@opencode/util/global"
import { ShellSelect } from "./shell/select.js"
import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
import { PluginHooks } from "./plugin/hooks.js"
import { SessionEnvironment } from "./session/environment.js"
import { SessionSchema } from "./session/schema.js"
import { Config } from "./config.js"
import { ToolOutput } from "./tool-output.js"
import { ShellResult } from "./shell/result.js"
import { scrubChildEnvironment } from "./util/env-scrub.js"
import { buildSystemdLeafWrapCommand, type SystemdLeafWrapResult } from "./util/cgroup-wrap.js"
import { GpuBrokerClient } from "./util/gpu-broker-client.js"
import { SessionSlotLease } from "./session/slot-lease.js"
import { registerActiveSubprocUnit, unregisterActiveSubprocUnit, isSubprocActive, activeSubprocUnits } from "./tool/plugin/shell.js"

export { isSubprocActive, activeSubprocUnits }

export async function registerWrappedSubprocWithBroker(
  wrap: SystemdLeafWrapResult,
  sessionID?: string,
  client: GpuBrokerClient.Client = GpuBrokerClient.getDefaultClient(),
): Promise<boolean> {
  if (!client.isBrokerConfiguredOrAvailable()) {
    return false
  }
  const conversation_id = sessionID ? SessionSlotLease.getConversationIdForSession(sessionID) : undefined
  const regResult = await client.registerSubproc({
    request_id: wrap.unitName,
    unit_name: `${wrap.unitName}.service`,
    ...(conversation_id ? { conversation_id } : {}),
    ...(sessionID ? { owner_session_id: sessionID } : {}),
    memory_max_mib: wrap.tierSpec.memoryMaxMib,
  })
  if (regResult.admitted === false || regResult.ok === false) {
    const reason = regResult.reason || "ERR_SUBPROC_MEM_FLOOR_VIOLATION"
    throw new Error(
      `ERR_SUBPROC_MEM_FLOOR_VIOLATION: GPU broker denied subproc admission for unit ${wrap.unitName}: ${reason}`,
    )
  }
  registerActiveSubprocUnit(wrap.unitName)
  return true
}

export async function releaseWrappedSubprocWithBroker(
  wrap: SystemdLeafWrapResult,
  client: GpuBrokerClient.Client = GpuBrokerClient.getDefaultClient(),
): Promise<boolean> {
  if (!client.isBrokerConfiguredOrAvailable()) {
    unregisterActiveSubprocUnit(wrap.unitName)
    return false
  }
  try {
    await client.releaseSubproc(wrap.unitName)
    return true
  } catch {
    return false
  } finally {
    unregisterActiveSubprocUnit(wrap.unitName)
  }
}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Shell.NotFoundError", {
  id: Shell.ID,
}) {}

// Keep recent exited processes observable in memory, including their file-backed output.
// The process-local cap complements the time-based sweep, which also cleans files left by restarts.
const EXITED_LIMIT = 25
export const RETENTION = Duration.days(7)
export const DIRECTORY = "shell"
export const MAX_SHELL_OUTPUT_BYTES = 64 * 1024 * 1024
export const OUTPUT_TRUNCATED_NOTICE = "\n[output truncated at 64 MiB limit]\n"

type Info = Shell.Info
type CreateInput = Shell.CreateInput & {
  shell?: string
  maxOutputBytes?: number
}

type Active = {
  // Immutable snapshot; lifecycle updates replace it via immer `produce`.
  info: Info
  file: string
  size: number
  newlines: number
  // Resolves with the terminal Info once the command exits, times out, or is killed. A wait
  // started after termination resolves immediately from the already-completed deferred.
  done: Deferred.Deferred<Info, NotFoundError>
  timeoutFiber?: Fiber.Fiber<void>
  timeout?: (duration: number) => Effect.Effect<void>
  kill?: () => Effect.Effect<void>
}

type Ended = {
  status: "exited" | "timeout"
  exit?: number
  signal?: string
  completed: number
}

/**
 * Location-owned non-interactive shell command process service.
 *
 * Each `create` spawns one shell command, captures combined stdout/stderr to a
 * file, and returns an ID. Clients poll `get` for status and `output` for
 * file-backed output by cursor. No session, message, or permission state lives
 * here; callers (e.g. `ShellTool`) own that association and store the shell ID.
 */
export interface Interface {
  readonly create: <E = never, R = never>(
    input: CreateInput,
    before?: (input: ShellCreateBefore) => Effect.Effect<void, E, R>,
  ) => Effect.Effect<Shell.Info, E | AppProcess.AppProcessError, R>
  // Currently running commands only; exited shells are retained for get/output but excluded here.
  readonly list: () => Effect.Effect<Shell.Info[]>
  readonly get: (id: Shell.ID) => Effect.Effect<Shell.Info, NotFoundError>
  // Resolves once the command reaches a terminal status, returning its final Info. Fails with
  // NotFoundError if the command is unknown or is removed before it terminates.
  readonly wait: (id: Shell.ID) => Effect.Effect<Shell.Info, NotFoundError>
  // A known shell's terminal state and bounded tail. Missing capture remains distinct from its exit status.
  readonly result: (started: Shell.Info) => Effect.Effect<ShellResult.Result>
  // Replaces the running command's timeout from now; zero clears it. Ignored once the command has
  // ended or timed out, even while its process is still being killed or its output captured.
  readonly timeout: (id: Shell.ID, duration: number) => Effect.Effect<Shell.Info, NotFoundError>
  readonly output: (id: Shell.ID, input?: Shell.OutputInput) => Effect.Effect<Shell.Output, NotFoundError>
  readonly remove: (id: Shell.ID) => Effect.Effect<void, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Shell") {}

export const cleanup = Effect.fn("Shell.cleanup")(function* () {
  const fs = yield* FSUtil.Service
  const global = yield* Global.Service
  const directory = path.join(global.data, DIRECTORY)
  const projects = yield* fs.readDirectoryEntries(directory).pipe(
    Effect.map((entries) => entries.filter((entry) => entry.type === "directory")),
    Effect.orElseSucceed(() => []),
  )
  const files = yield* Effect.forEach(
    projects,
    (project) =>
      fs.readDirectoryEntries(path.join(directory, project.name)).pipe(
        Effect.map((entries) =>
          entries.flatMap((entry) =>
            entry.type === "file" && /^sh_[0-9a-f]{12}.*\.out$/.test(entry.name)
              ? [path.join(directory, project.name, entry.name)]
              : [],
          ),
        ),
        Effect.orElseSucceed(() => []),
      ),
    { concurrency: 8 },
  )
  yield* FileRetention.cleanup(fs, files.flat(), RETENTION)
})

const cleanupLayer = Layer.effectDiscard(
  cleanup().pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped),
)

const cleanupNode = makeGlobalNode({
  name: "shell-output-cleanup",
  layer: cleanupLayer,
  deps: [FSUtil.node, Global.node],
})

const layer = () =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const location = yield* Location.Service
      const global = yield* Global.Service
      const shell = yield* ShellSelect.Service
      const environment = yield* Environment.Service
      const hooks = yield* PluginHooks.Service
      const environments = yield* SessionEnvironment.Service
      const config = yield* Config.Service
      const context = yield* Effect.context()
      const runFork = Effect.runForkWith(context)
      const commands = new Map<Shell.ID, Active>()
      const exitOrder: Shell.ID[] = []

      const outputDir = path.join(global.data, DIRECTORY, location.project.id)
      const { mkdir, unlink } = yield* Effect.promise(() => import("fs/promises"))
      const { createWriteStream, createReadStream } = yield* Effect.promise(() => import("fs"))
      yield* Effect.promise(() => mkdir(outputDir, { recursive: true }))

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          for (const command of commands.values()) {
            if (command.timeoutFiber) yield* Fiber.interrupt(command.timeoutFiber)
            // Teardown interrupts pending commands; it is not a terminal command failure.
            yield* Deferred.interrupt(command.done)
          }
          commands.clear()
          exitOrder.length = 0
        }),
      )

      const require = Effect.fnUntraced(function* (id: Shell.ID) {
        const command = commands.get(id)
        if (!command) return yield* new NotFoundError({ id })
        return command
      })

      const removeCommand = Effect.fnUntraced(function* (id: Shell.ID) {
        const command = commands.get(id)
        const index = exitOrder.indexOf(id)
        if (index !== -1) exitOrder.splice(index, 1)
        if (!command) return
        commands.delete(id)
        if (command.timeoutFiber) yield* Fiber.interrupt(command.timeoutFiber)
        if (command.kill) yield* command.kill()
        // Unblock any wait still pending when the command is removed before it terminated.
        yield* Deferred.fail(command.done, new NotFoundError({ id }))
        yield* Effect.promise(() => unlink(command.file).catch(() => {}))
        // Every shell reports exactly one exit; removing a running one ends it as killed.
        if (command.info.status === "running") yield* bus.publish(Shell.Event.Exited, { id, status: "killed" })
        yield* bus.publish(Shell.Event.Deleted, { id })
      })

      const remove = Effect.fn("Shell.remove")(function* (id: Shell.ID) {
        yield* require(id)
        yield* removeCommand(id)
      })

      const list = Effect.fn("Shell.list")(function* () {
        return Array.from(commands.values())
          .filter((command) => command.info.status === "running")
          .map((command) => command.info)
      })

      const get = Effect.fn("Shell.get")(function* (id: Shell.ID) {
        return (yield* require(id)).info
      })

      const wait = Effect.fn("Shell.wait")(function* (id: Shell.ID) {
        return yield* Deferred.await((yield* require(id)).done)
      })

      const timeout = Effect.fn("Shell.timeout")(function* (id: Shell.ID, duration: number) {
        const command = yield* require(id)
        if (command.info.status !== "running" || !command.timeout) return command.info
        yield* command.timeout(duration)
        return command.info
      })

      const output = Effect.fnUntraced(function* (id: Shell.ID, input?: Shell.OutputInput) {
        const command = yield* require(id)
        const cursor = input?.cursor ?? 0
        const limit = input?.limit ?? 65536
        if (cursor >= command.size) return { output: "", cursor: command.size, size: command.size, truncated: false }
        const start = Math.max(0, cursor)
        const length = Math.min(limit, command.size - start)
        const buffer = Buffer.alloc(length)
        const bytesRead = yield* Effect.promise(
          () =>
            new Promise<number>((resolve) => {
              const stream = createReadStream(command.file, { start, end: start + length - 1 })
              let offset = 0
              stream.on("data", (chunk: string | Buffer) => {
                const bytes = Buffer.from(chunk)
                bytes.copy(buffer, offset)
                offset += bytes.length
              })
              stream.on("end", () => resolve(offset))
              stream.on("error", () => resolve(0))
            }),
        )
        return {
          output: buffer.subarray(0, bytesRead).toString("utf8"),
          cursor: start + bytesRead,
          size: command.size,
          truncated: false,
        }
      })

      const result = Effect.fn("Shell.result")(function* (started: Shell.Info) {
        const info = yield* wait(started.id).pipe(
          Effect.catchTag("Shell.NotFoundError", () =>
            Effect.succeed({ ...started, status: "killed" as const, time: { ...started.time, completed: Date.now() } }),
          ),
        )
        const capture = yield* Effect.gen(function* () {
          const limits = Config.latest(yield* config.entries(), "tool_output")
          const maxLines = limits?.max_lines ?? ToolOutput.MAX_LINES
          const maxBytes = limits?.max_bytes ?? ToolOutput.MAX_BYTES
          const latest = yield* output(info.id, { cursor: Number.MAX_SAFE_INTEGER })
          const page = yield* output(info.id, { cursor: Math.max(0, latest.size - maxBytes), limit: maxBytes })
          const lines = page.output.split("\n")
          if (page.output.endsWith("\n")) lines.pop()
          const truncated = latest.size > maxBytes || lines.length > maxLines
          const text = lines.length > maxLines ? lines.slice(-maxLines).join("\n") : page.output
          const total = (yield* require(info.id)).newlines + (page.output.endsWith("\n") ? 0 : 1)
          const shown = Math.min(lines.length, maxLines)
          const notice = truncated
            ? `\n\n[showing lines ${total - shown + 1}-${total} of ${total}; full output saved to ${info.file}]`
            : ""
          return { output: `${text || "(no output)"}${notice}`, truncated }
        }).pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.succeed(undefined)))
        return { info, capture }
      })

      const create = Effect.fn("Shell.create")(function* <E = never, R = never>(
        input: CreateInput,
        before?: (input: ShellCreateBefore) => Effect.Effect<void, E, R>,
      ) {
        const sessionID = input.metadata?.sessionID
        const baseEnv =
          location.workspaceID !== undefined
            ? undefined
            : ((Schema.is(SessionSchema.ID)(sessionID) ? yield* environments.get(sessionID) : undefined) ?? process.env)
        const scrubbedBase = baseEnv !== undefined ? scrubChildEnvironment(baseEnv) : undefined
        const invocation: ShellCreateBefore = {
          command: input.command,
          cwd: input.cwd ?? location.directory,
          timeout: input.timeout ?? 0,
          shell: input.shell ?? (yield* shell.resolve({ priority: "config" })),
          env: {
            ...scrubbedBase,
            TERM: "xterm-256color",
            OPENCODE_TERMINAL: "1",
          },
        }
        yield* hooks.trigger("shell", "create.before", invocation)
        if (before) yield* before(invocation)

        const id = Shell.ID.ascending()
        const rawArgs = ShellSelect.args(invocation.shell, invocation.command)
        const file = path.join(outputDir, `${id}.out`)

        const wrap = buildSystemdLeafWrapCommand(invocation.shell, rawArgs, {
          requestId: id,
          cwd: invocation.cwd,
        })
        const spawnCommand = wrap.command
        const spawnArgs = wrap.args
        const spawnEnv = scrubChildEnvironment(invocation.env)

        const info: Info = {
          id,
          status: "running",
          command: invocation.command,
          cwd: invocation.cwd,
          shell: invocation.shell,
          file,
          metadata: input.metadata ?? {},
          time: { started: Date.now() },
        }

        // Spawn through the Environment and stream combined output to the file. The handle is scope-bound, so
        // the managing fiber keeps its scope open until the command terminates (it awaits `done` at the
        // end). `create` returns once `ready` resolves with the registered command.
        const ready = Deferred.makeUnsafe<Active, AppProcess.AppProcessError>()
        let subprocRegistered = false
        let subprocReleased = false
        const releaseSubprocOnce = () => {
          if (subprocReleased || !subprocRegistered) return Effect.void
          subprocReleased = true
          return Effect.promise(async () => {
            try {
              return await releaseWrappedSubprocWithBroker(wrap)
            } finally {
              unregisterActiveSubprocUnit(wrap.unitName)
            }
          })
        }
        runFork(
          Effect.scoped(
            Effect.gen(function* () {
              const registered = yield* Effect.tryPromise({
                try: () =>
                  registerWrappedSubprocWithBroker(wrap, typeof sessionID === "string" ? sessionID : undefined),
                catch: (cause) =>
                  new AppProcess.AppProcessError({
                    command: invocation.command,
                    cause,
                  }),
              })
              if (registered) {
                subprocRegistered = true
              }
              const handle = yield* environment.spawner
                .spawn(
                  ChildProcess.make(spawnCommand, spawnArgs, {
                    cwd: invocation.cwd,
                    env: spawnEnv,
                    stdin: "ignore",
                    detached: process.platform !== "win32",
                    forceKillAfter: Duration.seconds(3),
                  }),
                )
                .pipe(
                  Effect.mapError((cause) => new AppProcess.AppProcessError({ command: invocation.command, cause })),
                )
              const command: Active = {
                info: produce(info, (draft) => {
                  draft.pid = handle.pid
                }),
                file,
                size: 0,
                newlines: 0,
                done: Deferred.makeUnsafe<Info, NotFoundError>(),
                kill: () => handle.kill({ forceKillAfter: Duration.seconds(1) }).pipe(Effect.catch(() => Effect.void)),
              }
              commands.set(id, command)

              const maxOutputBytes = input.maxOutputBytes ?? MAX_SHELL_OUTPUT_BYTES
              const stream = createWriteStream(file)
              const outputDone = Latch.makeUnsafe()
              let truncated = false

              const writeChunk = (data: Uint8Array): Effect.Effect<void> =>
                Effect.callback<void>((resume) => {
                  let settled = false
                  const settle = () => {
                    if (settled) return
                    settled = true
                    cleanup()
                    resume(Effect.void)
                  }
                  const onDrain = () => settle()
                  const onError = () => settle()
                  const onClose = () => settle()
                  const cleanup = () => {
                    stream.removeListener("drain", onDrain)
                    stream.removeListener("error", onError)
                    stream.removeListener("close", onClose)
                  }

                  const ok = stream.write(data)
                  if (ok) {
                    resume(Effect.void)
                    return
                  }

                  stream.once("drain", onDrain)
                  stream.once("error", onError)
                  stream.once("close", onClose)

                  return Effect.sync(cleanup)
                })

              const pump = handle.all.pipe(
                Stream.runForEach((chunk: Uint8Array) =>
                  Effect.gen(function* () {
                    if (truncated) return
                    const remaining = maxOutputBytes - command.size
                    if (chunk.length > remaining) {
                      truncated = true
                      const slice = remaining > 0 ? chunk.subarray(0, remaining) : null
                      if (slice && slice.length > 0) {
                        yield* writeChunk(slice)
                        command.size += slice.length
                        for (let index = slice.indexOf(10); index !== -1; index = slice.indexOf(10, index + 1))
                          command.newlines++
                      }
                      const noticeBytes = Buffer.from(OUTPUT_TRUNCATED_NOTICE)
                      yield* writeChunk(noticeBytes)
                      command.size += noticeBytes.length
                      for (let index = noticeBytes.indexOf(10); index !== -1; index = noticeBytes.indexOf(10, index + 1))
                        command.newlines++

                      runFork(
                        handle.kill({ forceKillAfter: Duration.seconds(1) }).pipe(Effect.catch(() => Effect.void)),
                      )
                      return yield* Effect.fail("truncated")
                    }

                    yield* writeChunk(chunk)
                    command.size += chunk.length
                    // Count while streaming so truncation notices never rescan the output file.
                    for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, index + 1))
                      command.newlines++
                  }),
                ),
              )
              runFork(
                Effect.gen(function* () {
                  yield* pump.pipe(Effect.catch(() => Effect.void))
                  yield* Effect.promise(
                    () =>
                      new Promise<void>((resolve) => {
                        stream.end(() => resolve())
                      }),
                  )
                  yield* outputDone.open
                }),
              )
              yield* Effect.promise(
                () =>
                  new Promise<void>((resolve) => {
                    stream.once("open", () => resolve())
                    stream.once("error", () => resolve())
                  }),
              )

              // The process exit and the timeout race to record how the command ended; the first wins.
              const ended = Deferred.makeUnsafe<Ended>()
              const end = (outcome: Omit<Ended, "completed">) =>
                Effect.suspend(() => Deferred.succeed(ended, { ...outcome, completed: Date.now() }))

              command.timeout = (duration) =>
                Effect.gen(function* () {
                  if (Deferred.isDoneUnsafe(ended)) return
                  if (command.timeoutFiber) yield* Fiber.interrupt(command.timeoutFiber)
                  command.timeoutFiber = undefined
                  if (duration === 0) return
                  command.timeoutFiber = runFork(
                    Effect.sleep(Duration.millis(duration)).pipe(
                      // A recorded timeout must always kill. The kill runs detached, so interrupting this
                      // timer (retime, remove, teardown) neither cancels it nor waits for the process to die.
                      Effect.andThen(
                        Effect.gen(function* () {
                          if (!(yield* end({ status: "timeout" }))) return
                          runFork(
                            handle.kill({ forceKillAfter: Duration.seconds(3) }).pipe(Effect.catch(() => Effect.void)),
                          )
                        }).pipe(Effect.uninterruptible),
                      ),
                    ),
                  )
                })

              yield* command.timeout(invocation.timeout)

              // The process exits even after a timeout kill, so this fiber always publishes the outcome.
              runFork(
                Effect.gen(function* () {
                  yield* handle.exitCode.pipe(
                    Effect.flatMap((code) => end({ status: "exited", exit: code })),
                    Effect.catch((error) =>
                      end({
                        status: "exited",
                        signal:
                          error.cause instanceof CrossSpawnSpawner.KilledBySignal ? error.cause.signal : undefined,
                      }),
                    ),
                  )
                  const outcome = yield* Deferred.await(ended)
                  // Report the terminal status only once captured output is complete, so a reader that
                  // sees it never reads a partial file.
                  yield* outputDone.await
                  // A removed command already failed its waiters and published its exit and deletion.
                  if (commands.get(id) !== command) {
                    yield* releaseSubprocOnce()
                    return
                  }
                  command.info = produce(command.info, (draft) => {
                    draft.status = outcome.status
                    if (outcome.exit !== undefined) draft.exit = outcome.exit
                    if (outcome.signal !== undefined) draft.signal = outcome.signal
                    draft.time.completed = outcome.completed
                  })
                  // Resolve waiters before retention eviction, so an evicted command still reports its
                  // terminal Info rather than the removal NotFoundError.
                  yield* releaseSubprocOnce()
                  yield* Deferred.succeed(command.done, command.info)
                  yield* bus.publish(Shell.Event.Exited, {
                    id,
                    ...(outcome.exit !== undefined ? { exit: outcome.exit } : {}),
                    status: outcome.status,
                  })
                  exitOrder.push(id)
                  while (exitOrder.length > EXITED_LIMIT) {
                    const oldest = exitOrder[0]
                    if (!oldest) break
                    yield* removeCommand(oldest)
                  }
                  // Keep exited history data-only.
                  const timeoutFiber = command.timeoutFiber
                  command.timeout = undefined
                  command.timeoutFiber = undefined
                  if (timeoutFiber) yield* Fiber.interrupt(timeoutFiber)
                }),
              )

              yield* bus.publish(Shell.Event.Created, { info })
              yield* Deferred.succeed(ready, command)
              // Hold the handle's scope open until the command terminates; closing it earlier would
              // release (kill) the process before its exit is observed.
              yield* Deferred.await(command.done).pipe(Effect.catch(() => Effect.void))
            }).pipe(Effect.ensuring(releaseSubprocOnce())),
          ).pipe(Effect.catchTag("AppProcessError", (error) => Deferred.fail(ready, error))),
        )

        const command = yield* Deferred.await(ready)
        return command.info
      })

      return Service.of({ create, list, get, wait, result, timeout, output, remove })
    }),
  )

export const node = makeLocationNode({
  service: Service,
  layer: layer(),
  deps: [
    Bus.node,
    Location.node,
    Global.node,
    ShellSelect.node,
    Environment.node,
    PluginHooks.node,
    SessionEnvironment.node,
    Config.node,
    cleanupNode,
  ],
})
