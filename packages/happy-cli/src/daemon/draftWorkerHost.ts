import { spawn, type StdioOptions } from 'node:child_process'
import { join } from 'node:path'
import { createProviderDraftRunnerSlots, isDraftRunnerProvider, waitForDraftReady, type DraftRunnerProvider } from './draftRunnerSlot'
type Activation = { args: string[]; cwd: string; env: NodeJS.ProcessEnv; keepIpc: boolean }
export type ProviderDraftPreparation = { cwd: string; env: NodeJS.ProcessEnv; isCurrent(): boolean }
export function currentProviderDraftPreparation(preparation?: ProviderDraftPreparation) {
  try { return preparation?.isCurrent() ? preparation : undefined }
  catch { return undefined }
}
const maxPreparationBytes = 4 * 1024 * 1024
export const validDraftId = (id: string) => /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(id)
// The default worker inherits only process-start settings.
const bootstrapKeys = /^(?:SYSTEMROOT|WINDIR|TEMP|TMP|NODE_USE_SYSTEM_CA|NODE_EXTRA_CA_CERTS|NODE_USE_ENV_PROXY|UV_THREADPOOL_SIZE)$/i
const startupSensitive = /^(?:NODE_|UV_|OPENSSL_|SSL_CERT_|V8_|ICU_|LD_|DYLD_|ELECTRON_|TZ$|SYSTEMROOT$|WINDIR$)/i
export function draftWorkerEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => bootstrapKeys.test(key)))
}

export function matchesDraftStartup(bootstrap: NodeJS.ProcessEnv, requested: NodeJS.ProcessEnv) {
  const starting = new Map(Object.entries(bootstrap).map(([k, v]) => [k.toUpperCase(), v]))
  const final = new Map(Object.entries(requested).map(([k, v]) => [k.toUpperCase(), v]))
  return [...new Set([...starting.keys(), ...final.keys()])].every(key =>
    !startupSensitive.test(key) || starting.get(key) === final.get(key))
}

type LogStdio = () => { stdio: StdioOptions; close(): void }
function launchWorker(root: string, provider: DraftRunnerProvider, logStdio?: LogStdio, preparation?: ProviderDraftPreparation) {
  const env = draftWorkerEnvironment()
  const capture = logStdio?.()
  const spawnChild = () => spawn(process.execPath, ['--no-warnings', '--no-deprecation', join(root, 'bin', 'happy-draft-worker.mjs'), provider], {
    cwd: root, env, detached: true, windowsHide: true,
    stdio: [...(Array.isArray(capture?.stdio) ? capture.stdio : ['ignore', 'ignore', 'ignore'] as const), 'ipc'],
  })
  const child = (() => { try { return spawnChild() } finally { capture?.close() } })()
  let activated = false
  let stopping = false
  const stop = () => {
    if (stopping || child.exitCode !== null || child.signalCode !== null) return
    stopping = true
    // Let the worker cancel and confirm provider exit before its own IPC closes.
    if (preparation && !activated) {
      if (child.connected) child.disconnect()
    } else child.kill()
  }
  const exited = new Promise<void>((done, reject) => {
    // A preparing worker exits successfully only after its own provider has stopped.
    child.once(preparation ? 'exit' : 'close', code => {
      if (preparation && !activated && code !== 0) reject(new Error('Draft provider exit unconfirmed'))
      else done()
    })
    child.once('error', error => { if (!child.pid) reject(error) })
  })
  const ready = new Promise<boolean>(done => {
    child.once('message', message => {
      const reply = message as { version?: number; type?: string; provider?: string } | null
      const valid = reply?.version === 1 && reply.type === 'draft-ready' && reply.provider === provider
      if (!valid) { done(false); stop(); return }
      const scope = currentProviderDraftPreparation(preparation)
      if (scope && child.connected) {
        const frame = { version: 1, type: `prepare-${provider}`, scope: { cwd: scope.cwd, env: scope.env } }
        if (Buffer.byteLength(JSON.stringify(frame)) <= maxPreparationBytes) {
          child.send(frame, error => { if (error) stop() })
        }
      }
      done(true)
    })
    child.once('error', () => done(false))
    void exited.then(() => done(false), () => done(false))
  })
  return { child, ready, exited, stop, env, activate(message: Activation) {
    if (!child.connected || activated || stopping) throw new Error('Draft worker disconnected')
    child.send({ version: 1, type: 'activate', ...message, usePreparation: Boolean(currentProviderDraftPreparation(preparation)) },
      error => {
        if (error) { activated = false; stop() }
      })
    activated = true
  } }
}

export class DraftWorkerHost {
  private readonly slots: ReturnType<typeof createProviderDraftRunnerSlots<ReturnType<typeof launchWorker>>>
  constructor(private readonly root: string, private readonly logStdio?: LogStdio) {
    this.slots = createProviderDraftRunnerSlots(provider => launchWorker(root, provider, logStdio), 60_000)
  }
  prepare(id: string, provider: DraftRunnerProvider) {
    // A waiting worker contains only the bootstrap environment and provider modules.
    return validDraftId(id) ? this.slots[provider].prepare(id, provider) : Promise.resolve(false)
  }
  prepareProvider(id: string, provider: DraftRunnerProvider, preparation: ProviderDraftPreparation) {
    if (!validDraftId(id) || !currentProviderDraftPreparation(preparation)) return Promise.resolve(false)
    return this.slots[provider].prepare(id, undefined, () => launchWorker(this.root, provider, this.logStdio, preparation))
  }
  renew(id: string, provider: DraftRunnerProvider) { return this.slots[provider].renew(id) }
  release(id: string, provider: DraftRunnerProvider) { this.slots[provider].release(id) }
  close() { return this.slots.close() }

  async claim(id: string, provider: string, env: NodeJS.ProcessEnv) {
    if (!isDraftRunnerProvider(provider)) return null
    const worker = await this.slots[provider].claim(id)
    if (!worker) return null
    // Process-start settings cannot take effect by changing process.env after fork.
    // Normalize case because Windows can return SystemRoot under either spelling.
    if (!matchesDraftStartup(worker.env, env) || !await waitForDraftReady(worker.ready) || !worker.child.connected) {
      worker.stop()
      await worker.exited
      return null
    }
    return worker
  }
}
