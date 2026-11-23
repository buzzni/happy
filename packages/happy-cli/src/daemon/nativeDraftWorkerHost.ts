import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type TLSSocket } from 'node:tls'
import { createProviderDraftRunnerSlots, isDraftRunnerProvider, waitForDraftReady, type DraftRunnerProvider } from './draftRunnerSlot'
import { currentProviderDraftPreparation, draftWorkerEnvironment, matchesDraftStartup, validDraftId, type ProviderDraftPreparation } from './draftWorkerHost'

type NativeLaunch = {
  resume(): void | Promise<void>
  terminate?(): Promise<void>
  cancelBeforeResume?(): void
  exit: Promise<{ jobEmpty: boolean }>
  retired?: Promise<unknown>
}
type Prepare<T> = (input: { draftWorker: true; args: string[]; cwd: string; env: NodeJS.ProcessEnv }) => Promise<T>
type Activation = { version: 1; type: 'activate'; args: string[]; cwd: string; env: NodeJS.ProcessEnv; usePreparation: boolean }
const maxFrameBytes = 4 * 1024 * 1024

/** The native helper owns the Job. Only the daemon can activate its neutral root. */
function launchWorker<T extends NativeLaunch>(root: string, provider: DraftRunnerProvider, prepare: Prepare<T>, preparation?: ProviderDraftPreparation) {
  const env = draftWorkerEnvironment()
  const key = randomBytes(32)
  let socket: TLSSocket | undefined
  let launch: T | undefined
  let stopped = false
  let resumed = false
  let markReady!: (value: boolean) => void
  const ready = new Promise<boolean>(resolve => { markReady = resolve })
  const server = createServer({ minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
    ciphers: 'PSK-AES128-GCM-SHA256', handshakeTimeout: 3000,
    pskCallback: (_socket, identity) => identity === 'draft' ? key : null }, client => {
    if (stopped || socket) { client.destroy(); return }
    socket = client
    client.on('error', () => client.destroy())
    server.close()
    if (preparation) {
      const active = currentProviderDraftPreparation(preparation)
      const frame = JSON.stringify(active ? { cwd: active.cwd, env: active.env } : null)
      client.write((Buffer.byteLength(frame) <= maxFrameBytes ? frame : 'null') + '\n')
    }
    markReady(true)
  })
  const stop = () => {
    stopped = true
    markReady(false)
    socket?.destroy()
    if (server.listening) server.close()
    if (resumed) void launch?.terminate?.().catch(() => {})
    else launch?.cancelBeforeResume?.()
  }
  const prepared = (async () => {
    server.listen({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (stopped || !address || typeof address === 'string') return
    launch = await prepare({ draftWorker: true, args: [provider], cwd: root, env: { ...env,
      HAPPY_DRAFT_CHANNEL: JSON.stringify({ port: address.port, key: key.toString('hex'), ...(preparation ? { protocol: 2 } : {}) }) } })
    if (stopped) launch.cancelBeforeResume?.()
    else {
      await launch.resume()
      resumed = true
      if (stopped) stop()
    }
    return launch
  })()
  const exited = (async () => {
    try { await prepared } catch { stop() }
    if (launch && !(await launch.exit).jobEmpty) throw Error('Draft Job exit unconfirmed')
    await launch?.retired
  })().finally(() => {
    markReady(false)
    socket?.destroy()
    if (server.listening) server.close()
    key.fill(0)
  })
  return { ready, env, stop, exited, prepared, activate: (message: Activation) => {
    if (stopped || !socket || socket.destroyed || socket.writableEnded) throw Error('Draft worker disconnected')
    socket.end(JSON.stringify({ ...message, usePreparation: Boolean(currentProviderDraftPreparation(preparation)) }))
  } }
}

export class NativeDraftWorkerHost<T extends NativeLaunch> {
  private readonly slots: ReturnType<typeof createProviderDraftRunnerSlots<ReturnType<typeof launchWorker<T>>>>
  constructor(private readonly root: string, private readonly prepareNative: Prepare<T>) {
    this.slots = createProviderDraftRunnerSlots(provider => launchWorker(root, provider, prepareNative), 60_000)
  }
  prepare(id: string, provider: DraftRunnerProvider) {
    // A waiting worker contains only the bootstrap environment and provider modules.
    return validDraftId(id) ? this.slots[provider].prepare(id, provider) : Promise.resolve(false)
  }
  /** The local owner supplies a confirmed provider scope, never a renderer request body. */
  prepareProvider(id: string, provider: DraftRunnerProvider, preparation: ProviderDraftPreparation) {
    if (!validDraftId(id) || !currentProviderDraftPreparation(preparation)) return Promise.resolve(false)
    return this.slots[provider].prepare(id, undefined, () => launchWorker(this.root, provider, this.prepareNative, preparation))
  }
  renew(id: string, provider: DraftRunnerProvider) { return this.slots[provider].renew(id) }
  release(id: string, provider: DraftRunnerProvider) { this.slots[provider].release(id) }
  close() { return this.slots.close() }

  async claim(id: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    const provider = args[0]
    if (!isDraftRunnerProvider(provider)) return null
    const worker = await this.slots[provider].claim(id)
    if (!worker) return null
    if (matchesDraftStartup(worker.env, env) && await waitForDraftReady(worker.ready)) {
      const launch = await worker.prepared
      if (launch) {
        const message: Activation = { version: 1, type: 'activate', args, cwd, env, usePreparation: false }
        // Match the worker's receive limit before transferring ownership of the launch.
        if (Buffer.byteLength(JSON.stringify(message)) <= maxFrameBytes) {
          return { ...launch, cancelBeforeResume: worker.stop, resume: () => worker.activate(message) }
        }
      }
    }
    worker.stop()
    await worker.exited
    return null
  }
}
