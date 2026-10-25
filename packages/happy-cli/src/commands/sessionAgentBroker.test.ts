import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAgentHostExecutor, startSessionAgentBroker, compatibleAgentHostEntrypoint } from './sessionAgentBroker'
import { startAgentBroker } from './agentBroker'
import { filterCredentialsFromEnv } from '@/sandbox/config'

const run = promisify(execFile)
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-host-'))); dirs.push(root)
  return root
}
describe('trusted session agent execution', () => {
  it('fixes identity, cwd and environment before caller execution and preserves the session capability through filtering', async () => {
    const root = await fixture(), entrypoint = join(root, 'cli.mjs')
    await writeFile(entrypoint, `console.log(JSON.stringify({exitCode:0,stdout:JSON.stringify({ok:true,id:process.env.APLUS_SESSION_ID,root:process.env.SAYCODE_AGENT_ROOT,args:process.argv.slice(2),broker:process.env.SAYCODE_AGENT_BROKER_CAPABILITY})}))`)
    const env = { APLUS_SESSION_ID: 'stale', SAYCODE_AGENT_ROOT: '/stale', SAYCODE_AGENT_BROKER_CAPABILITY: 'old-contact', NODE_OPTIONS: '--require /must-not-execute' }
    const execute = createAgentHostExecutor({ sessionId: 'current', directory: root, env, entrypoint })
    env.APLUS_SESSION_ID = 'forged'
    expect(JSON.parse((await execute(['whoami'], new AbortController().signal)).stdout)).toEqual({
      ok: true, id: 'current', root, args: ['__agent-broker-v1', 'whoami'],
    })
    expect(filterCredentialsFromEnv({ SAYCODE_AGENT_BROKER_CAPABILITY: 'session-only', GH_TOKEN: 'account-secret' }))
      .toEqual({ SAYCODE_AGENT_BROKER_CAPABILITY: 'session-only' })
  })
  // Fable 리뷰(#939): the CLI refuses a mandatory session's unsandboxed delegation from these two
  // values, so the broker must hand the host its own copy rather than lose them on the way.
  it('keeps the session sandbox policy in the host env the bundled CLI decides from', async () => {
    const root = await fixture(), entrypoint = join(root, 'cli.mjs')
    await writeFile(entrypoint, `console.log(JSON.stringify({exitCode:0,stdout:JSON.stringify({ok:true,mode:process.env.HAPPY_SANDBOX_POLICY_MODE,config:process.env.HAPPY_PROJECT_SANDBOX_CONFIG})}))`)
    const config = JSON.stringify({ enabled: true })
    const env: NodeJS.ProcessEnv = { SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_ROOT: root, HAPPY_SANDBOX_POLICY_MODE: 'mandatory', HAPPY_PROJECT_SANDBOX_CONFIG: config }
    const broker = await startSessionAgentBroker('parent', env, undefined, entrypoint)
    try {
      const response = await fetch(env.SAYCODE_AGENT_BROKER_URL!, { method: 'POST', headers: { authorization: `Bearer ${env.SAYCODE_AGENT_BROKER_CAPABILITY}` },
        body: JSON.stringify({ version: 1, argv: ['spawn', '--agent', 'gemini', '--prompt', 'x'] }) })
      expect(JSON.parse((await response.json() as { stdout: string }).stdout)).toEqual({ ok: true, mode: 'mandatory', config })
    } finally { await broker!.close() }
  })
  it('hands the bundled CLI this session\'s current turn attendance on every call, never an inherited one (R12)', async () => {
    const root = await fixture(), entrypoint = join(root, 'cli.mjs')
    await writeFile(entrypoint, `console.log(JSON.stringify({exitCode:0,stdout:JSON.stringify({ok:true,attendance:process.env.SAYCODE_DELEGATED_ATTENDANCE ?? null})}))`)
    let attendance: 'unattended' | 'attended' | null = 'unattended'
    const execute = createAgentHostExecutor({
      sessionId: 'current', directory: root, env: { SAYCODE_DELEGATED_ATTENDANCE: 'unattended' }, entrypoint, delegatedAttendance: () => attendance,
    })
    const read = async () => JSON.parse((await execute(['spawn'], new AbortController().signal)).stdout).attendance
    expect(await read()).toBe('unattended')
    attendance = 'attended'
    expect(await read()).toBe('attended')
    // Unknown here: the inherited value is not passed on.
    attendance = null
    expect(await read()).toBeNull()
  })
  it('rotates the contact on resume, clears it on close and honors the runtime admission gate', async () => {
    const env: NodeJS.ProcessEnv = { SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_ROOT: process.cwd() }
    let admitted = 0
    const entrypoint = join(await fixture(), 'unused.mjs')
    const first = await startSessionAgentBroker('parent', env, async () => { admitted++; throw new Error('draining') }, entrypoint)
    const previous = { url: env.SAYCODE_AGENT_BROKER_URL!, capability: env.SAYCODE_AGENT_BROKER_CAPABILITY! }
    try {
      const response = await fetch(previous.url, { method: 'POST', headers: { authorization: `Bearer ${previous.capability}` },
        body: JSON.stringify({ version: 1, argv: ['whoami'] }) })
      expect(response.status).toBe(400)
      expect(admitted).toBe(1)
    } finally { await first!.close() }
    expect(env.SAYCODE_AGENT_BROKER_URL).toBeUndefined()
    const second = await startSessionAgentBroker('parent', env, undefined, entrypoint)
    try { expect(env.SAYCODE_AGENT_BROKER_CAPABILITY).not.toBe(previous.capability) }
    finally { await second!.close() }
  })
  it('keeps the old facade until the installed CLI advertises the host protocol', async () => {
    const root = await fixture(), manifest = join(root, 'package.json')
    await writeFile(manifest, JSON.stringify({ bin: { saycode: './index.mjs' } }))
    expect(compatibleAgentHostEntrypoint(manifest)).toBeNull()
    await writeFile(manifest, JSON.stringify({ bin: { saycode: './index.mjs' }, saycodeAgentBrokerProtocol: 1 }))
    expect(compatibleAgentHostEntrypoint(manifest)).toBe(join(root, 'index.mjs'))
  })
  it('refuses an incompatible bundle without running the legacy agent path', async () => {
    const root = await fixture(), entrypoint = join(root, 'old.mjs')
    await writeFile(entrypoint, `console.log('old CLI help');process.exit(2)`)
    const output = await createAgentHostExecutor({ sessionId: 'current', directory: root, env: {}, entrypoint })(['whoami'], new AbortController().signal)
    expect(JSON.parse(output.stdout)).toMatchObject({ ok: false, reason: 'broker_host_failed' })
    expect(output.exitCode).toBe(3)
  })

  it.skipIf(process.platform !== 'darwin' || !process.env.SAYCODE_TEST_AGENT_CLI)('keeps credentials unreadable while a real CLI whoami reaches the trusted host', async () => {
    const root = await fixture(), home = join(root, 'runtime'), project = join(root, 'project')
    await mkdir(home); await mkdir(project)
    await writeFile(join(home, 'access.key'), JSON.stringify({ token: 'fixture', secret: Buffer.alloc(32, 1).toString('base64') }))
    await writeFile(join(home, 'settings.json'), JSON.stringify({ machineId: 'fixture-machine' }))
    const env = { ...process.env, HAPPY_HOME_DIR: home, SAYCODE_HAPPY_HOME: home, SAYCODE_AGENT_ENV: '1',
      SAYCODE_AGENT_ROOT: project, SAYCODE_AGENT_SCOPE: project, SAYCODE_AGENT_DEPTH: '0', SAYCODE_AGENT_ID: 'fixture-parent',
      APLUS_SESSION_ID: 'fixture-session' }
    const entrypoint = process.env.SAYCODE_TEST_AGENT_CLI!
    const broker = await startAgentBroker({ execute: createAgentHostExecutor({ sessionId: 'fixture-session', directory: project, env, entrypoint }) })
    const deniedHome = process.env.SAYCODE_TEST_DENIED_HOME ?? home
    const profile = `(version 1)(allow default)(deny file-read* (subpath "${home}"))`
    const launch = (args: string[]) => process.env.SAYCODE_TEST_DENIED_HOME
      ? { command: process.execPath, args }
      : { command: '/usr/bin/sandbox-exec', args: ['-p', profile, process.execPath, ...args] }
    try {
      const probe = launch(['-e', `try { require('fs').readFileSync(${JSON.stringify(join(deniedHome, 'access.key'))}); console.log('UNEXPECTED_READ') } catch(e) { console.log(e.code) }`])
      expect((await run(probe.command, probe.args, { env })).stdout.trim()).toMatch(/^(EPERM|EACCES)$/)
      const client = launch([entrypoint, 'agent', 'whoami'])
      const { stdout } = await run(client.command, client.args, {
        env: { ...env, HAPPY_HOME_DIR: deniedHome, SAYCODE_HAPPY_HOME: deniedHome, ...broker.environment }, timeout: 15000,
      })
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, sessionId: 'fixture-session', machineId: 'fixture-machine', canSpawn: true })
      const catalog = JSON.parse(stdout).spawnModelOptions
      expect(catalog.find((entry: { agent: string }) => entry.agent === 'codex').models).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'gpt-6-astra', efforts: expect.arrayContaining(['high']) }),
      ]))
    } finally { await broker.close() }
  }, 30000)
})

it('uses private host IPC for fresh personal ownership, never provider env claims', async () => {
  const root = await fixture(), entrypoint = join(root, 'owner-cli.mjs')
  await writeFile(entrypoint, `
    if (!process.send) { console.log(JSON.stringify({exitCode:0,stdout:JSON.stringify({ok:true,ownership:null})})); }
    else {
      process.on('message', response => {
        console.log(JSON.stringify({exitCode:0,stdout:JSON.stringify({ok:true,ownership:response.ownership})}));
        process.disconnect();
      });
      process.send({type:'agent-ownership-v1',requestId:'request',targetSessionId:'sibling'});
    }
  `)
  let own = true
  const authority = { inspect: async () => own
    ? { relation: 'own-sibling' as const, proof: 'personal-same-account' as const, reason: 'same-account' }
    : { relation: 'unknown' as const, proof: null, reason: 'identity-changed' } }
  const execute = createAgentHostExecutor({ sessionId: 'current', directory: root,
    env: { SAYCODE_AGENT_PERSONAL: 'true', SAYCODE_AGENT_OWNER: 'forged' }, entrypoint, identityAuthority: authority })
  expect(JSON.parse((await execute(['prompt', 'sibling', 'hello'], new AbortController().signal)).stdout).ownership)
    .toMatchObject({ relation: 'own-sibling', proof: 'personal-same-account' })
  own = false
  expect(JSON.parse((await execute(['prompt', 'sibling', 'hello'], new AbortController().signal)).stdout).ownership)
    .toMatchObject({ relation: 'unknown' })
  const missing = createAgentHostExecutor({ sessionId: 'current', directory: root,
    env: { SAYCODE_AGENT_PERSONAL: 'true' }, entrypoint })
  expect(JSON.parse((await missing(['prompt', 'sibling', 'hello'], new AbortController().signal)).stdout).ownership)
    .toMatchObject({ relation: 'unknown' })
})
