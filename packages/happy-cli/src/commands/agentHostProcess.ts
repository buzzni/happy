import type { SessionOwnerContact } from '@/daemon/sessionOwnerContact'
import { OwnerContactRequestSchema } from '@slopus/happy-wire'
/** Executes the pinned CLI with private parent IPC; provider requests cannot supply authority. */
import { fork } from 'node:child_process'
import type { AgentBrokerResult } from './agentBroker'
import type { AgentIdentityAuthority } from '@/daemon/agentIdentityDescriptor'

const MAX_BYTES = 1024 * 1024
const failed = (): AgentBrokerResult => ({ exitCode: 3, stdout: JSON.stringify({ ok: false, error: 'not_agent_env', reason: 'broker_host_failed',
  detail: 'The bundled agent host did not return a result. Check runtime compatibility; do not automatically repeat a spawn.' }) + '\n' })

export function runAgentHostProcess(input: {
  entrypoint: string; argv: string[]; directory: string; env: NodeJS.ProcessEnv; signal: AbortSignal
  sourceSessionId: string; identityAuthority: AgentIdentityAuthority; ownerContact?: SessionOwnerContact
}): Promise<AgentBrokerResult> {
  return new Promise(resolve => {
    const child = fork(input.entrypoint, ['__agent-broker-v1', ...input.argv], {
      cwd: input.directory, env: input.env, signal: input.signal, timeout: 640_000,
      execPath: process.execPath, execArgv: ['--no-warnings', '--no-deprecation'], silent: true, killSignal: 'SIGKILL',
    })
    const chunks: Buffer[] = []
    let bytes = 0, invalid = false, pending = 0
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_BYTES) { invalid = true; child.kill('SIGKILL') }
      else chunks.push(chunk)
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_BYTES) { invalid = true; child.kill('SIGKILL') }
    })
    child.on('error', () => { invalid = true; resolve(failed()) })
    child.on('message', async (message: unknown) => {
      const value = message as Record<string, unknown> | null
      if (value?.type === 'owner-contact-v1') {
        if (Object.keys(value).length !== 3 || typeof value.requestId !== 'string' || !value.requestId
          || value.requestId.length > 64 || pending >= 16) return
        pending++
        let response: { reply?: unknown; error?: string } = { error: 'owner-contact-unavailable' }
        try {
          const request = OwnerContactRequestSchema.parse(value.request)
          if (input.ownerContact) response = { reply: await input.ownerContact.call(request) }
        } catch { /* Never forward adapter exceptions or credentials to the CLI. */ }
        finally { pending-- }
        if (child.connected) child.send({ type: 'owner-contact-v1-result', requestId: value.requestId, ...response }, () => {})
        return
      }
      if (value?.type === 'agent-ownership-v1' && Object.keys(value).length === 3 && Array.isArray(value.targetSessionIds)) {
        // One batch per listing (Desktop personal-ownership-simplification-plan S-D5 a). The host itself is never vouched for.
        const ids = value.targetSessionIds
        if (typeof value.requestId !== 'string' || value.requestId.length > 64 || ids.length < 1 || ids.length > 100
          || !ids.every(id => typeof id === 'string' && id && id.length <= 256) || pending >= 16) return
        pending++
        const targets = [...new Set(ids as string[])].filter(id => id !== input.sourceSessionId)
        const ownerships: Record<string, Awaited<ReturnType<AgentIdentityAuthority['inspect']>>> = {}
        for (const id of ids as string[]) ownerships[id] = { relation: 'unknown', proof: null, reason: 'identity-unavailable' }
        try {
          const answers = !targets.length ? {} : input.identityAuthority.inspectMany ? await input.identityAuthority.inspectMany(targets)
            : Object.fromEntries(await Promise.all(targets.map(async id => [id, await input.identityAuthority.inspect(id)])))
          for (const id of targets) if (Object.hasOwn(answers, id)) ownerships[id] = answers[id]
        } catch { /* No fallback to request env, company credentials or metadata. */ }
        finally { pending-- }
        if (child.connected) child.send({ type: 'agent-ownership-v1-result', requestId: value.requestId, ownerships }, () => {})
        return
      }
      if (!value || value.type !== 'agent-ownership-v1' || Object.keys(value).length !== 3
        || typeof value.requestId !== 'string' || value.requestId.length > 64
        || typeof value.targetSessionId !== 'string' || !value.targetSessionId || value.targetSessionId.length > 256 || pending >= 16) return
      pending++
      let ownership = { relation: 'unknown', proof: null, reason: 'identity-unavailable' } as Awaited<ReturnType<AgentIdentityAuthority['inspect']>>
      try {
        if (value.targetSessionId !== input.sourceSessionId) ownership = await input.identityAuthority.inspect(value.targetSessionId)
      } catch { /* No fallback to request env, company credentials or metadata. */ }
      finally { pending-- }
      if (child.connected) child.send({ type: 'agent-ownership-v1-result', requestId: value.requestId, ownership }, () => {})
    })
    child.on('close', (code, signal) => {
      if (invalid || signal) return resolve(failed())
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString())
        if (![0, 3].includes(result.exitCode) || typeof result.stdout !== 'string' || code !== result.exitCode) throw new Error('Invalid host result')
        const payload = JSON.parse(result.stdout)
        if (payload.ok !== (result.exitCode === 0)) throw new Error('Invalid host result')
        resolve(result)
      } catch { resolve(failed()) }
    })
  })
}
