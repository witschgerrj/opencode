import * as fs from "node:fs"
import * as path from "node:path"

export const SCRUBBED_ENV_EXACT_KEYS = [
  "OPENCODE_SERVER_PASSWORD",
  "AQUANOX_BROKER_SECRET",
  "AQUANOX_LLM_API_KEY",
  "AQUANOX_ADMIN_TOKEN",
] as const

export const SCRUBBED_ENV_PREFIXES = [
  "OPENCODE_CREDENTIAL_",
  "AQUANOX_SECRET_",
] as const

export function isSensitiveEnvKey(key: string): boolean {
  if ((SCRUBBED_ENV_EXACT_KEYS as readonly string[]).includes(key)) {
    return true
  }
  for (const prefix of SCRUBBED_ENV_PREFIXES) {
    if (key.startsWith(prefix)) {
      return true
    }
  }
  return false
}

export function scrubChildEnvironment(
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined && !isSensitiveEnvKey(key)) {
      result[key] = value
    }
  }
  return result
}

export interface StartupCredentials {
  serverPassword?: string
  brokerSecret?: string
  llmApiKey?: string
  adminToken?: string
  loadedFromCredentialsDir: boolean
}

let cachedStartupCredentials: StartupCredentials = {
  loadedFromCredentialsDir: false,
}

export function getCachedStartupCredentials(): Readonly<StartupCredentials> {
  return cachedStartupCredentials
}

export function loadAndScrubStartupCredentials(options?: {
  credentialsDir?: string
  env?: Record<string, string | undefined>
}): StartupCredentials {
  const env = options?.env ?? process.env
  const dir = options?.credentialsDir ?? env.CREDENTIALS_DIRECTORY

  let serverPassword: string | undefined
  let brokerSecret: string | undefined
  let llmApiKey: string | undefined
  let adminToken: string | undefined
  let loadedFromCredentialsDir = false

  if (dir) {
    const tryRead = (names: readonly string[]): string | undefined => {
      for (const name of names) {
        try {
          const filePath = path.join(dir, name)
          if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, "utf-8").trim()
            if (content.length > 0) {
              loadedFromCredentialsDir = true
              return content
            }
          }
        } catch {
          // Ignore read error
        }
      }
      return undefined
    }

    serverPassword = tryRead([
      "opencode_server_password",
      "OPENCODE_SERVER_PASSWORD",
      "opencode_password",
      "OPENCODE_PASSWORD",
    ])
    brokerSecret = tryRead([
      "aquanox_broker_secret",
      "AQUANOX_BROKER_SECRET",
    ])
    llmApiKey = tryRead([
      "aquanox_llm_api_key",
      "AQUANOX_LLM_API_KEY",
    ])
    adminToken = tryRead([
      "aquanox_admin_token",
      "AQUANOX_ADMIN_TOKEN",
    ])
  }

  // Fall back to env
  serverPassword ??= env.OPENCODE_SERVER_PASSWORD ?? env.OPENCODE_PASSWORD
  brokerSecret ??= env.AQUANOX_BROKER_SECRET
  llmApiKey ??= env.AQUANOX_LLM_API_KEY
  adminToken ??= env.AQUANOX_ADMIN_TOKEN

  // Scrub env
  for (const key of Object.keys(env)) {
    if (isSensitiveEnvKey(key) || key === "OPENCODE_PASSWORD") {
      delete env[key]
    }
  }

  cachedStartupCredentials = {
    serverPassword,
    brokerSecret,
    llmApiKey,
    adminToken,
    loadedFromCredentialsDir,
  }

  return cachedStartupCredentials
}
