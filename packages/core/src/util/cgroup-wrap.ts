import fs from "node:fs"
import { isSensitiveEnvKey } from "./env-scrub.js"

export type SubprocTier = "fast_inspect" | "build_test"

export interface SubprocTierSpec {
  tier: SubprocTier
  memoryHighMib: number
  memoryMaxMib: number
  memorySwapMax: number
  memoryOomGroup: boolean
  oomScoreAdjust: number
  slice: string
}

export interface SystemdLeafWrapOptions {
  requestId?: string
  tier?: SubprocTier
  cwd?: string
  forceWrap?: boolean
  platform?: string
  env?: Record<string, string | undefined>
  existsSync?: (path: string) => boolean
}

export function isAquanoxLeafCgroupHostAvailable(probe?: {
  platform?: string
  env?: Record<string, string | undefined>
  existsSync?: (path: string) => boolean
}): boolean {
  const platform = probe?.platform ?? process.platform
  const env = probe?.env ?? process.env
  const existsSync = probe?.existsSync ?? fs.existsSync

  if (platform !== "linux" || env.AQUANOX_ENFORCE_LEAF_CGROUPS === "0") {
    return false
  }

  if (env.AQUANOX_ENFORCE_LEAF_CGROUPS === "1") {
    return true
  }

  if (
    !probe?.existsSync &&
    (process.env.NODE_ENV === "test" ||
      process.env.BUN_ENV === "test" ||
      env.NODE_ENV === "test" ||
      env.BUN_ENV === "test")
  ) {
    return false
  }

  const hasSlice =
    existsSync("/sys/fs/cgroup/aquanox.slice/aquanox-subprocs.slice") ||
    existsSync("/sys/fs/cgroup/aquanox-subprocs.slice")

  const hasSystemdSocket =
    existsSync("/run/systemd/private") ||
    existsSync("/run/dbus/system_bus_socket")

  return hasSlice && hasSystemdSocket
}

export interface SystemdLeafWrapResult {
  command: string
  args: string[]
  unitName: string
  tierSpec: SubprocTierSpec
  wrapped: boolean
}

export const AQUANOX_SUBPROCS_SLICE = "aquanox-subprocs.slice"

export const FAST_INSPECT_SPEC: SubprocTierSpec = {
  tier: "fast_inspect",
  memoryHighMib: 768,
  memoryMaxMib: 1024,
  memorySwapMax: 0,
  memoryOomGroup: true,
  oomScoreAdjust: 300,
  slice: AQUANOX_SUBPROCS_SLICE,
}

export const BUILD_TEST_SPEC: SubprocTierSpec = {
  tier: "build_test",
  memoryHighMib: 6144,
  memoryMaxMib: 8192,
  memorySwapMax: 0,
  memoryOomGroup: true,
  oomScoreAdjust: 300,
  slice: AQUANOX_SUBPROCS_SLICE,
}

export function getSubprocTierSpec(tier: SubprocTier): SubprocTierSpec {
  if (tier === "fast_inspect") {
    return { ...FAST_INSPECT_SPEC }
  }
  const customMax = process.env.AQUANOX_BUILD_TEST_MEMORY_MAX_MIB
  const parsedMax = customMax ? parseInt(customMax, 10) : NaN
  if (!Number.isNaN(parsedMax) && parsedMax >= 512) {
    return {
      ...BUILD_TEST_SPEC,
      memoryHighMib: Math.floor(parsedMax * 0.75),
      memoryMaxMib: parsedMax,
    }
  }
  return { ...BUILD_TEST_SPEC }
}

const HEAVY_COMMANDS = new Set([
  "cargo",
  "rustc",
  "rustup",
  "bun",
  "bunx",
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "pytest",
  "python",
  "python3",
  "uv",
  "pip",
  "pip3",
  "godot",
  "blender",
  "make",
  "cmake",
  "ninja",
  "gcc",
  "clang",
  "g++",
  "clang++",
  "cc",
  "c++",
  "ld",
  "lld",
  "mold",
  "tsc",
  "tsgo",
  "vite",
  "webpack",
  "esbuild",
  "rollup",
  "rolldown",
  "vitest",
  "jest",
  "go",
  "javac",
  "java",
  "gradle",
  "mvn",
  "docker",
  "podman",
  "xargs",
])

const FAST_INSPECT_COMMANDS = new Set([
  "git",
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "ls",
  "cat",
  "sed",
  "awk",
  "jq",
  "head",
  "tail",
  "wc",
  "find",
  "fd",
  "stat",
  "pwd",
  "echo",
  "printf",
  "which",
  "whereis",
  "uname",
  "env",
  "printenv",
  "id",
  "whoami",
  "date",
  "true",
  "false",
  "test",
  "[",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "sort",
  "uniq",
  "cut",
  "tr",
  "diff",
  "comm",
  "file",
  "tree",
  "du",
  "df",
  "free",
  "ps",
  "pgrep",
  "sleep",
])

const HEAVY_GIT_SUBCOMMANDS = new Set([
  "clone",
  "gc",
  "repack",
  "submodule",
  "fsck",
  "filter-branch",
  "prune",
  "lfs",
])

const SHELL_BINARIES = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "csh",
  "tcsh",
])

function getBasename(cmd: string): string {
  const parts = cmd.split("/")
  return parts[parts.length - 1] ?? cmd
}

function findShellCommandString(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "-c" || arg === "-lc" || arg === "-cl") {
      return args.slice(i + 1).join(" ")
    }
    if (arg.startsWith("-") && arg.includes("c")) {
      return args.slice(i + 1).join(" ")
    }
  }
  return undefined
}

function splitPipelineStages(line: string): string[] {
  const stages: string[] = []
  let current = ""
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      current += char
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += char
    } else if (!inSingleQuote && !inDoubleQuote) {
      if (char === "\n" || char === ";") {
        if (current.trim()) stages.push(current.trim())
        current = ""
      } else if (char === "&" && line[i + 1] === "&") {
        if (current.trim()) stages.push(current.trim())
        current = ""
        i++
      } else if (char === "|" && line[i + 1] === "|") {
        if (current.trim()) stages.push(current.trim())
        current = ""
        i++
      } else if (char === "|") {
        if (current.trim()) stages.push(current.trim())
        current = ""
      } else {
        current += char
      }
    } else {
      current += char
    }
  }
  if (current.trim()) {
    stages.push(current.trim())
  }
  return stages
}

function tokenizeStage(stage: string): string[] {
  const tokens: string[] = []
  let current = ""
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < stage.length; i++) {
    const char = stage[i]
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
    } else if (!inSingleQuote && !inDoubleQuote && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ""
      }
    } else {
      current += char
    }
  }
  if (current.length > 0) {
    tokens.push(current)
  }
  return tokens
}

function classifyCommandLine(commandLine: string): SubprocTier {
  const stages = splitPipelineStages(commandLine)
  if (stages.length === 0) {
    return "build_test"
  }

  for (const stage of stages) {
    const rawTokens = tokenizeStage(stage)
    // Strip leading environment variable assignments (e.g. FOO=bar)
    const tokens = rawTokens.filter((t, idx) => {
      if (idx === 0 || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        return !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)
      }
      return true
    })

    if (tokens.length === 0) continue

    const firstToken = tokens[0]
    const baseCmd = getBasename(firstToken).toLowerCase()

    if (HEAVY_COMMANDS.has(baseCmd) || firstToken.endsWith(".sh")) {
      return "build_test"
    }

    if (baseCmd === "find" && tokens.some((t) => t === "-exec" || t === "-execdir")) {
      return "build_test"
    }

    if (baseCmd === "git") {
      const subCmd = tokens.slice(1).find((t) => !t.startsWith("-"))
      if (subCmd && HEAVY_GIT_SUBCOMMANDS.has(subCmd.toLowerCase())) {
        return "build_test"
      }
    }

    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i]
      const b = getBasename(t).toLowerCase()
      if (HEAVY_COMMANDS.has(b) || t.endsWith(".sh")) {
        return "build_test"
      }
    }

    if (!FAST_INSPECT_COMMANDS.has(baseCmd)) {
      return "build_test"
    }
  }

  return "fast_inspect"
}

export function classifySubprocTier(
  command: string,
  args: readonly string[] = [],
): SubprocTier {
  const baseCmd = getBasename(command).toLowerCase()

  if (SHELL_BINARIES.has(baseCmd)) {
    const shellCmd = findShellCommandString(args)
    if (shellCmd !== undefined) {
      return classifyCommandLine(shellCmd)
    }
    // Interactive shells / PTY shells without -c are build_test
    return "build_test"
  }

  const hasPipelineOps = args.some(
    (arg) =>
      arg.includes("|") ||
      arg.includes("&&") ||
      arg.includes("||") ||
      arg.includes(";"),
  )

  if (hasPipelineOps) {
    return classifyCommandLine([command, ...args].join(" "))
  }

  if (HEAVY_COMMANDS.has(baseCmd) || command.endsWith(".sh")) {
    return "build_test"
  }

  if (baseCmd === "find" && args.some((a) => a === "-exec" || a === "-execdir")) {
    return "build_test"
  }

  if (baseCmd === "git") {
    const subCmd = args.find((a) => !a.startsWith("-"))
    if (subCmd && HEAVY_GIT_SUBCOMMANDS.has(subCmd.toLowerCase())) {
      return "build_test"
    }
  }

  for (const arg of args) {
    const b = getBasename(arg).toLowerCase()
    if (HEAVY_COMMANDS.has(b) || arg.endsWith(".sh")) {
      return "build_test"
    }
  }

  if (FAST_INSPECT_COMMANDS.has(baseCmd)) {
    return "fast_inspect"
  }

  return "build_test"
}

export const FORWARDED_EXECUTION_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TERM",
  "TMPDIR",
  "VIRTUAL_ENV",
  "PYTHONPATH",
  "NODE_OPTIONS",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "GOPATH",
] as const

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function isValidEnvValue(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    !value.includes("\n") &&
    !value.includes("\r")
  )
}

export function collectSystemdSetenvArgs(
  env?: Record<string, string | undefined>,
  baseEnv: Record<string, string | undefined> = process.env,
): string[] {
  const merged = new Map<string, string>()

  for (const key of FORWARDED_EXECUTION_ENV_KEYS) {
    if (isSensitiveEnvKey(key)) continue
    const val = env && key in env ? env[key] : baseEnv[key]
    if (isValidEnvValue(val)) {
      merged.set(key, val)
    }
  }

  if (env) {
    for (const [key, val] of Object.entries(env)) {
      if (!ENV_KEY_PATTERN.test(key)) continue
      if (isSensitiveEnvKey(key) || /(?:_SECRET|_TOKEN|_PASSWORD|_API_KEY|_PRIVATE_KEY)$/i.test(key)) continue
      if (isValidEnvValue(val)) {
        merged.set(key, val)
      } else if (val === undefined) {
        merged.delete(key)
      }
    }
  }

  return Array.from(merged.entries()).map(([k, v]) => `--setenv=${k}=${v}`)
}

function resolveUnitName(tier: SubprocTier, requestId?: string): string {
  let sanitizedRequestId = ""
  if (requestId) {
    sanitizedRequestId = requestId
      .replace(/[^a-zA-Z0-9_.-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
  }
  if (!sanitizedRequestId) {
    sanitizedRequestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
  return `aquanox-subproc-${tier}-${sanitizedRequestId}`
}

export function buildSystemdRunArgs(
  command: string,
  args: readonly string[] = [],
  optionsOrSpec?:
    | (SystemdLeafWrapOptions & {
        unitName?: string
        tierSpec?: SubprocTierSpec
      })
    | SubprocTierSpec,
  unitNameArg?: string,
  optionsArg?: SystemdLeafWrapOptions,
): string[] {
  const isSpecArg =
    optionsOrSpec !== undefined &&
    typeof optionsOrSpec === "object" &&
    optionsOrSpec !== null &&
    "memoryHighMib" in optionsOrSpec &&
    "memoryMaxMib" in optionsOrSpec
  const options = isSpecArg
    ? {
        ...optionsArg,
        tierSpec: optionsOrSpec as SubprocTierSpec,
        unitName: unitNameArg,
      }
    : (optionsOrSpec as
        | (SystemdLeafWrapOptions & {
            unitName?: string
            tierSpec?: SubprocTierSpec
          })
        | undefined)

  const tier = options?.tier ?? options?.tierSpec?.tier ?? classifySubprocTier(command, args)
  const tierSpec = options?.tierSpec ?? getSubprocTierSpec(tier)
  const workingDir = options?.cwd || process.cwd()
  const unitName = options?.unitName ?? resolveUnitName(tier, options?.requestId)
  const setenvArgs = collectSystemdSetenvArgs(options?.env)

  return [
    "--quiet",
    "--collect",
    "--wait",
    "--pipe",
    `--working-directory=${workingDir}`,
    `--slice=${tierSpec.slice}`,
    `--unit=${unitName}`,
    "--nice=10",
    "-p",
    `MemoryHigh=${tierSpec.memoryHighMib}M`,
    "-p",
    `MemoryMax=${tierSpec.memoryMaxMib}M`,
    "-p",
    `MemorySwapMax=${tierSpec.memorySwapMax}`,
    "-p",
    `OOMPolicy=${tierSpec.memoryOomGroup ? "kill" : "continue"}`,
    "-p",
    `OOMScoreAdjust=${tierSpec.oomScoreAdjust}`,
    "-p",
    "AllowedCPUs=32-63",
    ...setenvArgs,
    "--",
    command,
    ...args,
  ]
}

export function buildSystemdLeafWrapCommand(
  command: string,
  args: readonly string[] = [],
  options?: SystemdLeafWrapOptions,
): SystemdLeafWrapResult {
  const tier = options?.tier ?? classifySubprocTier(command, args)
  const tierSpec = getSubprocTierSpec(tier)
  const unitName = resolveUnitName(tier, options?.requestId)

  const shouldWrap =
    options?.forceWrap === true ||
    (options?.forceWrap !== false &&
      isAquanoxLeafCgroupHostAvailable({
        platform: options?.platform,
        env: options?.env,
        existsSync: options?.existsSync,
      }))

  if (shouldWrap) {
    return {
      command: "systemd-run",
      args: buildSystemdRunArgs(command, args, {
        ...options,
        tier,
        tierSpec,
        unitName,
      }),
      unitName,
      tierSpec,
      wrapped: true,
    }
  }

  return {
    command,
    args: [...args],
    unitName,
    tierSpec,
    wrapped: false,
  }
}

export const wrapCommandInLeafCgroup = buildSystemdLeafWrapCommand
export const wrapCommandWithLeafCgroup = buildSystemdLeafWrapCommand

export function resolveWrappedLeafCgroupPath(unitName: string): string {
  const fullUnit = unitName.endsWith(".service") ? unitName : `${unitName}.service`
  try {
    if (fs.existsSync(`/sys/fs/cgroup/aquanox.slice/${AQUANOX_SUBPROCS_SLICE}`)) {
      return `/sys/fs/cgroup/aquanox.slice/${AQUANOX_SUBPROCS_SLICE}/${fullUnit}`
    }
  } catch {
    // ignore
  }
  return `/sys/fs/cgroup/${AQUANOX_SUBPROCS_SLICE}/${fullUnit}`
}

export function readProcStarttimeTicks(pid: number): number {
  if (!Number.isFinite(pid) || pid <= 0) return 0
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    const rparen = raw.lastIndexOf(")")
    if (rparen === -1) return 0
    const fields = raw.slice(rparen + 2).trim().split(/\s+/)
    if (fields.length >= 20) {
      const ticks = Number.parseInt(fields[19]!, 10)
      return Number.isFinite(ticks) && ticks > 0 ? ticks : 0
    }
  } catch {
    // ignore
  }
  return 0
}

export function resolveWrappedLeafProcessInfo(
  unitName: string,
  fallbackPid?: number,
): { pid?: number; starttimeTicks?: number; cgroupPath: string } {
  const fullUnit = unitName.endsWith(".service") ? unitName : `${unitName}.service`
  const candidates = [
    `/sys/fs/cgroup/aquanox.slice/${AQUANOX_SUBPROCS_SLICE}/${fullUnit}`,
    `/sys/fs/cgroup/${AQUANOX_SUBPROCS_SLICE}/${fullUnit}`,
  ]
  for (const cgDir of candidates) {
    try {
      const procsFile = `${cgDir}/cgroup.procs`
      if (fs.existsSync(procsFile)) {
        const content = fs.readFileSync(procsFile, "utf8").trim()
        if (content) {
          const pids = content
            .split(/\s+/)
            .map((line) => Number.parseInt(line.trim(), 10))
            .filter((n) => Number.isFinite(n) && n > 0)
          if (pids.length > 0) {
            const pid = pids[0]!
            const starttimeTicks = readProcStarttimeTicks(pid)
            return {
              pid,
              ...(starttimeTicks > 0 ? { starttimeTicks } : {}),
              cgroupPath: cgDir,
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }
  const cgroupPath = resolveWrappedLeafCgroupPath(unitName)
  if (fallbackPid !== undefined && fallbackPid > 0) {
    const starttimeTicks = readProcStarttimeTicks(fallbackPid)
    return {
      pid: fallbackPid,
      ...(starttimeTicks > 0 ? { starttimeTicks } : {}),
      cgroupPath,
    }
  }
  return { cgroupPath }
}

export function killWrappedLeafCgroupProcesses(
  unitName: string,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  const fullUnit = unitName.endsWith(".service") ? unitName : `${unitName}.service`
  const candidates = [
    `/sys/fs/cgroup/aquanox.slice/${AQUANOX_SUBPROCS_SLICE}/${fullUnit}/cgroup.procs`,
    `/sys/fs/cgroup/${AQUANOX_SUBPROCS_SLICE}/${fullUnit}/cgroup.procs`,
  ]
  const signalCgroupPids = (sig: NodeJS.Signals) => {
    for (const procsFile of candidates) {
      try {
        if (!fs.existsSync(procsFile)) continue
        const content = fs.readFileSync(procsFile, "utf8").trim()
        if (!content) continue
        const pids = content
          .split(/\s+/)
          .map((line) => Number.parseInt(line.trim(), 10))
          .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid)
        for (const pid of pids) {
          try {
            process.kill(pid, sig)
          } catch {
            // ignore ESRCH / EPERM
          }
        }
      } catch {
        // ignore
      }
    }
  }
  signalCgroupPids(signal)
  if (signal !== "SIGKILL") {
    const timer = setTimeout(() => {
      signalCgroupPids("SIGKILL")
    }, 250)
    if (typeof timer.unref === "function") {
      timer.unref()
    }
  }
}
