import * as moduleApi from 'node:module'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { RESIDENT_MODULE_HOST_ENV } from '@/utils/childEnv'
import { startResidentModuleHost } from './residentModuleHost'

const execute = promisify(execFile)
const tempRoots: string[] = []
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happy-resident-module-test-')))
  tempRoots.push(root)
  const bin = join(root, 'bin')
  const dist = join(root, 'dist')
  const resident = join(dist, 'win32-resident')
  await mkdir(bin)
  await mkdir(resident, { recursive: true })
  const wrapper = join(bin, 'happy-resident-session.mjs')
  await cp(new URL('../../bin/happy-resident-session.mjs', import.meta.url), wrapper)
  const entry = "import { kind } from './companion.mjs'; console.log(JSON.stringify({kind,cwd:process.cwd(),provider:process.argv[2],scope:process.env.TEST_SESSION_SCOPE,tokenPresent:!!process.env.HAPPY_RESIDENT_MODULE_HOST,entry:import.meta.url}));"
  await writeFile(join(dist, 'index.mjs'), entry)
  await writeFile(join(dist, 'companion.mjs'), "export const kind = 'ordinary'")
  await writeFile(join(resident, 'index.mjs'), entry.replace('companion.mjs', 'resident-companion.mjs'))
  const companion = join(resident, 'resident-companion.mjs')
  await writeFile(companion, "export const kind = 'resident'")
  const launch = async (cwd: string, provider: string, scope: string, descriptor?: string) => {
    const { stdout } = await execute(process.execPath, [wrapper, provider], {
      cwd, env: { ...process.env, TEST_SESSION_SCOPE: scope, [RESIDENT_MODULE_HOST_ENV]: descriptor },
      windowsHide: true, timeout: 10_000,
    })
    return JSON.parse(stdout)
  }
  return { root, dist, resident, companion, wrapper, launch }
}

describe('resident Happy module host', () => {
  it.skipIf(!('registerHooks' in moduleApi) || typeof moduleApi.registerHooks !== 'function')('reuses one installation snapshot across separate Claude and Codex working environments', async () => {
    const { root, dist, companion, launch } = await fixture()
    const host = startResidentModuleHost(root)
    try {
      expect(await host.ready).toBe(true)
      const descriptor = host.descriptor()
      const { port } = JSON.parse(descriptor!)
      const denied = await fetch('http://127.0.0.1:' + port + '/modules')
      expect(denied.status).toBe(404)
      await denied.arrayBuffer()
      await writeFile(companion, "export const kind = 'changed after warmup'")
      const entry = pathToFileURL(join(dist, 'index.mjs')).href
      expect(await Promise.all([
        launch(root, 'claude', 'first', descriptor),
        launch(dist, 'codex', 'second', descriptor),
      ])).toEqual([
        { kind: 'resident', cwd: root, provider: 'claude', scope: 'first', tokenPresent: false, entry },
        { kind: 'resident', cwd: dist, provider: 'codex', scope: 'second', tokenPresent: false, entry },
      ])
      expect(host.descriptor()).toBe(descriptor)
    } finally { await host.close() }
  }, 15_000)

  it('starts the ordinary entry if the module host has already stopped', async () => {
    const { root, launch } = await fixture()
    const host = startResidentModuleHost(root)
    expect(await host.ready).toBe(true)
    const descriptor = host.descriptor()
    await host.close()
    expect(host.descriptor()).toBeUndefined()
    expect(await launch(root, 'codex', 'fallback', descriptor)).toMatchObject({
      kind: 'ordinary', provider: 'codex', scope: 'fallback', tokenPresent: false,
    })
  }, 15_000)
})
