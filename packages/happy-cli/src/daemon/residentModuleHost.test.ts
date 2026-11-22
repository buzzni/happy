import * as moduleApi from 'node:module'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { RESIDENT_MODULE_HOST_ENV } from '@/utils/childEnv'
import { bundledSeccompFilterPresent, residentModulesEnabled, startResidentModuleHost } from './residentModuleHost'

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

  it.skipIf(!('registerHooks' in moduleApi) || typeof moduleApi.registerHooks !== 'function')('starts the built CLI from the resident bundle', async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const host = startResidentModuleHost(root)
    try {
      expect(await host.ready).toBe(true)
      const { stdout, stderr } = await execute(process.execPath, ['bin/happy-resident-session.mjs', '--version'], {
        cwd: root, env: { ...process.env, [RESIDENT_MODULE_HOST_ENV]: host.descriptor() }, timeout: 15_000, windowsHide: true,
      })
      expect(stdout).toMatch(/happy version:/i)
      expect(stderr).toContain('resident Happy modules ready')
    } finally { await host.close() }
  }, 20_000)

  it.each(['x64', 'arm64'])('ships the %s seccomp filter where the bundled sandbox runtime looks for it', async arch => {
    // Bundled into dist/*.mjs, the sandbox runtime resolves vendor/seccomp/<arch> next to its own module URL.
    const vendor = fileURLToPath(new URL(`../../dist/vendor/seccomp/${arch}/`, import.meta.url))
    expect((await stat(join(vendor, 'unix-block.bpf'))).size).toBeGreaterThan(0)
    expect((await stat(join(vendor, 'apply-seccomp'))).mode & 0o111).not.toBe(0)
  })

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

describe('resident module gate', () => {
  const plainNode = { versions: {}, hasRegisterHooks: true, env: {}, linuxSeccompFilter: true }
  it.each(['win32', 'darwin', 'linux'] as const)('serves the resident bundle on %s Node with loader hooks', platform => {
    expect(residentModulesEnabled({ ...plainNode, platform })).toBe(true)
  })
  it('keeps Linux on the installed module graph when the bundle has no seccomp filter for this machine', () => {
    // Without the filter the bundled sandbox runtime would only warn and leave unix sockets unrestricted.
    expect(residentModulesEnabled({ ...plainNode, platform: 'linux', linuxSeccompFilter: false })).toBe(false)
    expect(residentModulesEnabled({ ...plainNode, platform: 'darwin', linuxSeccompFilter: false })).toBe(true)
  })
  it('finds the bundled seccomp filter only for the architectures the sandbox runtime supports', async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url))
    expect(bundledSeccompFilterPresent(root, 'x64')).toBe(true)
    expect(bundledSeccompFilterPresent(root, 'arm64')).toBe(true)
    expect(bundledSeccompFilterPresent(root, 'ia32')).toBe(false)
    const empty = await realpath(await mkdtemp(join(tmpdir(), 'happy-resident-seccomp-')))
    tempRoots.push(empty)
    expect(bundledSeccompFilterPresent(empty, 'x64')).toBe(false)
  })
  it('keeps other platforms on the installed module graph', () => {
    expect(residentModulesEnabled({ ...plainNode, platform: 'freebsd' })).toBe(false)
  })
  it('stays off under Electron, Bun, without loader hooks, or when disabled for comparison', () => {
    expect(residentModulesEnabled({ ...plainNode, platform: 'win32', versions: { electron: '41.0.0' } })).toBe(false)
    expect(residentModulesEnabled({ ...plainNode, platform: 'win32', versions: { bun: '1.3.0' } })).toBe(false)
    expect(residentModulesEnabled({ ...plainNode, platform: 'win32', hasRegisterHooks: false })).toBe(false)
    expect(residentModulesEnabled({ ...plainNode, platform: 'win32', env: { HAPPY_DISABLE_RESIDENT_MODULES: '1' } })).toBe(false)
  })
})
