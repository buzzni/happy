import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

// Only the daemon that forked this process owns the inherited IPC channel.
// The command runtime stays unloaded until activation. A trusted owner may prepare a provider first.
const provider = process.argv[2]
const nativeBootstrap = process.env.HAPPY_DRAFT_CHANNEL
delete process.env.HAPPY_DRAFT_CHANNEL
const drainBootstrap = process.env.HAPPY_STANDALONE_LAUNCH_V1
delete process.env.HAPPY_STANDALONE_LAUNCH_V1
if (Boolean(process.send) === Boolean(nativeBootstrap) || !['claude', 'codex'].includes(provider)) process.exit(1)
// These modules only define wire types and validation rules. The normal runner imports
// the same modules after activation, so Node reuses the definitions prepared here.
const preload = Promise.all([
  import('zod'), import('tweetnacl'), import('@slopus/happy-wire'),
  import('@modelcontextprotocol/sdk/types.js'),
  ...(provider === 'claude' ? [import('../dist/claude/types.mjs')] : []),
])
const entrypoint = new URL('../dist/index.mjs', import.meta.url)
let parkedClaudeHook
let claudeHookTransferred = false
const claudeHookReady = provider === 'claude'
  ? import('../dist/claude/utils/parkedHookServer.mjs').then(async module => {
    const socket = await module.reserveClaudeHookServer()
    if (claudeHookTransferred) socket.stop()
    else parkedClaudeHook = { socket, offer: module.offerParkedClaudeHookServer }
  }).catch(() => {}) : undefined
// Compare these two instants to the UI send time. Worker uptime includes time spent in the draft.
function markTiming(stage) {
  console.error(`[draft-timing] ${stage} provider=${provider} pid=${process.pid} at=${Date.now()}`)
}

function validEnvironment(env) {
  return env && typeof env === 'object' && !Array.isArray(env)
    && Object.entries(env).every(([name, value]) => name && !/[=\0]/.test(name) && typeof value === 'string' && !value.includes('\0'))
}

async function prepareCodex(message, signal, onStart) {
  if (provider !== 'codex' || !message || typeof message.cwd !== 'string' || !isAbsolute(message.cwd) || !validEnvironment(message.env)) return
  const { codexAppServerArgs, prepareCodexAppServer } = await import('../dist/commands/residentCodexEntry.mjs')
  if (signal.aborted) return
  onStart()
  // The resident entry projects the owner's session environment before launching the provider.
  return prepareCodexAppServer({ command: 'codex', args: codexAppServerArgs, cwd: message.cwd, env: message.env },
    { signal, isCurrent: () => !signal.aborted })
}

async function prepareClaude(message, controller, onStart) {
  if (!message || typeof message.cwd !== 'string' || !isAbsolute(message.cwd) || !validEnvironment(message.env)) return
  await claudeHookReady
  if (controller.signal.aborted || !parkedClaudeHook) return
  const { prepareClaudeDraft, offerClaudeDraft } = await import('../dist/claude/sdk/preparedClaudeDraft.mjs')
  if (controller.signal.aborted) return
  onStart()
  const lease = await prepareClaudeDraft({ cwd: message.cwd, env: message.env, installRoot: fileURLToPath(new URL('../', import.meta.url)),
    port: parkedClaudeHook.socket.port, abortController: controller })
  return lease && { ...lease, offer: () => offerClaudeDraft(lease) }
}

async function activate(message, prepared) {
  try {
    if (message?.version !== 1 || message.type !== 'activate' || !Array.isArray(message.args)
      || message.args[0] !== provider || !message.args.every(arg => typeof arg === 'string')
      || typeof message.cwd !== 'string' || !isAbsolute(message.cwd)
      || !validEnvironment(message.env)) throw new Error('Invalid draft activation')
    await preload
    markTiming('activate')
    process.chdir(message.cwd)
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, message.env)
    if (drainBootstrap) process.env.HAPPY_STANDALONE_LAUNCH_V1 = drainBootstrap
    process.argv = [process.execPath, fileURLToPath(entrypoint), ...message.args]
    claudeHookTransferred = true
    if (provider === 'claude' && parkedClaudeHook) parkedClaudeHook.offer(parkedClaudeHook.socket)
    prepared?.offer?.()
    // A workspace launch can continue to use this same IPC descriptor for its existing custody protocol.
    if (!message.keepIpc && process.connected) process.disconnect()
    // The daemon supplies the shared module host only in the authorized activation frame.
    if (process.env.HAPPY_RESIDENT_MODULE_HOST || prepared && provider === 'codex') {
      const { startResidentSession } = await import('./happy-resident-session.mjs')
      await startResidentSession(provider === 'codex' ? prepared : undefined)
    } else {
      const command = await import(entrypoint.href)
      await command.commandLifetime
    }
  } catch {
    await prepared?.dispose().catch(() => {})
    console.error('Happy draft activation failed')
    process.exit(1)
  } finally {
    if (provider === 'claude') await prepared?.dispose()
    parkedClaudeHook?.socket.stop()
  }
}

function createPreparation() {
  const controller = new AbortController()
  let pending
  let prepared
  let started = false
  let disposalUnconfirmed = false
  const dispose = async () => {
    controller.abort()
    if (started) await pending
    if (disposalUnconfirmed) throw new Error('Draft provider exit unconfirmed')
    await prepared?.dispose()
    prepared = undefined
  }
  return {
    start(message) {
      if (pending) throw new Error('Duplicate draft preparation')
      const markStarted = () => { started = true }
      const launch = provider === 'claude' ? prepareClaude(message, controller, markStarted) : prepareCodex(message, controller.signal, markStarted)
      pending = launch.then(lease => {
        prepared = lease
        if (lease) markTiming('provider-ready')
      }, error => {
        disposalUnconfirmed = error?.code === 'CODEX_PREPARED_EXIT_UNCONFIRMED' || error?.code === 'CLAUDE_PREPARED_EXIT_UNCONFIRMED'
      })
    },
    async take(allowed) {
      // An immediate send never has to wait for provider initialization to finish.
      if (!allowed || !prepared) await dispose()
      const lease = prepared
      prepared = undefined
      return lease
    },
    dispose,
  }
}

async function activateFromNative(socket, readPreparation) {
  const providerPreparation = createPreparation()
  const maxFrameBytes = 4 * 1024 * 1024
  let chunks = []
  let bytes = 0
  const append = chunk => {
    bytes += chunk.length
    if (bytes > maxFrameBytes) throw new Error('Oversized draft frame')
    chunks.push(chunk)
  }
  try {
    for await (let chunk of socket) {
      if (readPreparation) {
        const separator = chunk.indexOf(10)
        if (separator < 0) {
          append(chunk)
          continue
        }
        append(chunk.subarray(0, separator))
        providerPreparation.start(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        readPreparation = false
        chunks = []
        bytes = 0
        chunk = chunk.subarray(separator + 1)
      }
      append(chunk)
    }
    if (!bytes) return
    if (readPreparation) throw new Error('Incomplete draft preparation frame')
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    await activate(message, await providerPreparation.take(message?.usePreparation === true))
  } finally {
    await providerPreparation.dispose()
  }
}

function bindParentChannel() {
  const preparation = createPreparation()
  const stop = async (exitCode = 0) => {
    process.removeListener('message', receive)
    process.removeListener('disconnect', disconnect)
    try { await preparation.dispose() } catch { exitCode = 1 }
    process.exit(exitCode)
  }
  const disconnect = () => { void stop() }
  const receive = async message => {
    try {
      if (message?.version === 1 && message.type === `prepare-${provider}`) {
        preparation.start(message.scope)
        return
      }
      process.removeListener('message', receive)
      process.removeListener('disconnect', disconnect)
      await activate(message, await preparation.take(message?.usePreparation === true))
    } catch {
      await stop(1)
    }
  }
  process.once('disconnect', disconnect)
  process.on('message', receive)
  return () => { void stop(1) }
}

const channelFailed = process.send ? bindParentChannel() : undefined
try {
  await Promise.all([preload, claudeHookReady])
  markTiming('ready')
  if (nativeBootstrap) {
    const { connect } = await import('node:tls')
    const { port, key, protocol } = JSON.parse(nativeBootstrap)
    const socket = connect({ host: '127.0.0.1', port,
      minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ciphers: 'PSK-AES128-GCM-SHA256',
      // Mutual authentication uses the private per-launch key, without certificates.
      rejectUnauthorized: false, pskCallback: () => ({ identity: 'draft', psk: Buffer.from(key, 'hex') }) })
    await activateFromNative(socket, protocol === 2)
  }
  if (process.connected) process.send({ version: 1, type: 'draft-ready', provider }, error => {
    if (error) channelFailed?.()
  })
} catch {
  process.exit(1)
}
