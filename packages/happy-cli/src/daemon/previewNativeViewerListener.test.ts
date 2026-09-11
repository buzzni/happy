import { describe, expect, it, vi } from 'vitest'
import {
  probeNativeViewerListenerEvidence,
  VIEWER_LISTENER_NOT_OWNED,
} from './previewNativeViewerListener'
import type { EvidenceIo } from './previewRuntimeEvidence'

const PORT = 46337
const PORT_HEX = PORT.toString(16).toUpperCase().padStart(4, '0')
const PARENT = 3821832
const WORKER = 3821834
const INODE = '2287524552'
const OTHER_INODE = '2287524553'

/** One `/proc/net/tcp` LISTEN row (`st` 0A), inode in column 9. */
function v4Row(address: string, inode: string): string {
  return `   1: ${address}:${PORT_HEX} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000 100 0 0 10 0`
}

function v6AnyRow(inode: string): string {
  return `   1: 00000000000000000000000000000000:${PORT_HEX} 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000 100 0 0 10 0`
}

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'

function table(rows: string[]): string {
  return [HEADER, ...rows, ''].join('\n')
}

interface Fixture {
  /** `/proc/net/tcp` content, or null for an unreadable table. */
  tcp?: string | null
  tcp6?: string | null
  /** pid → its fd numbers, or null when the fd table cannot be read. */
  fds?: Record<number, string[] | null>
  /** `<pid>/fd/<fd>` → link target. */
  links?: Record<string, string>
  stat?: Record<number, string | null>
  cwd?: Record<number, string | null>
  connect?: Awaited<ReturnType<EvidenceIo['connectLoopback']>>
  platform?: string
  /**
   * `docker ps` result. Default is docker *present and answering with no
   * container* — the honest positive-path shape. Stubbing it as absent would
   * let every positive test pass without the container check ever running.
   */
  docker?: Awaited<ReturnType<EvidenceIo['exec']>>
  /** `docker inspect` State.StartedAt, for the container-found regression. */
  containerStartedAt?: string
  /** `/sys/module/ipv6/parameters/disable` content, or null when absent. */
  ipv6Disable?: string | null
}

function makeIo(fixture: Fixture): EvidenceIo & { connect: { calls: number }; readDirCalls: string[] } {
  const readDirCalls: string[] = []
  const connect = { calls: 0 }
  const io = {
    platform: fixture.platform ?? 'linux',
    exec: async (file: string, args: string[]) => {
      if (file !== 'docker') return { status: 'missing' as const }
      if (args[0] === 'inspect') {
        return { status: 'ok' as const, stdout: `${fixture.containerStartedAt ?? '2026-09-11T04:00:00.000000000Z'}\n` }
      }
      return fixture.docker ?? { status: 'ok' as const, stdout: '' }
    },
    readFile: async (path: string) => {
      if (path === '/proc/net/tcp') return fixture.tcp === undefined ? table([]) : fixture.tcp
      if (path === '/proc/net/tcp6') return fixture.tcp6 === undefined ? table([]) : fixture.tcp6
      if (path === '/sys/module/ipv6/parameters/disable') {
        return fixture.ipv6Disable === undefined ? null : fixture.ipv6Disable
      }
      const stat = path.match(/^\/proc\/(\d+)\/stat$/)
      if (stat) {
        const pid = Number(stat[1])
        const configured = fixture.stat?.[pid]
        if (configured !== undefined) return configured
        // Field 22 (index 19 after the final `)`) is the start time.
        return `${pid} (websockify) S 1 ${pid} ${pid} 0 -1 4194304 0 0 0 0 1 2 0 0 20 0 1 0 987654 0 0 0 0`
      }
      return null
    },
    readDir: async (path: string) => {
      readDirCalls.push(path)
      const match = path.match(/^\/proc\/(\d+)\/fd$/)
      if (!match) return null
      const pid = Number(match[1])
      const configured = fixture.fds?.[pid]
      return configured === undefined ? null : configured
    },
    readLink: async (path: string) => {
      const cwd = path.match(/^\/proc\/(\d+)\/cwd$/)
      if (cwd) {
        const pid = Number(cwd[1])
        const configured = fixture.cwd?.[pid]
        return configured === undefined ? '/home/coder/.happy_remote/browser-viewers/bv1' : configured
      }
      return fixture.links?.[path.replace('/proc/', '')] ?? null
    },
    connectLoopback: async () => {
      connect.calls += 1
      return fixture.connect ?? { status: 'failed' as const, detail: 'no connect configured' }
    },
  }
  // A plain object, not a getter: Object.assign copies a getter's *value*,
  // which froze the counter at 0 and made this stub silently useless.
  return Object.assign(io as unknown as EvidenceIo, { connect, readDirCalls })
}

/** The real shape from root's Linux run: parent and worker, one socket. */
function inheritedSocketFixture(overrides: Partial<Fixture> = {}): Fixture {
  return {
    tcp: table([v4Row('0100007F', INODE)]),
    fds: { [PARENT]: ['0', '1', '2', '3'], [WORKER]: ['0', '1', '2', '3'] },
    links: {
      [`${PARENT}/fd/3`]: `socket:[${INODE}]`,
      [`${WORKER}/fd/3`]: `socket:[${INODE}]`,
    },
    ...overrides,
  }
}

describe('probeNativeViewerListenerEvidence', () => {
  // 2026-09-11 root Linux probe: websockify forks a worker and both keep the
  // same listening socket. Counting processes called a healthy viewer
  // contested; counting sockets sees one listener with two holders.
  it('accepts an inherited listener where parent and worker share one socket', async () => {
    const io = makeIo(inheritedSocketFixture())

    await expect(probeNativeViewerListenerEvidence(PORT, PARENT, io)).resolves.toEqual({
      status: 'found',
      evidence: {
        kind: 'process',
        id: String(PARENT),
        startedAt: '987654',
        cwd: '/home/coder/.happy_remote/browser-viewers/bv1',
      },
    })
  })

  it('reports the expected pid, not whichever holder was found first', async () => {
    const io = makeIo(inheritedSocketFixture())
    const worker = await probeNativeViewerListenerEvidence(PORT, WORKER, io)
    expect(worker).toMatchObject({ evidence: { id: String(WORKER) } })
  })

  // The registry pid is the authority. Nothing here walks /proc looking for a
  // process whose name resembles websockify, and nothing infers ownership from
  // a parent/child relationship.
  it('never scans /proc for candidate owners', async () => {
    const io = makeIo(inheritedSocketFixture())
    await probeNativeViewerListenerEvidence(PORT, PARENT, io)
    expect(io.readDirCalls).toEqual([`/proc/${PARENT}/fd`])
  })

  // Two distinct inodes on one port is SO_REUSEPORT: the kernel decides which
  // socket accepts, so no evidence here can say which runtime the relay reaches.
  it('refuses two distinct listening sockets even when the expected pid holds one', async () => {
    const io = makeIo({
      tcp: table([v4Row('0100007F', INODE), v4Row('0100007F', OTHER_INODE)]),
      fds: { [PARENT]: ['3'] },
      links: { [`${PARENT}/fd/3`]: `socket:[${INODE}]` },
    })

    const result = await probeNativeViewerListenerEvidence(PORT, PARENT, io)
    expect(result).toMatchObject({ status: 'ambiguous' })
    expect((result as { detail: string }).detail).toContain('2 distinct listening sockets')
  })

  it('refuses when the expected pid does not hold the listening socket', async () => {
    const io = makeIo({
      tcp: table([v4Row('0100007F', INODE)]),
      fds: { [PARENT]: ['0', '1', '2'] },
      links: { [`${PARENT}/fd/3`]: `socket:[${INODE}]` },
    })

    const result = await probeNativeViewerListenerEvidence(PORT, PARENT, io)
    expect(result).toMatchObject({ status: 'ambiguous' })
    expect((result as { detail: string }).detail).toContain(VIEWER_LISTENER_NOT_OWNED)
  })

  it('separates an unreadable fd table from a pid that simply does not own it', async () => {
    const io = makeIo({
      tcp: table([v4Row('0100007F', INODE)]),
      fds: { [PARENT]: null },
    })
    await expect(probeNativeViewerListenerEvidence(PORT, PARENT, io)).resolves.toMatchObject({
      status: 'unavailable',
    })
  })

  it('answers none when nothing is listening and both tables were readable', async () => {
    await expect(probeNativeViewerListenerEvidence(PORT, PARENT, makeIo({}))).resolves.toEqual({
      status: 'none',
    })
  })

  // The socket we are missing may be the second one — a partial read cannot
  // prove "exactly one" any more than it can prove "none".
  it('refuses a partial read of the proc tables, with or without a row in the other', async () => {
    await expect(
      probeNativeViewerListenerEvidence(PORT, PARENT, makeIo({ tcp6: null })),
    ).resolves.toMatchObject({ status: 'unavailable', detail: expect.stringContaining('/proc/net/tcp6') })

    await expect(
      probeNativeViewerListenerEvidence(PORT, PARENT, makeIo(inheritedSocketFixture({ tcp6: null }))),
    ).resolves.toMatchObject({ status: 'unavailable', detail: expect.stringContaining('/proc/net/tcp6') })
  })

  // 2026-09-11 root rerun: the target has the IPv6 module loaded with
  // disable=1, so /proc/net/tcp6 is ENOENT. Refusing a healthy IPv4 viewer for
  // a table that cannot exist is the bug; tolerating any missing table would
  // be the wrong fix.
  describe('IPv6 disabled on the host', () => {
    const disabled = (ipv6Disable: string | null) =>
      inheritedSocketFixture({ tcp6: null, ipv6Disable })

    it('accepts an IPv4 viewer when the kernel proves IPv6 is off', async () => {
      const io = makeIo(disabled('1\n'))
      await expect(probeNativeViewerListenerEvidence(PORT, PARENT, io)).resolves.toMatchObject({
        status: 'found',
        evidence: { kind: 'process', id: String(PARENT) },
      })
    })

    it('answers none, not unavailable, when IPv6 is off and nothing listens', async () => {
      await expect(
        probeNativeViewerListenerEvidence(PORT, PARENT, makeIo({ tcp6: null, ipv6Disable: '1' })),
      ).resolves.toEqual({ status: 'none' })
    })

    // Absent proof is not proof. A missing table with no explanation stays a
    // gap, which is the whole point of asking the kernel instead of shrugging.
    it('still refuses without the proof file, or with 0 or a malformed value', async () => {
      for (const value of [null, '0', '0\n', 'disabled', '', '11', '1 0']) {
        const io = makeIo(disabled(value))
        await expect(probeNativeViewerListenerEvidence(PORT, PARENT, io)).resolves.toMatchObject({
          status: 'unavailable',
          detail: expect.stringContaining('/proc/net/tcp6'),
        })
      }
    })

    // The viewer's own socket lives in /proc/net/tcp. No amount of IPv6 being
    // off makes that table optional.
    it('still refuses when /proc/net/tcp is unreadable, even with IPv6 off', async () => {
      const io = makeIo({ tcp: null, ipv6Disable: '1' })
      await expect(probeNativeViewerListenerEvidence(PORT, PARENT, io)).resolves.toMatchObject({
        status: 'unavailable',
        detail: expect.stringContaining('/proc/net/tcp'),
      })
    })

    it('still refuses when both tables are unreadable and IPv6 is off', async () => {
      const io = makeIo({ tcp: null, tcp6: null, ipv6Disable: '1' })
      await expect(probeNativeViewerListenerEvidence(PORT, PARENT, io)).resolves.toMatchObject({
        status: 'unavailable',
      })
    })

    // Nothing should consult the flag when both tables read fine.
    it('does not read the flag when tcp6 is readable', async () => {
      const reads: string[] = []
      const io = makeIo(inheritedSocketFixture())
      const inner = io.readFile
      io.readFile = async (path: string) => { reads.push(path); return inner(path) }
      await probeNativeViewerListenerEvidence(PORT, PARENT, io)
      expect(reads).not.toContain('/sys/module/ipv6/parameters/disable')
    })
  })

  it('refuses when the start time or cwd of the holder is unreadable or malformed', async () => {
    for (const overrides of [
      { stat: { [PARENT]: null } },
      // Truncated: field 22 is simply absent.
      { stat: { [PARENT]: `${PARENT} (websockify) S 1` } },
      // Present but not a number. This is the case that needs the digit check
      // rather than a presence check: a non-numeric start time would still be
      // hashed into a lease digest, and two different runs could then agree.
      { stat: { [PARENT]: `${PARENT} (websockify) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 notanumber` } },
      { cwd: { [PARENT]: null } },
    ] as Partial<Fixture>[]) {
      const io = makeIo(inheritedSocketFixture(overrides))
      await expect(probeNativeViewerListenerEvidence(PORT, PARENT, io)).resolves.toMatchObject({
        status: 'unavailable',
      })
    }
  })

  it('reads the start time past a command name containing spaces and parens', async () => {
    const io = makeIo(inheritedSocketFixture({
      stat: { [PARENT]: `${PARENT} (web socki:fy (x)) S 1 ${PARENT} ${PARENT} 0 -1 0 0 0 0 0 1 2 0 0 20 0 1 0 424242 0` },
    }))
    await expect(probeNativeViewerListenerEvidence(PORT, PARENT, io)).resolves.toMatchObject({
      evidence: { startedAt: '424242' },
    })
  })

  describe('wildcard IPv6 listener', () => {
    const v6Fixture = (connect: Fixture['connect']): Fixture => ({
      tcp6: table([v6AnyRow(INODE)]),
      fds: { [PARENT]: ['3'] },
      links: { [`${PARENT}/fd/3`]: `socket:[${INODE}]` },
      connect,
    })

    // `::` may be v6-only; the tables cannot say. Only the relay's own
    // destination answering proves it is reachable.
    it('accepts it only once 127.0.0.1 is proven to reach it', async () => {
      const io = makeIo(v6Fixture({ status: 'connected' }))
      await expect(probeNativeViewerListenerEvidence(PORT, PARENT, io)).resolves.toMatchObject({
        status: 'found',
        evidence: { id: String(PARENT) },
      })
      expect(io.connect.calls).toBe(1)
    })

    it('answers none when the destination refuses', async () => {
      await expect(
        probeNativeViewerListenerEvidence(PORT, PARENT, makeIo(v6Fixture({ status: 'refused' }))),
      ).resolves.toEqual({ status: 'none' })
    })

    it('refuses when reachability cannot be established', async () => {
      await expect(
        probeNativeViewerListenerEvidence(PORT, PARENT, makeIo(v6Fixture({ status: 'failed', detail: 'EHOSTUNREACH' }))),
      ).resolves.toMatchObject({ status: 'unavailable' })
    })

    it('does not connect for a plain IPv4 listener', async () => {
      const io = makeIo(inheritedSocketFixture())
      await probeNativeViewerListenerEvidence(PORT, PARENT, io)
      expect(io.connect.calls).toBe(0)
    })
  })

  it('rejects a pid that is not a positive integer without touching /proc', async () => {
    const io = makeIo(inheritedSocketFixture())
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      await expect(probeNativeViewerListenerEvidence(PORT, pid, io)).resolves.toMatchObject({
        status: 'unavailable',
      })
    }
    expect(io.readDirCalls).toEqual([])
  })

  // A published container port is DNAT'd: 127.0.0.1:{port} lands inside the
  // container, and the host LISTEN row is docker's proxy. Proving an inode
  // first would let a container answer for a native viewer's port, so the
  // container check keeps the precedence it has in the generic probe.
  describe('container publish precedence', () => {
    const publishing = (ports: string) => ({
      status: 'ok' as const,
      stdout: `abc123\t${ports}\tvnc-box\tproj-1\n`,
    })

    it('returns the container instead of the host-side inode', async () => {
      const io = makeIo(inheritedSocketFixture({ docker: publishing(`0.0.0.0:${PORT}->6080/tcp`) }))
      await expect(probeNativeViewerListenerEvidence(PORT, PARENT, io)).resolves.toMatchObject({
        status: 'found',
        evidence: { kind: 'container', id: 'abc123', name: 'vnc-box', projectLabel: 'proj-1' },
      })
      // The inode path must not have run at all.
      expect(io.readDirCalls).toEqual([])
    })

    it('refuses natively when two containers publish the port', async () => {
      const io = makeIo(inheritedSocketFixture({
        docker: {
          status: 'ok',
          stdout: `a\t0.0.0.0:${PORT}->6080/tcp\tone\t\nb\t127.0.0.1:${PORT}->6080/tcp\ttwo\t\n`,
        },
      }))
      await expect(probeNativeViewerListenerEvidence(PORT, PARENT, io)).resolves.toMatchObject({
        status: 'ambiguous',
      })
      expect(io.readDirCalls).toEqual([])
    })

    it('refuses natively when the docker query itself fails', async () => {
      const io = makeIo(inheritedSocketFixture({ docker: { status: 'failed', detail: 'daemon not running' } }))
      await expect(probeNativeViewerListenerEvidence(PORT, PARENT, io)).resolves.toMatchObject({
        status: 'unavailable',
      })
      expect(io.readDirCalls).toEqual([])
    })

    // Existing semantics: docker absent is a definite "no container", not a
    // failure. A machine without Docker still gets native viewer evidence.
    it('falls through to the inode proof when docker is not installed', async () => {
      const io = makeIo(inheritedSocketFixture({ docker: { status: 'missing' } }))
      await expect(probeNativeViewerListenerEvidence(PORT, PARENT, io)).resolves.toMatchObject({
        status: 'found',
        evidence: { kind: 'process', id: String(PARENT) },
      })
    })

    // A container on an address loopback cannot reach leaves the destination
    // unexplained — that stays a refusal rather than becoming a native answer.
    it('refuses natively for a container published on an unreachable address', async () => {
      const io = makeIo(inheritedSocketFixture({ docker: publishing(`192.168.1.4:${PORT}->6080/tcp`) }))
      await expect(probeNativeViewerListenerEvidence(PORT, PARENT, io)).resolves.toMatchObject({
        status: 'ambiguous',
      })
      expect(io.readDirCalls).toEqual([])
    })
  })

  // No new macOS guarantee: the inherited-socket problem is Linux evidence,
  // and lsof cannot show the inode that would settle it.
  it('delegates to the generic probe off Linux', async () => {
    const io = makeIo({ platform: 'darwin', ...inheritedSocketFixture() })
    const result = await probeNativeViewerListenerEvidence(PORT, PARENT, io)
    // The generic probe has no lsof here, so it cannot find anything — the
    // point is that it ran instead of the /proc path.
    expect(result.status).not.toBe('found')
    expect(io.readDirCalls).toEqual([])
  })
})
