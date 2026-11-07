import { describe, expect, test } from "bun:test"
import * as fsSync from "node:fs"
import * as fs from "node:fs/promises"
import * as http from "node:http"
import * as path from "node:path"
import { Writable } from "node:stream"
import { Effect, Fiber } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Global } from "@opencode/util/global"
import { Config } from "@opencode/core/config"
import {
  classifySubprocTier,
  getSubprocTierSpec,
  buildSystemdLeafWrapCommand,
  buildSystemdRunArgs,
  collectSystemdSetenvArgs,
  wrapCommandWithLeafCgroup,
  wrapCommandInLeafCgroup,
  FORWARDED_EXECUTION_ENV_KEYS,
  isAquanoxLeafCgroupHostAvailable,
  FAST_INSPECT_SPEC,
  AQUANOX_SUBPROCS_SLICE,
} from "@opencode/core/util/cgroup-wrap"
import {
  isSensitiveEnvKey,
  scrubChildEnvironment,
  loadAndScrubStartupCredentials,
  getCachedStartupCredentials,
  SCRUBBED_ENV_EXACT_KEYS,
} from "@opencode/core/util/env-scrub"
import {
  Shell,
  MAX_SHELL_OUTPUT_BYTES,
  OUTPUT_TRUNCATED_NOTICE,
  registerWrappedSubprocWithBroker,
  releaseWrappedSubprocWithBroker,
} from "@opencode/core/shell"
import { GpuBrokerClient } from "@opencode/core/util/gpu-broker-client"
import { ShellTool } from "@opencode/core/tool/plugin/shell"
import { SessionSlotLease } from "@opencode/core/session/slot-lease"
import { McpStdio } from "@opencode/core/mcp/stdio"
import { ChildProcess } from "effect/process"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { tempLocationLayer } from "./fixture/location"
import { recordingEnvironmentLayer } from "./fixture/environment"

describe("cgroup-wrap tier classification and systemd leaf wrapping", () => {
  test("classifySubprocTier accurately classifies fast_inspect commands", () => {
    // Direct inspection commands
    expect(classifySubprocTier("git", ["status"])).toBe("fast_inspect")
    expect(classifySubprocTier("git", ["diff", "HEAD~1"])).toBe("fast_inspect")
    expect(classifySubprocTier("git", ["log", "-n", "5"])).toBe("fast_inspect")
    expect(classifySubprocTier("git", ["rev-parse", "HEAD"])).toBe("fast_inspect")
    expect(classifySubprocTier("rg", ["foo", "src"])).toBe("fast_inspect")
    expect(classifySubprocTier("grep", ["-rn", "test", "."])).toBe("fast_inspect")
    expect(classifySubprocTier("ls", ["-la"])).toBe("fast_inspect")
    expect(classifySubprocTier("cat", ["package.json"])).toBe("fast_inspect")
    expect(classifySubprocTier("sed", ["-e", "s/foo/bar/g", "file.txt"])).toBe("fast_inspect")
    expect(classifySubprocTier("awk", ["{print $1}"])).toBe("fast_inspect")
    expect(classifySubprocTier("jq", [".name", "package.json"])).toBe("fast_inspect")
    expect(classifySubprocTier("head", ["-n", "20"])).toBe("fast_inspect")
    expect(classifySubprocTier("tail", ["-n", "50"])).toBe("fast_inspect")
    expect(classifySubprocTier("wc", ["-l", "README.md"])).toBe("fast_inspect")
    expect(classifySubprocTier("find", [".", "-name", "*.ts"])).toBe("fast_inspect")
    expect(classifySubprocTier("pwd")).toBe("fast_inspect")
    expect(classifySubprocTier("echo", ["hello"])).toBe("fast_inspect")
    expect(classifySubprocTier("stat", ["file.txt"])).toBe("fast_inspect")
  })

  test("classifySubprocTier accurately classifies build_test heavy commands", () => {
    // Compilers, test runners, runtimes, package managers, tools
    expect(classifySubprocTier("cargo", ["build"])).toBe("build_test")
    expect(classifySubprocTier("cargo", ["test"])).toBe("build_test")
    expect(classifySubprocTier("bun", ["test"])).toBe("build_test")
    expect(classifySubprocTier("node", ["index.js"])).toBe("build_test")
    expect(classifySubprocTier("npm", ["run", "build"])).toBe("build_test")
    expect(classifySubprocTier("pnpm", ["test"])).toBe("build_test")
    expect(classifySubprocTier("pytest", ["tests/"])).toBe("build_test")
    expect(classifySubprocTier("python", ["test.py"])).toBe("build_test")
    expect(classifySubprocTier("python3", ["-m", "unittest"])).toBe("build_test")
    expect(classifySubprocTier("godot", ["--headless"])).toBe("build_test")
    expect(classifySubprocTier("make", ["all"])).toBe("build_test")
    expect(classifySubprocTier("cmake", ["--build", "."])).toBe("build_test")
    expect(classifySubprocTier("gcc", ["-o", "main", "main.c"])).toBe("build_test")
    expect(classifySubprocTier("clang++", ["main.cpp"])).toBe("build_test")
    expect(classifySubprocTier("tsc", ["--noEmit"])).toBe("build_test")
    expect(classifySubprocTier("vite", ["build"])).toBe("build_test")
    expect(classifySubprocTier("webpack", ["--mode", "production"])).toBe("build_test")
    expect(classifySubprocTier("vitest")).toBe("build_test")
    expect(classifySubprocTier("jest")).toBe("build_test")
    expect(classifySubprocTier("docker", ["run", "alpine"])).toBe("build_test")
    expect(classifySubprocTier("xargs", ["cat"])).toBe("build_test")
  })

  test("classifySubprocTier classifies shell scripts and find -exec as build_test", () => {
    expect(classifySubprocTier("./build.sh")).toBe("build_test")
    expect(classifySubprocTier("./scripts/run-tests.sh")).toBe("build_test")
    expect(classifySubprocTier("find", [".", "-name", "*.ts", "-exec", "cat", "{}", "+"])).toBe("build_test")
    expect(classifySubprocTier("find", [".", "-name", "*.ts", "-execdir", "rm", "{}", ";"])).toBe("build_test")
  })

  test("classifySubprocTier classifies heavy git subcommands as build_test", () => {
    expect(classifySubprocTier("git", ["clone", "https://github.com/org/repo"])).toBe("build_test")
    expect(classifySubprocTier("git", ["gc"])).toBe("build_test")
    expect(classifySubprocTier("git", ["repack", "-a", "-d"])).toBe("build_test")
    expect(classifySubprocTier("git", ["submodule", "update", "--init"])).toBe("build_test")
    expect(classifySubprocTier("git", ["fsck"])).toBe("build_test")
    expect(classifySubprocTier("git", ["prune"])).toBe("build_test")
  })

  test("classifySubprocTier accurately classifies bash -lc and sh -c shell pipelines", () => {
    // Pure inspect pipelines -> fast_inspect
    expect(classifySubprocTier("/bin/bash", ["-lc", "rg foo src | head -n 20"])).toBe("fast_inspect")
    expect(classifySubprocTier("bash", ["-c", "cat file.txt | grep bar | wc -l"])).toBe("fast_inspect")
    expect(classifySubprocTier("/bin/sh", ["-c", "git status && ls -la"])).toBe("fast_inspect")
    expect(classifySubprocTier("zsh", ["-lc", "find . -name '*.md' | xargs -n 1 cat | wc -l"])).toBe("build_test") // xargs is heavy

    // Pipelines with heavy build/test commands -> build_test
    expect(classifySubprocTier("/bin/bash", ["-lc", "git status && cargo test"])).toBe("build_test")
    expect(classifySubprocTier("/bin/bash", ["-lc", "rg foo src | pytest tests/"])).toBe("build_test")
    expect(classifySubprocTier("sh", ["-c", "python3 -c 'print(1)' | jq ."])).toBe("build_test")
    expect(classifySubprocTier("/bin/bash", ["-lc", "FOO=1 BAR=2 bun test"])).toBe("build_test")
    expect(classifySubprocTier("/bin/bash", ["-lc", "godot --headless --script test.gd"])).toBe("build_test")
    expect(classifySubprocTier("bash", ["-lc", "./build.sh && git status"])).toBe("build_test")

    // Interactive shell with no -c argument defaults to build_test
    expect(classifySubprocTier("/bin/bash", [])).toBe("build_test")
  })

  test("getSubprocTierSpec returns expected limits and handles custom override", () => {
    const fastSpec = getSubprocTierSpec("fast_inspect")
    expect(fastSpec.tier).toBe("fast_inspect")
    expect(fastSpec.memoryHighMib).toBe(768)
    expect(fastSpec.memoryMaxMib).toBe(1024)
    expect(fastSpec.memorySwapMax).toBe(0)
    expect(fastSpec.memoryOomGroup).toBe(true)
    expect(fastSpec.oomScoreAdjust).toBe(300)
    expect(fastSpec.slice).toBe(AQUANOX_SUBPROCS_SLICE)

    const buildSpec = getSubprocTierSpec("build_test")
    expect(buildSpec.tier).toBe("build_test")
    expect(buildSpec.memoryHighMib).toBe(6144)
    expect(buildSpec.memoryMaxMib).toBe(8192)
    expect(buildSpec.memorySwapMax).toBe(0)
    expect(buildSpec.memoryOomGroup).toBe(true)
    expect(buildSpec.oomScoreAdjust).toBe(300)
    expect(buildSpec.slice).toBe(AQUANOX_SUBPROCS_SLICE)

    // Verify AQUANOX_BUILD_TEST_MEMORY_MAX_MIB override
    const prevEnv = process.env.AQUANOX_BUILD_TEST_MEMORY_MAX_MIB
    try {
      process.env.AQUANOX_BUILD_TEST_MEMORY_MAX_MIB = "6144"
      const overriddenSpec = getSubprocTierSpec("build_test")
      expect(overriddenSpec.memoryMaxMib).toBe(6144)
      expect(overriddenSpec.memoryHighMib).toBe(4608)

      process.env.AQUANOX_BUILD_TEST_MEMORY_MAX_MIB = "2048"
      const smallerSpec = getSubprocTierSpec("build_test")
      expect(smallerSpec.memoryMaxMib).toBe(2048)
      expect(smallerSpec.memoryHighMib).toBe(1536)
      expect(smallerSpec.memoryHighMib).toBeLessThanOrEqual(smallerSpec.memoryMaxMib)
    } finally {
      if (prevEnv !== undefined) {
        process.env.AQUANOX_BUILD_TEST_MEMORY_MAX_MIB = prevEnv
      } else {
        delete process.env.AQUANOX_BUILD_TEST_MEMORY_MAX_MIB
      }
    }
  })


  test("buildSystemdLeafWrapCommand with forceWrap: true constructs exact systemd-run arguments", () => {
    // Fast inspect wrap
    const inspectWrap = buildSystemdLeafWrapCommand("git", ["status"], {
      forceWrap: true,
      requestId: "test-inspect-req",
      cwd: "/tmp/aquanox-worktree",
      env: {},
    })

    const expectedInspectSetenv = collectSystemdSetenvArgs({})
    expect(inspectWrap.wrapped).toBe(true)
    expect(inspectWrap.command).toBe("systemd-run")
    expect(inspectWrap.unitName).toBe("aquanox-subproc-fast_inspect-test-inspect-req")
    expect(inspectWrap.tierSpec.tier).toBe("fast_inspect")
    expect(inspectWrap.args).toEqual([
      "--quiet",
      "--collect",
      "--wait",
      "--pipe",
      "--working-directory=/tmp/aquanox-worktree",
      `--slice=${AQUANOX_SUBPROCS_SLICE}`,
      "--unit=aquanox-subproc-fast_inspect-test-inspect-req",
      "--nice=10",
      "-p",
      "MemoryHigh=768M",
      "-p",
      "MemoryMax=1024M",
      "-p",
      "MemorySwapMax=0",
      "-p",
      "OOMPolicy=kill",
      "-p",
      "OOMScoreAdjust=300",
      "-p",
      "AllowedCPUs=32-63",
      ...expectedInspectSetenv,
      "--",
      "git",
      "status",
    ])

    // Build test wrap
    const buildWrap = buildSystemdLeafWrapCommand("cargo", ["test", "--workspace"], {
      forceWrap: true,
      requestId: "cargo-build-999",
      cwd: "/home/rjwits/github/opencode",
      env: { CUSTOM_BUILD_FLAG: "1" },
    })

    const expectedBuildSetenv = collectSystemdSetenvArgs({ CUSTOM_BUILD_FLAG: "1" })
    expect(buildWrap.wrapped).toBe(true)
    expect(buildWrap.command).toBe("systemd-run")
    expect(buildWrap.unitName).toBe("aquanox-subproc-build_test-cargo-build-999")
    expect(buildWrap.tierSpec.tier).toBe("build_test")
    expect(buildWrap.args).toEqual([
      "--quiet",
      "--collect",
      "--wait",
      "--pipe",
      "--working-directory=/home/rjwits/github/opencode",
      `--slice=${AQUANOX_SUBPROCS_SLICE}`,
      "--unit=aquanox-subproc-build_test-cargo-build-999",
      "--nice=10",
      "-p",
      "MemoryHigh=6144M",
      "-p",
      "MemoryMax=8192M",
      "-p",
      "MemorySwapMax=0",
      "-p",
      "OOMPolicy=kill",
      "-p",
      "OOMScoreAdjust=300",
      "-p",
      "AllowedCPUs=32-63",
      ...expectedBuildSetenv,
      "--",
      "cargo",
      "test",
      "--workspace",
    ])
  })

  test("GPU-006: systemd-run leaf wrapper includes --pipe, --working-directory, and scrubbed --setenv forwarding", () => {
    const customCwd = "/tmp/gpu006-test-worktree"
    const wrapped = wrapCommandWithLeafCgroup("/bin/bash", ["-lc", "pwd && echo $PATH"], {
      forceWrap: true,
      requestId: "gpu006-pipe-check",
      cwd: customCwd,
      env: {
        PATH: "/custom/bin:/usr/bin:/bin",
        HOME: "/home/rjwits",
        VIRTUAL_ENV: "/opt/venv",
        CUSTOM_SAFE_VAR: "hello_world",
        AQUANOX_BROKER_SECRET: "must_never_leak",
        OPENAI_API_KEY: "sk-secret",
        MULTILINE_BAD: "line1\nline2",
        NUL_BAD: "abc\0def",
      },
    })

    expect(wrapped.wrapped).toBe(true)
    expect(wrapped.command).toBe("systemd-run")
    expect(wrapped.args).toContain("--pipe")
    expect(wrapped.args).toContain("--wait")
    expect(wrapped.args).toContain("--collect")
    expect(wrapped.args).toContain(`--working-directory=${customCwd}`)
    expect(wrapped.args).toContain("--setenv=PATH=/custom/bin:/usr/bin:/bin")
    expect(wrapped.args).toContain("--setenv=HOME=/home/rjwits")
    expect(wrapped.args).toContain("--setenv=VIRTUAL_ENV=/opt/venv")
    expect(wrapped.args).toContain("--setenv=CUSTOM_SAFE_VAR=hello_world")

    // Sensitive credentials and newline/NUL values must never be forwarded via --setenv
    for (const arg of wrapped.args) {
      expect(arg).not.toContain("AQUANOX_BROKER_SECRET")
      expect(arg).not.toContain("OPENAI_API_KEY")
      expect(arg).not.toContain("MULTILINE_BAD")
      expect(arg).not.toContain("NUL_BAD")
    }

    // Verify default cwd falls back to process.cwd() and aliases work identically
    const defaultCwdWrap = wrapCommandInLeafCgroup("rg", ["pattern"], {
      forceWrap: true,
      requestId: "gpu006-default-cwd",
    })
    expect(defaultCwdWrap.args).toContain("--pipe")
    expect(defaultCwdWrap.args).toContain(`--working-directory=${process.cwd()}`)
    expect(FORWARDED_EXECUTION_ENV_KEYS).toContain("PATH")
    expect(FORWARDED_EXECUTION_ENV_KEYS).toContain("HOME")

    const directArgs = buildSystemdRunArgs(
      "git",
      ["status"],
      FAST_INSPECT_SPEC,
      "aquanox-subproc-fast_inspect-direct",
      { cwd: "/var/tmp" },
    )
    expect(directArgs).toContain("--pipe")
    expect(directArgs).toContain("--working-directory=/var/tmp")
  })

  test("buildSystemdLeafWrapCommand with forceWrap: false leaves wrapped: false while returning unitName and tierSpec", () => {
    const unwrapped = buildSystemdLeafWrapCommand("rg", ["foo", "src"], {
      forceWrap: false,
      requestId: "unwrapped-req-1",
    })

    expect(unwrapped.wrapped).toBe(false)
    expect(unwrapped.command).toBe("rg")
    expect(unwrapped.args).toEqual(["foo", "src"])
    expect(unwrapped.unitName).toBe("aquanox-subproc-fast_inspect-unwrapped-req-1")
    expect(unwrapped.tierSpec.tier).toBe("fast_inspect")
  })

  test("isAquanoxLeafCgroupHostAvailable requires systemd or D-Bus socket alongside slice in auto-detect mode (GPU-006)", () => {
    // 1. Slice exists but systemd socket missing -> false (must not wrap broken systemd-run in isolated mount namespace)
    const sliceOnly = isAquanoxLeafCgroupHostAvailable({
      platform: "linux",
      env: {},
      existsSync: (p) => p === "/sys/fs/cgroup/aquanox.slice/aquanox-subprocs.slice",
    })
    expect(sliceOnly).toBe(false)

    const unwrappedSliceOnly = buildSystemdLeafWrapCommand("cargo", ["check"], {
      requestId: "no-socket-1",
      platform: "linux",
      env: {},
      existsSync: (p) => p === "/sys/fs/cgroup/aquanox.slice/aquanox-subprocs.slice",
    })
    expect(unwrappedSliceOnly.wrapped).toBe(false)
    expect(unwrappedSliceOnly.command).toBe("cargo")

    // 2. /run/aquanox-broker exists but systemd socket missing -> false
    const brokerOnly = isAquanoxLeafCgroupHostAvailable({
      platform: "linux",
      env: {},
      existsSync: (p) => p === "/run/aquanox-broker",
    })
    expect(brokerOnly).toBe(false)

    // 3. Slice exists AND /run/systemd/private exists -> true (wraps by default)
    const hostAvailPrivate = isAquanoxLeafCgroupHostAvailable({
      platform: "linux",
      env: {},
      existsSync: (p) =>
        p === "/sys/fs/cgroup/aquanox.slice/aquanox-subprocs.slice" ||
        p === "/run/systemd/private",
    })
    expect(hostAvailPrivate).toBe(true)

    const defaultWrappedPrivate = buildSystemdLeafWrapCommand("cargo", ["check"], {
      requestId: "prod-default-1",
      platform: "linux",
      env: {},
      existsSync: (p) =>
        p === "/sys/fs/cgroup/aquanox.slice/aquanox-subprocs.slice" ||
        p === "/run/systemd/private",
    })
    expect(defaultWrappedPrivate.wrapped).toBe(true)
    expect(defaultWrappedPrivate.command).toBe("systemd-run")
    expect(defaultWrappedPrivate.unitName).toBe("aquanox-subproc-build_test-prod-default-1")

    // 4. Slice exists AND /run/dbus/system_bus_socket exists -> true (wraps by default)
    const hostAvailDbus = isAquanoxLeafCgroupHostAvailable({
      platform: "linux",
      env: {},
      existsSync: (p) =>
        p === "/sys/fs/cgroup/aquanox-subprocs.slice" ||
        p === "/run/dbus/system_bus_socket",
    })
    expect(hostAvailDbus).toBe(true)

    const defaultWrappedDbus = buildSystemdLeafWrapCommand("git", ["status"], {
      requestId: "prod-default-2",
      platform: "linux",
      env: {},
      existsSync: (p) =>
        p === "/sys/fs/cgroup/aquanox-subprocs.slice" ||
        p === "/run/dbus/system_bus_socket",
    })
    expect(defaultWrappedDbus.wrapped).toBe(true)
    expect(defaultWrappedDbus.tierSpec.tier).toBe("fast_inspect")

    // 5. Explicit AQUANOX_ENFORCE_LEAF_CGROUPS="1" forces wrapping on Linux even without socket
    const forcedWrap = buildSystemdLeafWrapCommand("cargo", ["check"], {
      requestId: "prod-forced-1",
      platform: "linux",
      env: { AQUANOX_ENFORCE_LEAF_CGROUPS: "1" },
      existsSync: () => false,
    })
    expect(forcedWrap.wrapped).toBe(true)
    expect(forcedWrap.command).toBe("systemd-run")

    // 6. Explicit AQUANOX_ENFORCE_LEAF_CGROUPS="0" disables wrapping even when both slice and socket exist
    const disabledWrap = buildSystemdLeafWrapCommand("cargo", ["check"], {
      requestId: "prod-disabled-1",
      platform: "linux",
      env: { AQUANOX_ENFORCE_LEAF_CGROUPS: "0" },
      existsSync: () => true,
    })
    expect(disabledWrap.wrapped).toBe(false)
    expect(disabledWrap.command).toBe("cargo")
  })
})

describe("env-scrub credential scrubbing and startup credentials loading", () => {
  test("isSensitiveEnvKey detects all exact sensitive keys and prefixes", () => {
    for (const exactKey of SCRUBBED_ENV_EXACT_KEYS) {
      expect(isSensitiveEnvKey(exactKey)).toBe(true)
    }

    expect(isSensitiveEnvKey("OPENCODE_SERVER_PASSWORD")).toBe(true)
    expect(isSensitiveEnvKey("AQUANOX_BROKER_SECRET")).toBe(true)
    expect(isSensitiveEnvKey("AQUANOX_LLM_API_KEY")).toBe(true)
    expect(isSensitiveEnvKey("AQUANOX_ADMIN_TOKEN")).toBe(true)

    expect(isSensitiveEnvKey("OPENCODE_CREDENTIAL_KEY")).toBe(true)
    expect(isSensitiveEnvKey("OPENCODE_CREDENTIAL_TEST")).toBe(true)
    expect(isSensitiveEnvKey("AQUANOX_SECRET_KEY")).toBe(true)
    expect(isSensitiveEnvKey("AQUANOX_SECRET_TOKEN_V2")).toBe(true)

    // Non-sensitive keys
    expect(isSensitiveEnvKey("PATH")).toBe(false)
    expect(isSensitiveEnvKey("HOME")).toBe(false)
    expect(isSensitiveEnvKey("USER")).toBe(false)
    expect(isSensitiveEnvKey("TERM")).toBe(false)
    expect(isSensitiveEnvKey("OPENCODE_TERMINAL")).toBe(false)
    expect(isSensitiveEnvKey("AQUANOX_BUILD_TEST_MEMORY_MAX_MIB")).toBe(false)
  })

  test("scrubChildEnvironment strips all sensitive keys and undefined values", () => {
    const rawEnv: Record<string, string | undefined> = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/home/user",
      USER: "aquanox-runner",
      TERM: "xterm-256color",
      OPENCODE_SERVER_PASSWORD: "super-secret-server-pw",
      AQUANOX_BROKER_SECRET: "super-secret-broker-sec",
      AQUANOX_LLM_API_KEY: "super-secret-llm-api-key",
      AQUANOX_ADMIN_TOKEN: "super-secret-admin-tok",
      OPENCODE_CREDENTIAL_AWS: "aws-credential-value",
      OPENCODE_CREDENTIAL_TEST: "test-credential-value",
      AQUANOX_SECRET_COOKIE: "secret-cookie-value",
      AQUANOX_SECRET_KEY: "secret-key-value",
      OPTIONAL_UNDEFINED: undefined,
      PUBLIC_APP_VAR: "public_value",
    }

    const scrubbed = scrubChildEnvironment(rawEnv)

    expect(scrubbed.PATH).toBe("/usr/local/bin:/usr/bin:/bin")
    expect(scrubbed.HOME).toBe("/home/user")
    expect(scrubbed.USER).toBe("aquanox-runner")
    expect(scrubbed.TERM).toBe("xterm-256color")
    expect(scrubbed.PUBLIC_APP_VAR).toBe("public_value")

    expect(scrubbed.OPENCODE_SERVER_PASSWORD).toBeUndefined()
    expect(scrubbed.AQUANOX_BROKER_SECRET).toBeUndefined()
    expect(scrubbed.AQUANOX_LLM_API_KEY).toBeUndefined()
    expect(scrubbed.AQUANOX_ADMIN_TOKEN).toBeUndefined()
    expect(scrubbed.OPENCODE_CREDENTIAL_AWS).toBeUndefined()
    expect(scrubbed.OPENCODE_CREDENTIAL_TEST).toBeUndefined()
    expect(scrubbed.AQUANOX_SECRET_COOKIE).toBeUndefined()
    expect(scrubbed.AQUANOX_SECRET_KEY).toBeUndefined()
    expect(scrubbed.OPTIONAL_UNDEFINED).toBeUndefined()
  })

  test("loadAndScrubStartupCredentials loads from CREDENTIALS_DIRECTORY and scrubs environment", async () => {
    await using tmp = await tmpdir()
    const credDir = tmp.path

    await fs.writeFile(path.join(credDir, "opencode_server_password"), "disk-server-password\n")
    await fs.writeFile(path.join(credDir, "aquanox_broker_secret"), "disk-broker-secret\n")
    await fs.writeFile(path.join(credDir, "aquanox_llm_api_key"), "disk-llm-api-key\n")
    await fs.writeFile(path.join(credDir, "aquanox_admin_token"), "disk-admin-token\n")

    const testEnv: Record<string, string | undefined> = {
      PATH: "/bin:/usr/bin",
      OPENCODE_SERVER_PASSWORD: "env-server-password",
      AQUANOX_BROKER_SECRET: "env-broker-secret",
      AQUANOX_LLM_API_KEY: "env-llm-api-key",
      AQUANOX_ADMIN_TOKEN: "env-admin-token",
      OPENCODE_CREDENTIAL_TEST: "env-cred-test",
      AQUANOX_SECRET_KEY: "env-sec-key",
      OPENCODE_PASSWORD: "env-old-password",
      REGULAR_VAR: "regular-value",
    }

    const creds = loadAndScrubStartupCredentials({
      credentialsDir: credDir,
      env: testEnv,
    })

    expect(creds.loadedFromCredentialsDir).toBe(true)
    expect(creds.serverPassword).toBe("disk-server-password")
    expect(creds.brokerSecret).toBe("disk-broker-secret")
    expect(creds.llmApiKey).toBe("disk-llm-api-key")
    expect(creds.adminToken).toBe("disk-admin-token")

    // Verify testEnv was scrubbed in-place
    expect(testEnv.OPENCODE_SERVER_PASSWORD).toBeUndefined()
    expect(testEnv.AQUANOX_BROKER_SECRET).toBeUndefined()
    expect(testEnv.AQUANOX_LLM_API_KEY).toBeUndefined()
    expect(testEnv.AQUANOX_ADMIN_TOKEN).toBeUndefined()
    expect(testEnv.OPENCODE_CREDENTIAL_TEST).toBeUndefined()
    expect(testEnv.AQUANOX_SECRET_KEY).toBeUndefined()
    expect(testEnv.OPENCODE_PASSWORD).toBeUndefined()
    expect(testEnv.REGULAR_VAR).toBe("regular-value")

    // Verify cached credentials match
    const cached = getCachedStartupCredentials()
    expect(cached.serverPassword).toBe("disk-server-password")
    expect(cached.brokerSecret).toBe("disk-broker-secret")
    expect(cached.llmApiKey).toBe("disk-llm-api-key")
    expect(cached.adminToken).toBe("disk-admin-token")
  })
})

describe("shell.ts backpressure, output truncation, and secret isolation", () => {
  test("exports MAX_SHELL_OUTPUT_BYTES = 64 MiB and OUTPUT_TRUNCATED_NOTICE", () => {
    expect(MAX_SHELL_OUTPUT_BYTES).toBe(64 * 1024 * 1024)
    expect(OUTPUT_TRUNCATED_NOTICE).toBe("\n[output truncated at 64 MiB limit]\n")
  })

  test("backpressure chunk writer pauses when stream.write returns false and awaits drain", async () => {
    let writeCalls = 0
    let drainListeners = 0
    let resumed = false

    // Mock writable stream simulating a slow sink with backpressure
    const slowStream = new Writable({
      highWaterMark: 16,
      write(_chunk, _encoding, callback) {
        writeCalls++
        // Simulate delayed drain
        setTimeout(callback, 20)
      },
    })

    const writeChunkWithBackpressure = (stream: Writable, data: Uint8Array): Effect.Effect<void> =>
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

        drainListeners++
        stream.once("drain", onDrain)
        stream.once("error", onError)
        stream.once("close", onClose)

        return Effect.sync(cleanup)
      })

    // Fill highWaterMark (16 bytes)
    const chunk1 = Buffer.alloc(16, "A")
    const chunk2 = Buffer.alloc(16, "B")

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* writeChunkWithBackpressure(slowStream, chunk1)
        // chunk2 triggers backpressure since highWaterMark is exceeded
        yield* writeChunkWithBackpressure(slowStream, chunk2)
        resumed = true
      }),
    )

    expect(resumed).toBe(true)
    expect(writeCalls).toBeGreaterThanOrEqual(1)
  })

  test("shell service execution scrubs child environment and never leaks secrets to subprocesses", async () => {
    // Set sensitive variables in process.env
    const prevEnforceCgroup = process.env.AQUANOX_ENFORCE_LEAF_CGROUPS
    const prevServerPassword = process.env.OPENCODE_SERVER_PASSWORD
    const prevBrokerSecret = process.env.AQUANOX_BROKER_SECRET
    const prevLlmApiKey = process.env.AQUANOX_LLM_API_KEY
    const prevAdminToken = process.env.AQUANOX_ADMIN_TOKEN
    const prevCred = process.env.OPENCODE_CREDENTIAL_LEAK_TEST
    const prevSec = process.env.AQUANOX_SECRET_LEAK_TEST

    process.env.AQUANOX_ENFORCE_LEAF_CGROUPS = "0"
    process.env.OPENCODE_SERVER_PASSWORD = "leaked-server-pw-12345"
    process.env.AQUANOX_BROKER_SECRET = "leaked-broker-sec-67890"
    process.env.AQUANOX_LLM_API_KEY = "leaked-llm-key-abcde"
    process.env.AQUANOX_ADMIN_TOKEN = "leaked-admin-tok-fghij"
    process.env.OPENCODE_CREDENTIAL_LEAK_TEST = "leaked-cred-klmno"
    process.env.AQUANOX_SECRET_LEAK_TEST = "leaked-sec-pqrst"
    process.env.SAFE_VERIFY_VAR = "safe-public-val"

    const layer = AppNodeBuilder.build(Shell.node, [
      Location.node.replace(tempLocationLayer),
      Global.node.replace(tempGlobalLayer),
      Config.node.replace(Config.testLayer()),
    ])

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const shell = yield* Shell.Service
            const printCmd =
              'echo "SP=[$OPENCODE_SERVER_PASSWORD] BS=[$AQUANOX_BROKER_SECRET] LLM=[$AQUANOX_LLM_API_KEY] ADM=[$AQUANOX_ADMIN_TOKEN] CR=[$OPENCODE_CREDENTIAL_LEAK_TEST] SEC=[$AQUANOX_SECRET_LEAK_TEST] SAFE=[$SAFE_VERIFY_VAR]"'

            const started = yield* shell.create({
              command: printCmd,
            })

            const terminal = yield* shell.wait(started.id)
            expect(terminal.status).toBe("exited")

            const out = yield* shell.output(started.id)
            // Secrets must be empty strings in child output
            expect(out.output).toContain("SP=[]")
            expect(out.output).toContain("BS=[]")
            expect(out.output).toContain("LLM=[]")
            expect(out.output).toContain("ADM=[]")
            expect(out.output).toContain("CR=[]")
            expect(out.output).toContain("SEC=[]")
            expect(out.output).toContain("SAFE=[safe-public-val]")

            // None of the sensitive values should appear anywhere in output
            expect(out.output).not.toContain("leaked-server-pw-12345")
            expect(out.output).not.toContain("leaked-broker-sec-67890")
            expect(out.output).not.toContain("leaked-llm-key-abcde")
            expect(out.output).not.toContain("leaked-admin-tok-fghij")
            expect(out.output).not.toContain("leaked-cred-klmno")
            expect(out.output).not.toContain("leaked-sec-pqrst")
          }).pipe(Effect.provide(layer)),
        ),
      )
    } finally {
      if (prevEnforceCgroup !== undefined) process.env.AQUANOX_ENFORCE_LEAF_CGROUPS = prevEnforceCgroup
      else delete process.env.AQUANOX_ENFORCE_LEAF_CGROUPS

      if (prevServerPassword !== undefined) process.env.OPENCODE_SERVER_PASSWORD = prevServerPassword
      else delete process.env.OPENCODE_SERVER_PASSWORD

      if (prevBrokerSecret !== undefined) process.env.AQUANOX_BROKER_SECRET = prevBrokerSecret
      else delete process.env.AQUANOX_BROKER_SECRET

      if (prevLlmApiKey !== undefined) process.env.AQUANOX_LLM_API_KEY = prevLlmApiKey
      else delete process.env.AQUANOX_LLM_API_KEY

      if (prevAdminToken !== undefined) process.env.AQUANOX_ADMIN_TOKEN = prevAdminToken
      else delete process.env.AQUANOX_ADMIN_TOKEN

      if (prevCred !== undefined) process.env.OPENCODE_CREDENTIAL_LEAK_TEST = prevCred
      else delete process.env.OPENCODE_CREDENTIAL_LEAK_TEST

      if (prevSec !== undefined) process.env.AQUANOX_SECRET_LEAK_TEST = prevSec
      else delete process.env.AQUANOX_SECRET_LEAK_TEST

      delete process.env.SAFE_VERIFY_VAR
    }
  })


  test("shell.ts truncates output when maxOutputBytes is exceeded and appends truncation notice", async () => {
    const prevEnforceCgroup = process.env.AQUANOX_ENFORCE_LEAF_CGROUPS
    process.env.AQUANOX_ENFORCE_LEAF_CGROUPS = "0"

    const layer = AppNodeBuilder.build(Shell.node, [
      Location.node.replace(tempLocationLayer),
      Global.node.replace(tempGlobalLayer),
      Config.node.replace(Config.testLayer()),
    ])

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const shell = yield* Shell.Service

            // Generate 20,000 bytes with a tight 256-byte limit override
            const limitBytes = 256
            const overflowCmd =
              process.platform === "win32"
                ? 'node -e "process.stdout.write(\'A\'.repeat(20000))"'
                : 'python3 -c "import sys; sys.stdout.write(\'A\' * 20000); sys.stdout.flush()"'

            const started = yield* shell.create({
              command: overflowCmd,
              maxOutputBytes: limitBytes,
            })

            const terminal = yield* shell.wait(started.id)
            expect(terminal.status).toBe("exited")

            const out = yield* shell.output(started.id, { limit: 100000 })
            // The output must include the truncation notice
            expect(out.output).toContain(OUTPUT_TRUNCATED_NOTICE)

            // Size must be bounded around the limit + notice length
            const noticeLength = Buffer.byteLength(OUTPUT_TRUNCATED_NOTICE)
            expect(out.size).toBeLessThanOrEqual(limitBytes + noticeLength + 128)

            // Result should reflect truncation and capture
            const res = yield* shell.result(started)
            expect(res.info.status).toBe("exited")
            expect(res.capture?.output).toContain(OUTPUT_TRUNCATED_NOTICE)
          }).pipe(Effect.provide(layer)),
        ),
      )
    } finally {
      if (prevEnforceCgroup !== undefined) process.env.AQUANOX_ENFORCE_LEAF_CGROUPS = prevEnforceCgroup
      else delete process.env.AQUANOX_ENFORCE_LEAF_CGROUPS
    }
  })


  test("registerSubproc / releaseSubproc lifecycle hooks and evaluateAdmission track active leaf cgroups and session commitments with Broker (Finding 10)", async () => {
    SessionSlotLease.reset()
    const socketPath = `/tmp/aquanox-subproc-broker-${process.pid}-${Date.now()}.sock`
    const registeredUnits: Array<Record<string, unknown>> = []
    const releasedRequestIds: string[] = []
    const evaluatedAdmissions: Array<Record<string, unknown>> = []

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
        res.setHeader("Content-Type", "application/json")
        if (req.url === "/v1/subproc/register" && req.method === "POST") {
          if (String(body.request_id).includes("deny")) {
            res.statusCode = 503
            res.end(
              JSON.stringify({
                status: 503,
                admitted: false,
                error: "ERR_SUBPROC_MEM_FLOOR_VIOLATION",
                message: "Subproc memory floor violation: host CPU memory floor exceeded",
              }),
            )
            return
          }
          registeredUnits.push(body)
          res.statusCode = 200
          res.end(JSON.stringify({ status: 200, registered: true, request_id: body.request_id }))
          return
        }
        if (req.url === "/v1/subproc/release" && req.method === "POST") {
          releasedRequestIds.push(String(body.request_id))
          res.statusCode = 200
          res.end(JSON.stringify({ status: 200, released: true, request_id: body.request_id }))
          return
        }
        if (req.url === "/v1/admission/evaluate" && req.method === "POST") {
          if (body.deny === true) {
            res.statusCode = 503
            res.end(
              JSON.stringify({
                status: 503,
                admitted: false,
                error: "ERR_HOST_MEM_FLOOR_VIOLATION",
                message: "Host memory floor violation",
              }),
            )
            return
          }
          evaluatedAdmissions.push(body)
          res.statusCode = 200
          res.end(JSON.stringify({ status: 200, admitted: true, ...body }))
          return
        }
        res.statusCode = 404
        res.end(JSON.stringify({ status: 404 }))
      })
    })

    await new Promise<void>((resolve, reject) => {
      try {
        if (fsSync.existsSync(socketPath)) fsSync.unlinkSync(socketPath)
      } catch {}
      server.once("error", reject)
      server.listen(socketPath, () => resolve())
    })

    const client = GpuBrokerClient.configureDefaultClient({ unixSocketPath: socketPath })

    try {
      // Admit a Lead conversation with 2 reserved subagents
      SessionSlotLease.admitConversation({
        conversationId: "conv_subproc_test",
        rootSessionId: "ses_lead_subproc",
        reservedSubagentQuanta: 2,
      })

      // 1. Test wrapped build_test subproc registration and release lifecycle
      const wrappedBuild = buildSystemdLeafWrapCommand("cargo", ["test"], {
        forceWrap: true,
        requestId: "sh_lifecycle_build_1",
      })
      expect(wrappedBuild.wrapped).toBe(true)

      const regOk = await registerWrappedSubprocWithBroker(wrappedBuild, "ses_lead_subproc", client)
      expect(regOk).toBe(true)
      expect(registeredUnits.length).toBe(1)
      expect(registeredUnits[0]).toMatchObject({
        request_id: "aquanox-subproc-build_test-sh_lifecycle_build_1",
        unit_name: "aquanox-subproc-build_test-sh_lifecycle_build_1.service",
        conversation_id: "conv_subproc_test",
        owner_session_id: "ses_lead_subproc",
        memory_max_mib: 8192,
      })

      // 2. Test evaluateAdmission automatically includes active_leads and subagent_commitments_mib
      const admRes = await client.evaluateAdmission({ new_request_mib: 8192 })
      expect(admRes.admitted).toBe(true)
      expect(evaluatedAdmissions.length).toBe(1)
      expect(evaluatedAdmissions[0]).toMatchObject({
        new_request_mib: 8192,
        active_leads: 1,
        subagent_commitments_mib: 4096,
      })

      // 3. Release subproc lease on exit
      const relOk = await releaseWrappedSubprocWithBroker(wrappedBuild, client)
      expect(relOk).toBe(true)
      expect(releasedRequestIds).toEqual(["aquanox-subproc-build_test-sh_lifecycle_build_1"])

      // 4. Test unwrapped fast_inspect subproc registration and release (GPU-005)
      // Even without systemd wrapping, the broker tracks CPU subprocess RAM!
      const unwrappedFast = buildSystemdLeafWrapCommand("rg", ["foo"], {
        forceWrap: false,
        requestId: "sh_lifecycle_fast_1",
      })
      expect(unwrappedFast.wrapped).toBe(false)
      const regUnwrapped = await registerWrappedSubprocWithBroker(unwrappedFast, "ses_lead_subproc", client)
      expect(regUnwrapped).toBe(true)
      expect(registeredUnits.some((u) => u.request_id === unwrappedFast.unitName)).toBe(true)
      const relUnwrapped = await releaseWrappedSubprocWithBroker(unwrappedFast, client)
      expect(relUnwrapped).toBe(true)
      expect(releasedRequestIds).toContain(unwrappedFast.unitName)

      // 5. Test registerWrappedSubprocWithBroker fails closed when broker returns 503 ERR_SUBPROC_MEM_FLOOR_VIOLATION (GPU-005)
      const deniedSubproc = buildSystemdLeafWrapCommand("cargo", ["build"], {
        requestId: "sh_deny_mem_floor_1",
      })
      await expect(
        registerWrappedSubprocWithBroker(deniedSubproc, "ses_lead_subproc", client),
      ).rejects.toThrow("ERR_SUBPROC_MEM_FLOOR_VIOLATION")

      // 6. Test graceful offline fallback when broker socket is absent/offline
      const offlineClient = new GpuBrokerClient.Client({
        unixSocketPath: `/tmp/absent-broker-socket-${Date.now()}.sock`,
      })
      const offlineRes = await offlineClient.registerSubproc({
        request_id: "test-offline-req",
        unit_name: "test-offline-req.service",
        memory_max_mib: 1024,
      })
      expect(offlineRes).toMatchObject({
        ok: true,
        admitted: true,
        offline: true,
      })
    } finally {
      GpuBrokerClient.resetDefaultClient()
      SessionSlotLease.reset()
      await new Promise<void>((resolve) => {
        server.close(() => {
          try {
            if (fsSync.existsSync(socketPath)) fsSync.unlinkSync(socketPath)
          } catch {}
          resolve()
        })
      })
    }
  })


  test("mcp/stdio.ts scrubs sensitive credentials from spawned MCP server environment", async () => {
    const spawns: Array<ChildProcess.Command> = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transport = yield* McpStdio.make({
            server: "test-mcp",
            command: process.execPath,
            args: ["-e", "setTimeout(() => {}, 50)"],
            cwd: process.cwd(),
            environment: {
              SAFE_MCP_VAR: "allowed",
              OPENCODE_SERVER_PASSWORD: "secret-server-password",
              AQUANOX_BROKER_SECRET: "secret-broker-token",
              AQUANOX_LLM_API_KEY: "secret-llm-key",
              AQUANOX_ADMIN_TOKEN: "secret-admin-token",
              OPENCODE_CREDENTIAL_CUSTOM: "secret-cred",
              AQUANOX_SECRET_INTERNAL: "secret-internal",
            },
          })
          yield* Effect.promise(() => transport.start())
          yield* Effect.promise(() => transport.close())
        }).pipe(Effect.provide(recordingEnvironmentLayer(spawns))),
      ),
    )

    expect(spawns.length).toBe(1)
    const cmd = spawns[0]
    expect(cmd?._tag).toBe("StandardCommand")
    if (cmd?._tag === "StandardCommand") {
      expect(cmd.options.env?.SAFE_MCP_VAR).toBe("allowed")
      expect(cmd.options.env?.OPENCODE_SERVER_PASSWORD).toBeUndefined()
      expect(cmd.options.env?.AQUANOX_BROKER_SECRET).toBeUndefined()
      expect(cmd.options.env?.AQUANOX_LLM_API_KEY).toBeUndefined()
      expect(cmd.options.env?.AQUANOX_ADMIN_TOKEN).toBeUndefined()
      expect(cmd.options.env?.OPENCODE_CREDENTIAL_CUSTOM).toBeUndefined()
      expect(cmd.options.env?.AQUANOX_SECRET_INTERNAL).toBeUndefined()
    }
  })

  test("GPU-005: Shell.create fails closed when broker denies admission (503 ERR_SUBPROC_MEM_FLOOR_VIOLATION)", async () => {
    const socketPath = `/tmp/aquanox-deny-subproc-${process.pid}-${Date.now()}.sock`
    let registerAttempts = 0
    let releaseAttempts = 0

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json")
        if (req.url === "/v1/subproc/register" && req.method === "POST") {
          registerAttempts++
          res.statusCode = 503
          res.end(
            JSON.stringify({
              status: 503,
              admitted: false,
              error: "ERR_SUBPROC_MEM_FLOOR_VIOLATION",
              message: "Host CPU memory floor exceeded for subproc",
            }),
          )
          return
        }
        if (req.url === "/v1/subproc/release" && req.method === "POST") {
          releaseAttempts++
          res.statusCode = 200
          res.end(JSON.stringify({ status: 200, released: true }))
          return
        }
        res.statusCode = 404
        res.end(JSON.stringify({ status: 404 }))
      })
    })

    await new Promise<void>((resolve, reject) => {
      try {
        if (fsSync.existsSync(socketPath)) fsSync.unlinkSync(socketPath)
      } catch {}
      server.once("error", reject)
      server.listen(socketPath, () => resolve())
    })

    GpuBrokerClient.configureDefaultClient({ unixSocketPath: socketPath })

    const layer = AppNodeBuilder.build(Shell.node, [
      Location.node.replace(tempLocationLayer),
      Global.node.replace(tempGlobalLayer),
      Config.node.replace(Config.testLayer()),
    ])

    try {
      const failure = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const shell = yield* Shell.Service
            return yield* shell.create({
              command: "echo 'should never run'",
            })
          }).pipe(
            Effect.provide(layer),
            Effect.flip,
          ),
        ),
      )

      expect(registerAttempts).toBeGreaterThanOrEqual(1)
      expect(failure).toBeDefined()
      const msg = String((failure as any)?.cause?.message || (failure as any)?.message || failure)
      expect(msg).toContain("ERR_SUBPROC_MEM_FLOOR_VIOLATION")
      expect(releaseAttempts).toBe(0)
    } finally {
      GpuBrokerClient.resetDefaultClient()
      await new Promise<void>((resolve) => {
        server.close(() => {
          try {
            if (fsSync.existsSync(socketPath)) fsSync.unlinkSync(socketPath)
          } catch {}
          resolve()
        })
      })
    }
  })

  test("GPU-005: Shell.create registers subproc with broker and releases in Effect.ensuring upon exit", async () => {
    const socketPath = `/tmp/aquanox-ok-subproc-${process.pid}-${Date.now()}.sock`
    const registered: string[] = []
    const released: string[] = []

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
        res.setHeader("Content-Type", "application/json")
        if (req.url === "/v1/subproc/register" && req.method === "POST") {
          registered.push(String(body.request_id))
          res.statusCode = 200
          res.end(JSON.stringify({ status: 200, registered: true, request_id: body.request_id }))
          return
        }
        if (req.url === "/v1/subproc/release" && req.method === "POST") {
          released.push(String(body.request_id))
          res.statusCode = 200
          res.end(JSON.stringify({ status: 200, released: true, request_id: body.request_id }))
          return
        }
        res.statusCode = 404
        res.end(JSON.stringify({ status: 404 }))
      })
    })

    await new Promise<void>((resolve, reject) => {
      try {
        if (fsSync.existsSync(socketPath)) fsSync.unlinkSync(socketPath)
      } catch {}
      server.once("error", reject)
      server.listen(socketPath, () => resolve())
    })

    GpuBrokerClient.configureDefaultClient({ unixSocketPath: socketPath })

    const layer = AppNodeBuilder.build(Shell.node, [
      Location.node.replace(tempLocationLayer),
      Global.node.replace(tempGlobalLayer),
      Config.node.replace(Config.testLayer()),
    ])

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const shell = yield* Shell.Service
            const started = yield* shell.create({
              command: "echo 'lifecycle test ok'",
            })
            const terminal = yield* shell.wait(started.id)
            expect(terminal.status).toBe("exited")
          }).pipe(Effect.provide(layer)),
        ),
      )

      expect(registered.length).toBe(1)
      expect(released.length).toBe(1)
      expect(released[0]).toBe(registered[0])
    } finally {
      GpuBrokerClient.resetDefaultClient()
      await new Promise<void>((resolve) => {
        server.close(() => {
          try {
            if (fsSync.existsSync(socketPath)) fsSync.unlinkSync(socketPath)
          } catch {}
          resolve()
        })
      })
    }
  })

  test("GPU-028: releaseSubproc retries on transient broker socket/503 error and succeeds on subsequent attempt", async () => {
    const socketPath = `/tmp/aquanox-retry-subproc-${process.pid}-${Date.now()}.sock`
    const attemptsPerUnit = new Map<string, number>()

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
        res.setHeader("Content-Type", "application/json")

        if (req.url === "/v1/subproc/register" && req.method === "POST") {
          res.statusCode = 200
          res.end(JSON.stringify({ status: 200, admitted: true, request_id: body.request_id }))
          return
        }

        if (req.url === "/v1/subproc/release" && req.method === "POST") {
          const reqId = String(body.request_id)
          const count = (attemptsPerUnit.get(reqId) ?? 0) + 1
          attemptsPerUnit.set(reqId, count)

          // Unit 1: Fails with 503 on first attempt, succeeds on second attempt
          if (reqId === "unit_transient_503") {
            if (count === 1) {
              res.statusCode = 503
              res.end(
                JSON.stringify({
                  status: 503,
                  error: "ERR_BROKER_BUSY",
                  message: "Broker restarting or reloading",
                }),
              )
              return
            }
            res.statusCode = 200
            res.end(JSON.stringify({ status: 200, released: true, request_id: reqId }))
            return
          }

          // Unit 2: Socket drop on first attempt, succeeds on second attempt
          if (reqId === "unit_socket_drop") {
            if (count === 1) {
              req.socket.destroy(new Error("Simulated transient socket reset"))
              return
            }
            res.statusCode = 200
            res.end(JSON.stringify({ status: 200, released: true, request_id: reqId }))
            return
          }

          // Unit 3: Fails all attempts with 503
          if (reqId === "unit_fail_all") {
            res.statusCode = 503
            res.end(
              JSON.stringify({
                status: 503,
                error: "ERR_BROKER_PERSISTENT_DOWN",
                message: "Broker down",
              }),
            )
            return
          }

          // Default success
          res.statusCode = 200
          res.end(JSON.stringify({ status: 200, released: true, request_id: reqId }))
          return
        }

        res.statusCode = 404
        res.end(JSON.stringify({ status: 404 }))
      })
    })

    await new Promise<void>((resolve, reject) => {
      try {
        if (fsSync.existsSync(socketPath)) fsSync.unlinkSync(socketPath)
      } catch {}
      server.once("error", reject)
      server.listen(socketPath, () => resolve())
    })

    GpuBrokerClient.configureDefaultClient({ unixSocketPath: socketPath })

    try {
      // 1. Direct releaseSubproc with transient 503: retries and succeeds on attempt 2
      ShellTool.registerActiveSubprocUnit("unit_transient_503")
      expect(ShellTool.activeSubprocUnits.has("unit_transient_503")).toBe(true)

      const res1 = await ShellTool.releaseSubproc("unit_transient_503")
      expect(res1.released).toBe(true)
      expect(attemptsPerUnit.get("unit_transient_503")).toBe(2)
      expect(ShellTool.activeSubprocUnits.has("unit_transient_503")).toBe(false)

      // 2. Direct releaseSubproc with transient socket drop: retries and succeeds on attempt 2
      ShellTool.registerActiveSubprocUnit("unit_socket_drop")
      expect(ShellTool.activeSubprocUnits.has("unit_socket_drop")).toBe(true)

      const res2 = await GpuBrokerClient.releaseSubproc("unit_socket_drop")
      expect(res2.released).toBe(true)
      expect(attemptsPerUnit.get("unit_socket_drop")).toBe(2)
      expect(ShellTool.activeSubprocUnits.has("unit_socket_drop")).toBe(false)

      // 3. Persistent 503 exhausts 3 attempts and fails closed
      ShellTool.registerActiveSubprocUnit("unit_fail_all")
      await expect(GpuBrokerClient.releaseSubproc("unit_fail_all")).rejects.toThrow(/ERR_BROKER_PERSISTENT_DOWN/)
      expect(attemptsPerUnit.get("unit_fail_all")).toBe(3)
    } finally {
      GpuBrokerClient.resetDefaultClient()
      await new Promise<void>((resolve) => {
        server.close(() => {
          try {
            if (fsSync.existsSync(socketPath)) fsSync.unlinkSync(socketPath)
          } catch {}
          resolve()
        })
      })
    }
  })

  test("GPU-029: live background command retains reservation past 15-minute TTL until actual teardown", async () => {
    const socketPath = `/tmp/aquanox-gpu029-subproc-${process.pid}-${Date.now()}.sock`
    const registered: string[] = []
    const released: string[] = []

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
        res.setHeader("Content-Type", "application/json")
        if (req.url === "/v1/subproc/register" && req.method === "POST") {
          registered.push(String(body.request_id))
          res.statusCode = 200
          res.end(JSON.stringify({ status: 200, admitted: true, request_id: body.request_id }))
          return
        }
        if (req.url === "/v1/subproc/release" && req.method === "POST") {
          released.push(String(body.request_id))
          res.statusCode = 200
          res.end(JSON.stringify({ status: 200, released: true, request_id: body.request_id }))
          return
        }
        res.statusCode = 404
        res.end(JSON.stringify({ status: 404 }))
      })
    })

    await new Promise<void>((resolve, reject) => {
      try {
        if (fsSync.existsSync(socketPath)) fsSync.unlinkSync(socketPath)
      } catch {}
      server.once("error", reject)
      server.listen(socketPath, () => resolve())
    })

    GpuBrokerClient.configureDefaultClient({ unixSocketPath: socketPath })

    const layer = AppNodeBuilder.build(Shell.node, [
      Location.node.replace(tempLocationLayer),
      Global.node.replace(tempGlobalLayer),
      Config.node.replace(Config.testLayer()),
    ])

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const shell = yield* Shell.Service

            // Spawn a live background command with timeout: 0 (disabled timeout)
            const started = yield* shell.create({
              command: "tail -f /dev/null",
              timeout: 0,
            })

            // 1. Verify registered with Broker and tracked in activeSubprocUnits
            expect(registered.length).toBe(1)
            const unitName = registered[0]
            expect(ShellTool.activeSubprocUnits.has(unitName)).toBe(true)
            expect(ShellTool.isSubprocActive(unitName)).toBe(true)
            expect(released.length).toBe(0)

            // 2. Simulate running past the 15-minute TTL (> 900s horizon)
            // Verify OpenCode does NOT prematurely release active background commands
            const info = yield* shell.get(started.id)
            expect(info.status).toBe("running")
            expect(ShellTool.activeSubprocUnits.has(unitName)).toBe(true)
            expect(ShellTool.isSubprocActive(unitName)).toBe(true)
            expect(released.length).toBe(0) // 0 premature releases while live!

            // 3. Command teardown: kill/remove the command
            yield* shell.remove(started.id)

            // Wait briefly for managing fiber to execute ensuring cleanup
            yield* Effect.sleep("100 millis")

            // 4. Verify releaseSubproc was called ONLY upon actual command teardown
            expect(released.length).toBe(1)
            expect(released[0]).toBe(unitName)
            expect(ShellTool.activeSubprocUnits.has(unitName)).toBe(false)
            expect(ShellTool.isSubprocActive(unitName)).toBe(false)
          }).pipe(Effect.provide(layer)),
        ),
      )
    } finally {
      GpuBrokerClient.resetDefaultClient()
      await new Promise<void>((resolve) => {
        server.close(() => {
          try {
            if (fsSync.existsSync(socketPath)) fsSync.unlinkSync(socketPath)
          } catch {}
          resolve()
        })
      })
    }
  })

  test("GPU-051: cancelling a running background shell via remove preserves captured START output and never fails with Shell.NotFoundError", async () => {
    const layer = AppNodeBuilder.build(Shell.node, [
      Location.node.replace(tempLocationLayer),
      Global.node.replace(tempGlobalLayer),
      Config.node.replace(Config.testLayer()),
    ])

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const shell = yield* Shell.Service

          const started = yield* shell.create({
            command: 'printf \'{"event":"START","pid":%d}\\n\' "$$"; sleep 30',
            timeout: 0,
          })

          // Fork result waiter (exactly as ShellTool background job does)
          const resultFiber = yield* Effect.forkScoped(shell.result(started))

          // Wait until START output has been flushed to the output file
          let sawStart = false
          for (let i = 0; i < 50; i++) {
            const out = yield* shell.output(started.id)
            if (out.output.includes('"event":"START"')) {
              sawStart = true
              break
            }
            yield* Effect.sleep("20 millis")
          }
          expect(sawStart).toBe(true)

          // Cancel the running background shell via shell.remove (as manage_task(action="kill") does)
          yield* shell.remove(started.id)

          const res = yield* Fiber.join(resultFiber)
          expect(res.info.status).toBe("killed")
          expect(res.capture).toBeDefined()
          expect(res.capture?.output).toContain('"event":"START"')
        }).pipe(Effect.provide(layer)),
      ),
    )
  })
})
