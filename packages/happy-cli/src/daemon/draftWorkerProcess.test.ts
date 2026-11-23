import { fork, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, unlink, rmdir, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { DraftWorkerHost, draftWorkerEnvironment } from './draftWorkerHost'
import { NativeDraftWorkerHost } from './nativeDraftWorkerHost'
import { startResidentModuleHost } from './residentModuleHost'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'

const workerFile = fileURLToPath(new URL('../../bin/happy-draft-worker.mjs', import.meta.url))

it('prepares only a connected local Codex profile and retires the scope when the login changes', async () => {
  const { resolveConnectedCodexDraft } = await import('./connectedProviderDraft')
  const shim = await import('@/utils/happyCommandShim')
  const install = vi.spyOn(shim, 'installHappyCommandShim').mockReturnValue(null)
  const root = resolve(dirname(workerFile), '..')
  const fixture = await mkdtemp(resolve(root, '.draft-test-'))
  const directory = resolve(fixture, 'project'), home = resolve(fixture, 'codex-home')
  const login = resolve(home, 'auth.json')
  await mkdir(directory)
  await mkdir(home)
  vi.stubEnv('CODEX_HOME', home)
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_CLI_AUTH_PATH']) vi.stubEnv(key, undefined)
  const input = { directory, allowedRoot: directory, approvedRoots: () => [], ready: () => true }
  const setLogin = (token: string) => writeFile(login, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, refresh_token: 'fake-refresh' } }))
  try {
    expect(resolveConnectedCodexDraft(input)).toBeUndefined()
    await setLogin('first-fake-token')
    expect(resolveConnectedCodexDraft({ ...input, directory: fixture })).toBeUndefined()
    const scope = resolveConnectedCodexDraft(input)
    expect(scope?.isCurrent()).toBe(true)
    await setLogin('different-fake-token')
    expect(scope?.isCurrent()).toBe(false)
    expect(install).toHaveBeenCalledTimes(1)
  } finally {
    install.mockRestore()
    vi.unstubAllEnvs()
    await unlink(login).catch(() => {})
    await rmdir(home)
    await rmdir(directory)
    await rmdir(fixture)
  }
})

it('prepares only a connected local Claude profile and keeps the SDK default when there is no native override', async () => {
  const { resolveConnectedClaudeDraft } = await import('./connectedProviderDraft')
  const spawnEnvironment = await import('./spawnAgentCommand')
  const windowsClaude = await import('./windowsClaudeEnvironment')
  const shim = await import('@/utils/happyCommandShim')
  const install = vi.spyOn(shim, 'installHappyCommandShim').mockReturnValue('fixture-shim')
  const fixture = await mkdtemp(resolve(dirname(workerFile), '..', '.draft-test-'))
  const directory = resolve(fixture, 'project'), home = resolve(fixture, 'claude-home')
  const login = resolve(home, '.credentials.json'), executable = resolve(fixture, 'claude.exe')
  const resolveNative = vi.spyOn(windowsClaude, 'resolveWindowsClaudeWithinBudget').mockResolvedValue(executable)
  const inherited = vi.spyOn(spawnEnvironment, 'resolveInheritedSpawnEnvironment').mockResolvedValue({
    CLAUDE_CONFIG_DIR: home, HAPPY_CLAUDE_PATH: executable, HAPPY_AI_AUTH_SOURCE: 'personal-subscription',
  })
  await mkdir(directory)
  await mkdir(home)
  await writeFile(executable, 'test execution file version one')
  const input = { directory, allowedRoot: directory, approvedRoots: () => [], ready: () => true }
  const setLogin = (token: string, expiresAt = Date.now() + 600_000) => writeFile(login, JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } }))
  try {
    expect(await resolveConnectedClaudeDraft(input)).toBeUndefined()
    await setLogin('expired-fake-token', Date.now())
    expect(await resolveConnectedClaudeDraft(input)).toBeUndefined()
    await setLogin('first-fake-token')
    expect(await resolveConnectedClaudeDraft({ ...input, directory: fixture })).toBeUndefined()
    resolveNative.mockResolvedValueOnce(undefined)
    expect(await resolveConnectedClaudeDraft(input)).toBeUndefined()
    const scope = await resolveConnectedClaudeDraft(input)
    expect(scope?.isCurrent()).toBe(true)
    expect(Object.values(scope!.env)).not.toContain('first-fake-token')
    await setLogin('different-fake-token')
    expect(scope?.isCurrent()).toBe(false)
    inherited.mockResolvedValueOnce({ CLAUDE_CONFIG_DIR: home, HAPPY_AI_AUTH_SOURCE: 'personal-subscription' })
    const bundled = await resolveConnectedClaudeDraft(input)
    expect(bundled?.isCurrent()).toBe(true)
    expect(bundled?.env.HAPPY_CLAUDE_PATH).toBeUndefined()
  } finally {
    install.mockRestore()
    inherited.mockRestore()
    resolveNative.mockRestore()
    await unlink(login).catch(() => {})
    await unlink(executable)
    await rmdir(home)
    await rmdir(directory)
    await rmdir(fixture)
  }
})

it('activates the CLI entrypoint over its native draft channel only after the authorized resume', async () => {
  const root = resolve(dirname(workerFile), '..')
  const fixture = await mkdtemp(resolve(root, '.draft-test-'))
  const bin = resolve(fixture, 'bin'), dist = resolve(fixture, 'dist')
  await Promise.all([mkdir(bin), mkdir(dist)])
  const schemaDir = resolve(dist, 'claude'), schema = resolve(schemaDir, 'types.mjs')
  await mkdir(schemaDir)
  await writeFile(schema, 'export const loadedWith = process.env.DRAFT_TEST_FINAL ?? null')
  const hookDir = resolve(schemaDir, 'utils'), hookEntry = resolve(hookDir, 'parkedHookServer.mjs')
  await mkdir(hookDir)
  const { default: compiler } = await import('typescript')
  const hookSource = await readFile(new URL('../claude/utils/parkedHookServer.ts', import.meta.url), 'utf8')
  await writeFile(hookEntry, compiler.transpileModule(hookSource, { compilerOptions: { module: compiler.ModuleKind.ESNext, target: compiler.ScriptTarget.ES2022 } }).outputText)
  const worker = resolve(bin, 'happy-draft-worker.mjs'), entry = resolve(dist, 'index.mjs')
  const residentDir = resolve(dist, 'win32-resident')
  const residentEntry = resolve(residentDir, 'index.mjs')
  const residentMarker = resolve(residentDir, 'origin.mjs')
  const residentWrapper = resolve(bin, 'happy-resident-session.mjs')
  await mkdir(residentDir)
  await copyFile(workerFile, worker)
  await copyFile(resolve(dirname(workerFile), 'happy-resident-session.mjs'), residentWrapper)
  await writeFile(entry, "import { loadedWith } from './claude/types.mjs'; console.log(JSON.stringify([process.argv.slice(2), process.env.DRAFT_TEST_FINAL, process.env.HAPPY_DRAFT_CHANNEL ?? null, loadedWith]))")
  await writeFile(residentEntry, `import { origin } from './origin.mjs';
    import { takeParkedClaudeHookServer } from ${JSON.stringify(pathToFileURL(hookEntry).href)};
    export const commandLifetime = (async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      const hook = takeParkedClaudeHookServer();
      const closedWhileParked = hook && (await fetch('http://127.0.0.1:' + hook.port)).status === 503;
      hook?.stop();
      console.log(JSON.stringify([process.argv.slice(2), process.env.DRAFT_TEST_FINAL, process.env.HAPPY_DRAFT_CHANNEL ?? null,
        process.env.HAPPY_RESIDENT_MODULE_HOST ?? null, origin, closedWhileParked]));
    })();`)
  await writeFile(residentMarker, "export const origin = 'resident'")
  const modules = startResidentModuleHost(fixture)
  let output = ''
  const host = new NativeDraftWorkerHost(root, async ({ args, env }) => {
    const child = spawn(process.execPath, [worker, args[0]], { cwd: root, env, windowsHide: true })
    child.stdout.on('data', data => { output += data.toString() })
    return { pid: child.pid!, childProcess: child, launchId: 'fixture', resume: () => {},
      terminate: async () => { child.kill() }, exit: once(child, 'exit').then(([code]) => ({ jobEmpty: true, rootExit: code ?? 1 })) }
  })
  const id = randomUUID()
  try {
    expect(await modules.ready).toBe(true)
    await writeFile(residentMarker, "export const origin = 'changed on disk'")
    await host.prepare(id, 'claude')
    const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      NODE_USE_SYSTEM_CA: process.env.NODE_USE_SYSTEM_CA, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
      NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY, UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE }
    // The authenticated worker caps the serialized activation frame at 4 MiB.
    // The ordinary launch path must still own the unsent turn if it cannot fit.
    const oversized = await host.claim(id, ['claude', '한'.repeat(1_400_000)], root, env)
    if (oversized) { await oversized.terminate?.(); await oversized.exit }
    expect(oversized).toBeNull()
    expect(output).toBe('')
    // Windows may still be scanning the executable while the user is typing.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await host.prepare(id, 'claude')
      vi.advanceTimersByTime(16_000)
    } finally { vi.useRealTimers() }
    const launch = await host.claim(id, ['claude', '--version'], root, {
      ...env, DRAFT_TEST_FINAL: 'sent', HAPPY_RESIDENT_MODULE_HOST: modules.descriptor(),
    })
    expect(launch).toBeTruthy()
    expect(output).toBe('')
    await launch!.resume()
    await expect(launch!.exit).resolves.toMatchObject({ rootExit: 0, jobEmpty: true })
    expect(JSON.parse(output)).toEqual([['claude', '--version'], 'sent', null, null, 'resident', true])
  } finally {
    await host.close()
    await modules.close()
    await Promise.all([entry, worker, schema, hookEntry, residentEntry, residentMarker, residentWrapper].map(file => unlink(file)))
    await rmdir(hookDir)
    await Promise.all([rmdir(schemaDir), rmdir(residentDir)])
    await Promise.all([rmdir(bin), rmdir(dist)])
    await rmdir(fixture)
  }
}, 45_000)

it.each([
  ['codex', 'native', 'same connection'], ['codex', 'native', 'connection changed'], ['codex', 'native', 'immediate send'],
  ['codex', 'registered', 'same connection'], ['codex', 'registered', 'connection changed'], ['codex', 'registered', 'immediate send'],
  ['claude', 'native', 'same connection'], ['claude', 'registered', 'connection changed'],
] as const)('hands off only a ready %s preparation over %s IPC (%s)', async (provider, owner, state) => {
  const root = resolve(dirname(workerFile), '..')
  const fixture = await mkdtemp(resolve(root, '.draft-test-'))
  const bin = resolve(fixture, 'bin'), dist = resolve(fixture, 'dist')
  const commands = resolve(dist, 'commands')
  const worker = resolve(bin, 'happy-draft-worker.mjs')
  const residentWrapper = resolve(bin, 'happy-resident-session.mjs')
  const entry = resolve(dist, 'index.mjs'), residentCommand = resolve(commands, 'residentCodexEntry.mjs')
  const journal = resolve(fixture, 'events.txt')
  const log = `import { appendFile } from 'node:fs/promises';
    const log = event => appendFile(${JSON.stringify(journal)}, event + '\\n');`
  await Promise.all([mkdir(bin), mkdir(commands, { recursive: true })])
  await copyFile(workerFile, worker)
  await copyFile(resolve(dirname(workerFile), 'happy-resident-session.mjs'), residentWrapper)
  await writeFile(journal, '')
  await writeFile(entry, log + 'export const commandLifetime = log((globalThis.preparedClaude ? "adopted " : "ordinary ") + process.env.SEND_FIXTURE)')
  await writeFile(residentCommand, log + `
    export const codexAppServerArgs = ['app-server'];
    export async function prepareCodexAppServer(launch, { signal }) {
      if (process.env.PROVIDER_FIXTURE || launch.env.PROVIDER_FIXTURE !== 'window-owned') throw new Error('Invalid preparation environment')
      if (launch.env.HOLD_PREPARATION === '1') {
        await log('preparing');
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        await log('cancelled');
        throw new Error('Preparation cancelled');
      }
      await log('prepared');
      return { dispose: () => log('disposed') };
    }
    export async function activatePreparedCodex(prepared) {
      await log('adopted ' + process.env.SEND_FIXTURE);
      await prepared.dispose();
    }
  `)
  const claude = resolve(dist, 'claude'), sdk = resolve(claude, 'sdk'), utils = resolve(claude, 'utils')
  const claudeDraft = resolve(sdk, 'preparedClaudeDraft.mjs'), claudeHook = resolve(utils, 'parkedHookServer.mjs'), claudeTypes = resolve(claude, 'types.mjs')
  if (provider === 'claude') {
    await Promise.all([mkdir(sdk, { recursive: true }), mkdir(utils, { recursive: true })])
    await writeFile(claudeTypes, 'export {}')
    await writeFile(claudeHook, 'export const reserveClaudeHookServer = async () => ({ port: 4242, stop() {} }); export function offerParkedClaudeHookServer() {}')
    await writeFile(claudeDraft, log + `
      export async function prepareClaudeDraft({ env, port }) {
        if (process.env.PROVIDER_FIXTURE || env.PROVIDER_FIXTURE !== 'window-owned' || port !== 4242) throw new Error('Invalid Claude preparation')
        await log('prepared');
        return { dispose: () => log('disposed') };
      }
      export function offerClaudeDraft(prepared) { globalThis.preparedClaude = prepared; }
    `)
  }
  const events = async () => (await readFile(journal, 'utf8')).trim().split('\n')
  let current = true
  let child: ReturnType<typeof spawn> | undefined
  const host = owner === 'registered' ? new DraftWorkerHost(fixture) : new NativeDraftWorkerHost(root, async ({ args, env }) => {
    child = spawn(process.execPath, [worker, args[0]], { cwd: root, env, windowsHide: true })
    return { resume: () => {}, terminate: async () => { child?.kill() },
      exit: once(child, 'exit').then(([code]) => ({ rootExit: code, jobEmpty: true })) }
  })
  try {
    const id = randomUUID()
    const immediate = state === 'immediate send'
    expect(await host.prepareProvider(id, provider, {
      cwd: fixture, env: { PROVIDER_FIXTURE: 'window-owned', ...(immediate ? { HOLD_PREPARATION: '1' } : {}) },
      isCurrent: () => current,
    })).toBe(true)
    const beforeSend = immediate ? 'preparing' : 'prepared'
    await vi.waitFor(async () => expect(await events()).toEqual([beforeSend]), { timeout: 10_000 })
    const env = { ...draftWorkerEnvironment(), SEND_FIXTURE: 'now' }
    if (host instanceof NativeDraftWorkerHost) {
      const launch = await host.claim(id, [provider], fixture, env)
      expect(launch).toBeTruthy()
      expect(await events()).toEqual([beforeSend])
      current = state !== 'connection changed'
      await launch!.resume()
      await expect(launch!.exit).resolves.toEqual({ rootExit: 0, jobEmpty: true })
    } else {
      const launch = await host.claim(id, provider, env)
      expect(launch).toBeTruthy()
      child = launch!.child
      const exited = once(child, 'exit')
      expect(await events()).toEqual([beforeSend])
      current = state !== 'connection changed'
      launch!.activate({ args: [provider], cwd: fixture, env, keepIpc: false })
      await expect(exited).resolves.toEqual([0, null])
    }
    const expected = immediate ? ['preparing', 'cancelled', 'ordinary now']
      : current ? ['prepared', 'adopted now', 'disposed'] : ['prepared', 'disposed', 'ordinary now']
    expect(await events()).toEqual(expected)
  } finally {
    await host.close()
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit')
      child.kill()
      await exit
    }
    await Promise.all([worker, residentWrapper, entry, residentCommand, journal].map(file => unlink(file)))
    if (provider === 'claude') {
      await Promise.all([claudeDraft, claudeHook, claudeTypes].map(file => unlink(file)))
      await Promise.all([rmdir(sdk), rmdir(utils)])
      await rmdir(claude)
    }
    await Promise.all([rmdir(bin), rmdir(commands)])
    await rmdir(dist)
    await rmdir(fixture)
  }
}, 30_000)

it('uses the draft only once and refuses a launch requiring different Node startup flags', async () => {
  const host = new DraftWorkerHost(resolve(dirname(workerFile), '..'))
  const id = randomUUID()
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    NODE_USE_SYSTEM_CA: process.env.NODE_USE_SYSTEM_CA, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
    NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY, UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE }
  try {
    expect(await host.prepare(id, 'codex')).toBe(true)
    expect(await host.claim(id, 'claude', {})).toBeNull()
    expect(await host.claim(id, 'codex', { NODE_OPTIONS: '--trace-warnings' })).toBeNull()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      expect(await host.prepare(id, 'codex')).toBe(true)
      vi.advanceTimersByTime(16_000)
    } finally { vi.useRealTimers() }
    const worker = await host.claim(id, 'codex', env)
    expect(worker?.child.pid).toBeGreaterThan(0)
    try {
      expect(await host.claim(id, 'codex', env)).toBeNull()
    } finally { worker?.stop(); await worker?.exited }
  } finally { await host.close() }
}, 30_000)

it.each(['release', 'wrong provider'] as const)('ends the real idle worker on %s without launching a session', async action => {
  const child = fork(workerFile, ['claude'], {
    execArgv: [], env: { SystemRoot: process.env.SystemRoot }, silent: true,
  })
  const exited = once(child, 'exit')
  try {
    const ready = await Promise.race([
      once(child, 'message'),
      exited.then(([code]) => { throw Error('Exited before ready: ' + code) }),
    ])
    expect(ready[0]).toEqual({ version: 1, type: 'draft-ready', provider: 'claude' })
    if (action === 'release') child.disconnect()
    else child.send({ version: 1, type: 'activate', args: ['codex'], cwd: process.cwd(), env: {} })
    expect((await exited)[0]).toBe(action === 'release' ? 0 : 1)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
}, 30_000)
