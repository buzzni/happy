import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createPortRegistry } from './portRegistry'

describe('portRegistry', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'port-registry-'))
    file = path.join(dir, 'port-registry.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const alwaysBindable = async () => true
  const neverBindable = async () => false
  const bindableExcept = (blocked: Set<number>) => async (port: number) => !blocked.has(port)

  it('allocates the lowest port in range for a new (user, project)', async () => {
    const reg = createPortRegistry({
      filePath: file,
      portMin: 30000,
      portMax: 30010,
      isPortBindable: alwaysBindable,
    })
    const result = await reg.allocate('user-A', 'proj-a')
    expect(result).toEqual({ port: 30000, reused: false })
  })

  it('returns the same port when the same (user, project) allocates twice (reused: true)', async () => {
    const reg = createPortRegistry({
      filePath: file,
      portMin: 30000,
      portMax: 30010,
      isPortBindable: alwaysBindable,
    })
    const first = await reg.allocate('user-A', 'proj-a')
    const second = await reg.allocate('user-A', 'proj-a')
    expect(second.port).toBe(first.port)
    expect(second.reused).toBe(true)
  })

  it('allocates distinct ports to different projectIds for the same user', async () => {
    const reg = createPortRegistry({
      filePath: file,
      portMin: 30000,
      portMax: 30010,
      isPortBindable: alwaysBindable,
    })
    const a = await reg.allocate('user-A', 'proj-a')
    const b = await reg.allocate('user-A', 'proj-b')
    const c = await reg.allocate('user-A', 'proj-c')
    expect(new Set([a.port, b.port, c.port]).size).toBe(3)
  })

  it('skips ports already claimed by other projects when scanning', async () => {
    const reg = createPortRegistry({
      filePath: file,
      portMin: 30000,
      portMax: 30010,
      isPortBindable: alwaysBindable,
    })
    await reg.allocate('user-A', 'proj-a')
    const b = await reg.allocate('user-A', 'proj-b')
    expect(b.port).toBe(30001)
  })

  it('skips ports that fail the bind test', async () => {
    const reg = createPortRegistry({
      filePath: file,
      portMin: 30000,
      portMax: 30010,
      isPortBindable: bindableExcept(new Set([30000, 30001])),
    })
    const result = await reg.allocate('user-A', 'proj-a')
    expect(result.port).toBe(30002)
  })

  it('reallocates when the stored port is no longer bindable', async () => {
    const firstReg = createPortRegistry({
      filePath: file,
      portMin: 30000,
      portMax: 30010,
      isPortBindable: alwaysBindable,
    })
    const initial = await firstReg.allocate('user-A', 'proj-a')
    expect(initial.port).toBe(30000)

    const secondReg = createPortRegistry({
      filePath: file,
      portMin: 30000,
      portMax: 30010,
      isPortBindable: bindableExcept(new Set([30000])),
    })
    const reallocated = await secondReg.allocate('user-A', 'proj-a')
    expect(reallocated.port).not.toBe(30000)
    expect(reallocated.reused).toBe(false)
  })

  it('throws when the port range is exhausted', async () => {
    const reg = createPortRegistry({
      filePath: file,
      portMin: 30000,
      portMax: 30001,
      isPortBindable: alwaysBindable,
    })
    await reg.allocate('user-A', 'proj-a')
    await reg.allocate('user-A', 'proj-b')
    await expect(reg.allocate('user-A', 'proj-c')).rejects.toThrow(/No available port/)
  })

  it('throws when no port in the range is bindable', async () => {
    const reg = createPortRegistry({
      filePath: file,
      portMin: 30000,
      portMax: 30002,
      isPortBindable: neverBindable,
    })
    await expect(reg.allocate('user-A', 'proj-a')).rejects.toThrow(/No available port/)
  })

  it('persists allocations to disk across registry instances', async () => {
    const first = createPortRegistry({
      filePath: file,
      portMin: 30000,
      portMax: 30010,
      isPortBindable: alwaysBindable,
    })
    await first.allocate('user-A', 'proj-a')

    const second = createPortRegistry({
      filePath: file,
      portMin: 30000,
      portMax: 30010,
      isPortBindable: alwaysBindable,
    })
    const reused = await second.allocate('user-A', 'proj-a')
    expect(reused.port).toBe(30000)
    expect(reused.reused).toBe(true)
  })

  it('release removes an existing entry and returns true', async () => {
    const reg = createPortRegistry({
      filePath: file,
      portMin: 30000,
      portMax: 30010,
      isPortBindable: alwaysBindable,
    })
    await reg.allocate('user-A', 'proj-a')
    const released = await reg.release('user-A', 'proj-a')
    expect(released).toBe(true)
    const all = await reg.readAll()
    expect(all['user-A:proj-a']).toBeUndefined()
  })

  it('release returns false for an unknown (user, project)', async () => {
    const reg = createPortRegistry({
      filePath: file,
      portMin: 30000,
      portMax: 30010,
      isPortBindable: alwaysBindable,
    })
    const released = await reg.release('user-A', 'missing')
    expect(released).toBe(false)
  })

  it('after release, the freed port is reusable by a different project', async () => {
    const reg = createPortRegistry({
      filePath: file,
      portMin: 30000,
      portMax: 30010,
      isPortBindable: alwaysBindable,
    })
    const a = await reg.allocate('user-A', 'proj-a')
    await reg.release('user-A', 'proj-a')
    const b = await reg.allocate('user-A', 'proj-b')
    expect(b.port).toBe(a.port)
  })

  it('serializes concurrent allocate calls so different projects get different ports', async () => {
    const reg = createPortRegistry({
      filePath: file,
      portMin: 30000,
      portMax: 30010,
      isPortBindable: alwaysBindable,
    })
    const results = await Promise.all([
      reg.allocate('user-A', 'p1'),
      reg.allocate('user-A', 'p2'),
      reg.allocate('user-A', 'p3'),
      reg.allocate('user-A', 'p4'),
    ])
    const ports = results.map((r) => r.port)
    expect(new Set(ports).size).toBe(4)
    for (const p of ports) {
      expect(p).toBeGreaterThanOrEqual(30000)
      expect(p).toBeLessThanOrEqual(30010)
    }
  })

  it('treats a missing registry file as empty', async () => {
    const reg = createPortRegistry({
      filePath: file,
      portMin: 30000,
      portMax: 30010,
      isPortBindable: alwaysBindable,
    })
    const all = await reg.readAll()
    expect(all).toEqual({})
  })

  it('treats an unreadable/corrupt registry file as empty', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{ not valid json', 'utf-8')
    const reg = createPortRegistry({
      filePath: file,
      portMin: 30000,
      portMax: 30010,
      isPortBindable: alwaysBindable,
    })
    const result = await reg.allocate('user-A', 'proj-a')
    expect(result.port).toBe(30000)
  })

  it('creates parent directories for the registry file', async () => {
    const nested = path.join(dir, 'nested', 'dir', 'port-registry.json')
    const reg = createPortRegistry({
      filePath: nested,
      portMin: 30000,
      portMax: 30010,
      isPortBindable: alwaysBindable,
    })
    await reg.allocate('user-A', 'proj-a')
    const content = await fs.readFile(nested, 'utf-8')
    expect(JSON.parse(content)).toHaveProperty('user-A:proj-a')
  })

  // Phase 4 — per-user isolation guarantees.
  describe('per-user isolation', () => {
    it('gives different ports to two users that share the same projectId string', async () => {
      const reg = createPortRegistry({
        filePath: file,
        portMin: 30000,
        portMax: 30010,
        isPortBindable: alwaysBindable,
      })
      const a = await reg.allocate('user-A', 'shared-name')
      const b = await reg.allocate('user-B', 'shared-name')
      expect(a.port).not.toBe(b.port)
    })

    it("user A's release does not affect user B's entry for the same projectId", async () => {
      const reg = createPortRegistry({
        filePath: file,
        portMin: 30000,
        portMax: 30010,
        isPortBindable: alwaysBindable,
      })
      const a = await reg.allocate('user-A', 'shared-name')
      const b = await reg.allocate('user-B', 'shared-name')
      const releasedA = await reg.release('user-A', 'shared-name')
      expect(releasedA).toBe(true)
      const all = await reg.readAll()
      expect(all['user-A:shared-name']).toBeUndefined()
      expect(all['user-B:shared-name']?.port).toBe(b.port)
    })

    it('persists userId and projectId on each entry value', async () => {
      const reg = createPortRegistry({
        filePath: file,
        portMin: 30000,
        portMax: 30010,
        isPortBindable: alwaysBindable,
      })
      await reg.allocate('user-A', 'proj-a')
      const all = await reg.readAll()
      expect(all['user-A:proj-a']?.userId).toBe('user-A')
      expect(all['user-A:proj-a']?.projectId).toBe('proj-a')
    })
  })

  // Phase 4 — migration of legacy entries written before composite keys.
  describe('legacy entry migration', () => {
    it('upgrades a legacy projectId-keyed entry to userId:projectId on first matching allocate', async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(
        file,
        JSON.stringify({ 'proj-old': { port: 30005, allocatedAt: 100 } }),
      )
      const reg = createPortRegistry({
        filePath: file,
        portMin: 30000,
        portMax: 30010,
        isPortBindable: alwaysBindable,
      })
      const result = await reg.allocate('user-A', 'proj-old')
      expect(result).toEqual({ port: 30005, reused: true })
      const all = await reg.readAll()
      expect(all['proj-old']).toBeUndefined()
      expect(all['user-A:proj-old']?.port).toBe(30005)
      expect(all['user-A:proj-old']?.userId).toBe('user-A')
    })

    it('does not reuse a legacy port when its bind test fails', async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(
        file,
        JSON.stringify({ 'proj-old': { port: 30005, allocatedAt: 100 } }),
      )
      const reg = createPortRegistry({
        filePath: file,
        portMin: 30000,
        portMax: 30010,
        isPortBindable: bindableExcept(new Set([30005])),
      })
      const result = await reg.allocate('user-A', 'proj-old')
      expect(result.port).not.toBe(30005)
      expect(result.reused).toBe(false)
    })

    it('release accepts a legacy bare-projectId entry and removes it', async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(
        file,
        JSON.stringify({ 'proj-old': { port: 30005, allocatedAt: 100 } }),
      )
      const reg = createPortRegistry({
        filePath: file,
        portMin: 30000,
        portMax: 30010,
        isPortBindable: alwaysBindable,
      })
      const released = await reg.release('user-A', 'proj-old')
      expect(released).toBe(true)
      const all = await reg.readAll()
      expect(all['proj-old']).toBeUndefined()
    })
  })
})
