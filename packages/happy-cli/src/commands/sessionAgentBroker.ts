import { configuration } from '@/configuration'
import { runAgentHostProcess } from './agentHostProcess'
import { createAgentIdentityAuthority, type AgentIdentityAuthority } from '@/daemon/agentIdentityDescriptor'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { startAgentBroker, type AgentBrokerResult } from './agentBroker'
import { DELEGATED_ATTENDANCE_ENV, type DelegatedAttendance } from '@/api/turnAttendance'

/** Capture before provider launch; no request-supplied env, executable or directory. */
export function createAgentHostExecutor(input: {
  sessionId: string; directory: string; env: NodeJS.ProcessEnv; entrypoint?: string
  /**
   * This session's current turn attendance, read per call and handed to the bundled CLI so a child
   * it spawns or prompts inherits it (codexcli-approval-session-binding R12). A CLI that does not
   * know the variable ignores it, and its children wait as before.
   */
  delegatedAttendance?: () => DelegatedAttendance | null
  identityAuthority?: AgentIdentityAuthority
}) {
  const directory = realpathSync(input.directory)
  const env: NodeJS.ProcessEnv = { ...input.env, APLUS_SESSION_ID: input.sessionId, SAYCODE_AGENT_ROOT: directory }
  for (const key of Object.keys(env)) if (['NODE_OPTIONS', 'NODE_PATH', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_UNIQUE_ID', 'BASH_ENV', 'ENV', 'LD_PRELOAD'].includes(key) || key.startsWith('DYLD_')) delete env[key]
  delete env.SAYCODE_AGENT_BROKER_URL
  delete env.SAYCODE_AGENT_BROKER_CAPABILITY
  // Only ever this session's own value, set per call below — never one inherited from a parent.
  delete env[DELEGATED_ATTENDANCE_ENV]
  const manifestPath = input.entrypoint ? null : createRequire(import.meta.url).resolve('@buzzni/saycode-cli/package.json')
  const manifest = manifestPath ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null
  if (!input.entrypoint && typeof manifest?.bin?.saycode !== 'string') throw new Error('Missing bundled agent CLI')
  const entrypoint = input.entrypoint ?? resolve(dirname(manifestPath!), manifest.bin.saycode)
  const identityAuthority = input.identityAuthority ?? createAgentIdentityAuthority()
  return (argv: string[], signal: AbortSignal): Promise<AgentBrokerResult> => {
    const attendance = input.delegatedAttendance?.() ?? null
    const callEnv = attendance ? { ...env, [DELEGATED_ATTENDANCE_ENV]: attendance } : env
    return runAgentHostProcess({ entrypoint, argv, directory, env: callEnv, signal,
      sourceSessionId: input.sessionId, identityAuthority })
  }
}

/** Rolling upgrades leave legacy clients unchanged until the matching CLI is bundled. */
export function compatibleAgentHostEntrypoint(manifestPath?: string): string | null {
  try {
    const path = manifestPath ?? createRequire(import.meta.url).resolve('@buzzni/saycode-cli/package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    return manifest.saycodeAgentBrokerProtocol === 1 && typeof manifest.bin?.saycode === 'string'
      ? resolve(dirname(path), manifest.bin.saycode) : null
  } catch { return null }
}

export async function startSessionAgentBroker(sessionId: string, env: NodeJS.ProcessEnv = process.env,
  admit: <T>(work: () => Promise<T>) => Promise<T> = work => work(),
  entrypoint: string | null = compatibleAgentHostEntrypoint(),
  delegatedAttendance?: () => DelegatedAttendance | null,
  identityAuthority?: AgentIdentityAuthority) {
  if (!entrypoint || env.SAYCODE_AGENT_ENV !== '1' || !env.SAYCODE_AGENT_ROOT || !sessionId) return null
  const trustedEnv: NodeJS.ProcessEnv = { ...env, HAPPY_HOME_DIR: configuration.happyHomeDir, HAPPY_SERVER_URL: configuration.serverUrl, SAYCODE_SERVER_URL: configuration.serverUrl }
  delete trustedEnv.SAYCODE_HAPPY_HOME
  const execute = createAgentHostExecutor({ sessionId, directory: process.cwd(), env: trustedEnv, entrypoint, delegatedAttendance, identityAuthority })
  const broker = await startAgentBroker({ execute: (argv, signal) => admit(() => execute(argv, signal)) })
  // A Happy host owns one provider session. Resume starts a new host and mints a fresh capability.
  const previous = { url: env.SAYCODE_AGENT_BROKER_URL, token: env.SAYCODE_AGENT_BROKER_CAPABILITY }
  Object.assign(env, broker.environment)
  return { close: async () => {
    if (env.SAYCODE_AGENT_BROKER_CAPABILITY === broker.environment.SAYCODE_AGENT_BROKER_CAPABILITY) {
      if (previous.url === undefined) delete env.SAYCODE_AGENT_BROKER_URL; else env.SAYCODE_AGENT_BROKER_URL = previous.url
      if (previous.token === undefined) delete env.SAYCODE_AGENT_BROKER_CAPABILITY; else env.SAYCODE_AGENT_BROKER_CAPABILITY = previous.token
    }
    await broker.close()
  } }
}
