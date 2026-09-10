import { describe, it, expect, vi } from 'vitest'
import {
  probeListenerEvidence,
  fingerprintEvidence,
  type EvidenceIo,
} from './previewRuntimeEvidence'

const DOCKER_LINE = (id: string, ports: string, name: string, projectLabel: string) =>
  [id, ports, name, projectLabel].join('\t')

function makeIo(overrides: Partial<EvidenceIo> = {}): EvidenceIo {
  return {
    platform: 'linux',
    exec: vi.fn().mockResolvedValue({ status: 'missing' }),
    readFile: vi.fn().mockResolvedValue(null),
    readDir: vi.fn().mockResolvedValue(null),
    readLink: vi.fn().mockResolvedValue(null),
    connectLoopback: vi.fn().mockResolvedValue({ status: 'failed', detail: 'connect not stubbed' }),
    ...overrides,
  }
}

/** Real `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpnt` shape: p, then f/t/n per socket fd. */
function lsofListing(entries: { pid: string; type: 'IPv4' | 'IPv6'; name: string }[]): string {
  const byPid = new Map<string, typeof entries>()
  for (const entry of entries) byPid.set(entry.pid, [...(byPid.get(entry.pid) ?? []), entry])
  let out = ''
  let fd = 12
  for (const [pid, sockets] of byPid) {
    out += `p${pid}\n`
    for (const socket of sockets) out += `f${fd++}\nt${socket.type}\nn${socket.name}\n`
  }
  return out
}

/**
 * `docker ps` answers *which* container publishes the port; the run
 * generation comes from a second `docker inspect` for `State.StartedAt`,
 * because `CreatedAt` survives a restart unchanged.
 */
const dockerIo = (
  lines: string[],
  options: { startedAt?: Record<string, string>; inspect?: EvidenceIo['exec'] } = {},
  overrides: Partial<EvidenceIo> = {},
) => makeIo({
  exec: vi.fn(async (file: string, args: string[], timeoutMs: number) => {
    if (file !== 'docker') return { status: 'missing' as const }
    if (args[0] === 'inspect') {
      if (options.inspect) return options.inspect(file, args, timeoutMs)
      const id = args[args.length - 1]
      return { status: 'ok' as const, stdout: `${options.startedAt?.[id] ?? '2026-09-10T10:05:00.1Z'}\n` }
    }
    return { status: 'ok' as const, stdout: lines.join('\n') }
  }),
  ...overrides,
})

describe('probeListenerEvidence — container publish', () => {
  it('reports the container id, run start time and project label', async () => {
    const io = dockerIo(
      [
        DOCKER_LINE('abc123', '0.0.0.0:32780->5173/tcp', 'preview-a', 'proj-a'),
        DOCKER_LINE('def456', '127.0.0.1:32781->3000/tcp', 'preview-b', 'proj-b'),
      ],
      { startedAt: { def456: '2026-09-10T10:05:00.123456789Z' } },
    )
    await expect(probeListenerEvidence(32781, io)).resolves.toEqual({
      status: 'found',
      evidence: {
        kind: 'container',
        id: 'def456',
        startedAt: '2026-09-10T10:05:00.123456789Z',
        name: 'preview-b',
        projectLabel: 'proj-b',
      },
    })
  })

  it('changes the evidence when the same container is restarted', async () => {
    // The reason this probe cannot use `CreatedAt`: it is the *image
    // instantiation* time and survives `docker restart` unchanged, so a
    // token minted before the restart would still verify against the new
    // process — the exact stale-lease acceptance this pins the port to.
    const line = [DOCKER_LINE('abc123', '127.0.0.1:32783->5173/tcp', 'preview-a', 'proj-a')]
    const before = await probeListenerEvidence(32783, dockerIo(line, { startedAt: { abc123: '2026-09-10T10:00:00Z' } }))
    const after = await probeListenerEvidence(32783, dockerIo(line, { startedAt: { abc123: '2026-09-10T12:30:00Z' } }))

    if (before.status !== 'found' || after.status !== 'found') throw new Error('expected both probes to find the container')
    expect(fingerprintEvidence(after.evidence)).not.toBe(fingerprintEvidence(before.evidence))
  })

  it('fails closed when the container start time cannot be inspected', async () => {
    const io = dockerIo(
      [DOCKER_LINE('abc123', '0.0.0.0:32780->5173/tcp', 'preview-a', 'proj-a')],
      { inspect: async () => ({ status: 'failed', detail: 'no such object' }) },
    )
    await expect(probeListenerEvidence(32780, io)).resolves.toMatchObject({ status: 'unavailable' })
  })

  it('fails closed when the inspected start time is docker\'s never-started zero value', async () => {
    const io = dockerIo(
      [DOCKER_LINE('abc123', '0.0.0.0:32780->5173/tcp', 'preview-a', 'proj-a')],
      { startedAt: { abc123: '0001-01-01T00:00:00Z' } },
    )
    await expect(probeListenerEvidence(32780, io)).resolves.toMatchObject({ status: 'unavailable' })
  })

  it('reports a container without the aplus.projectId label as unlabelled, not as owned', async () => {
    const io = dockerIo([DOCKER_LINE('abc123', '0.0.0.0:32780->5173/tcp', 'stray', '')])
    await expect(probeListenerEvidence(32780, io)).resolves.toMatchObject({
      status: 'found',
      evidence: { kind: 'container', id: 'abc123', projectLabel: null },
    })
  })

  it('does not match a container that only exposes the port inside the container', async () => {
    // 3000 is the *container* side; the published host port is 32780. With a
    // readable /proc showing no listener, the honest answer is 'none'.
    const io = dockerIo(
      [DOCKER_LINE('abc123', '0.0.0.0:32780->3000/tcp', 'preview-a', 'proj-a')],
      {},
      { readFile: vi.fn(async (p: string) => (p.startsWith('/proc/net/tcp') ? 'header only\n' : null)) },
    )
    await expect(probeListenerEvidence(3000, io)).resolves.toEqual({ status: 'none' })
  })

  it('reports two containers on one host port as ambiguous, never picking one', async () => {
    const io = dockerIo([
      DOCKER_LINE('abc123', '0.0.0.0:32780->5173/tcp', 'preview-a', 'proj-a'),
      DOCKER_LINE('def456', '127.0.0.1:32780->3000/tcp', 'preview-b', 'proj-b'),
    ])
    await expect(probeListenerEvidence(32780, io)).resolves.toMatchObject({ status: 'ambiguous' })
  })

  it('fails closed on a publish address the daemon cannot reach over loopback', async () => {
    // `192.168.1.5:32780->5173/tcp` is not what `127.0.0.1:32780` reaches, so
    // this container is not proof about the port — and neither is its
    // absence, because something else may hold the loopback address.
    const io = dockerIo([DOCKER_LINE('abc123', '192.168.1.5:32780->5173/tcp', 'preview-a', 'proj-a')])
    await expect(probeListenerEvidence(32780, io)).resolves.toMatchObject({ status: 'ambiguous' })
  })

  it('accepts the two publish addresses that 127.0.0.1 provably reaches', async () => {
    for (const hostIp of ['0.0.0.0', '127.0.0.1']) {
      const io = dockerIo([DOCKER_LINE('abc123', `${hostIp}:32780->5173/tcp`, 'preview-a', 'proj-a')])
      await expect(probeListenerEvidence(32780, io)).resolves.toMatchObject({ status: 'found' })
    }
  })

  it('accepts the usual dual publish line as long as the IPv4 half is there', async () => {
    const io = dockerIo([DOCKER_LINE('abc123', '0.0.0.0:32780->5173/tcp, [::]:32780->5173/tcp', 'preview-a', 'proj-a')])
    await expect(probeListenerEvidence(32780, io)).resolves.toMatchObject({ status: 'found' })
  })

  it('does not take an IPv6-only publish as proof about 127.0.0.1', async () => {
    // `[::]` may or may not accept IPv4 depending on the proxy's socket
    // options, and `[::1]` never does. Neither is what the relay connects
    // to, so neither identifies the port — and the loopback address stays
    // unexplained, which is ambiguous, not none.
    for (const hostIp of ['[::]', '[::1]']) {
      const io = dockerIo([DOCKER_LINE('abc123', `${hostIp}:32780->5173/tcp`, 'preview-a', 'proj-a')])
      await expect(probeListenerEvidence(32780, io)).resolves.toMatchObject({ status: 'ambiguous' })
    }
  })

  it('fails closed when docker is installed but the query fails', async () => {
    // Falling back to the process probe here is exactly the Docker Desktop
    // trap: the host socket is held by one shared backend process, so every
    // container on the machine would present the same identity.
    const io = makeIo({
      exec: vi.fn(async (file: string) => (file === 'docker'
        ? { status: 'failed' as const, detail: 'daemon not running' }
        : { status: 'missing' as const })),
    })
    await expect(probeListenerEvidence(32780, io)).resolves.toMatchObject({ status: 'unavailable' })
  })

  it('falls back to the process probe when docker is not installed at all', async () => {
    const io = makeIo({
      platform: 'darwin',
      exec: vi.fn(async (file: string, args: string[]) => {
        if (file === 'docker') return { status: 'missing' as const }
        if (file === 'lsof' && args.join(' ').includes('-iTCP:3000')) {
          return { status: 'ok' as const, stdout: lsofListing([{ pid: '4242', type: 'IPv4', name: '127.0.0.1:3000' }]) }
        }
        if (file === 'ps') return { status: 'ok' as const, stdout: 'Wed Sep 10 10:00:00 2026\n' }
        if (file === 'lsof') return { status: 'ok' as const, stdout: 'p4242\nn/Users/dev/project-a\n' }
        return { status: 'missing' as const }
      }),
    })
    await expect(probeListenerEvidence(3000, io)).resolves.toEqual({
      status: 'found',
      evidence: {
        kind: 'process',
        id: '4242',
        startedAt: 'Wed Sep 10 10:00:00 2026',
        cwd: '/Users/dev/project-a',
      },
    })
  })

  it('fails closed when the listening process has no readable start time or cwd', async () => {
    const io = makeIo({
      platform: 'darwin',
      exec: vi.fn(async (file: string, args: string[]) => {
        if (file === 'lsof' && args.join(' ').includes('-iTCP:3000')) {
          return { status: 'ok' as const, stdout: lsofListing([{ pid: '4242', type: 'IPv4', name: '*:3000' }]) }
        }
        if (file === 'ps') return { status: 'ok' as const, stdout: '\n' }
        if (file === 'lsof') return { status: 'ok' as const, stdout: 'p4242\n' }
        return { status: 'missing' as const }
      }),
    })
    // An empty start time or cwd would make two different runtimes hash the
    // same; it is missing evidence, not evidence of sameness.
    await expect(probeListenerEvidence(3000, io)).resolves.toMatchObject({ status: 'unavailable' })
  })

  it('fails closed when neither /proc nor lsof can identify the listener', async () => {
    const io = makeIo({ platform: 'darwin' })
    await expect(probeListenerEvidence(3000, io)).resolves.toMatchObject({ status: 'unavailable' })
  })
})

describe('probeListenerEvidence — the listener must be the one 127.0.0.1 reaches', () => {
  /**
   * Measured on macOS: a Node `listen(port)` (dual-stack `::`) and a
   * `listen({host:'::', ipv6Only:true})` print the *same* `tIPv6 n*:port`
   * line, yet only the first accepts a 127.0.0.1 connection. The string
   * cannot tell them apart; only connecting can.
   */
  function lsofIo(
    listing: string | { status: 'failed'; detail: string; exitCode?: number; stderr?: string },
    overrides: Partial<EvidenceIo> = {},
  ): EvidenceIo {
    return makeIo({
      platform: 'darwin',
      exec: vi.fn(async (file: string, args: string[]) => {
        if (file === 'docker') return { status: 'missing' as const }
        if (file === 'lsof' && args.join(' ').includes('-iTCP:3000')) {
          return typeof listing === 'string' ? { status: 'ok' as const, stdout: listing } : listing
        }
        if (file === 'ps') return { status: 'ok' as const, stdout: `Wed Sep 10 10:00:00 2026\n` }
        if (file === 'lsof') {
          const pid = args[args.indexOf('-p') + 1]
          return { status: 'ok' as const, stdout: `p${pid}\nn/Users/dev/project-${pid}\n` }
        }
        return { status: 'missing' as const }
      }),
      ...overrides,
    })
  }

  it('takes a dual-stack wildcard listener only after 127.0.0.1 actually connected to it', async () => {
    const io = lsofIo(lsofListing([{ pid: '4242', type: 'IPv6', name: '*:3000' }]), {
      connectLoopback: vi.fn().mockResolvedValue({ status: 'connected' }),
    })
    await expect(probeListenerEvidence(3000, io)).resolves.toMatchObject({
      status: 'found',
      evidence: { kind: 'process', id: '4242' },
    })
    expect(io.connectLoopback).toHaveBeenCalledWith(3000, expect.any(Number))
  })

  it('answers none for an IPv6-only wildcard listener that refuses 127.0.0.1', async () => {
    const io = lsofIo(lsofListing([{ pid: '4242', type: 'IPv6', name: '*:3000' }]), {
      connectLoopback: vi.fn().mockResolvedValue({ status: 'refused' }),
    })
    await expect(probeListenerEvidence(3000, io)).resolves.toEqual({ status: 'none' })
  })

  it('fails closed when the reachability connect itself could not run', async () => {
    const io = lsofIo(lsofListing([{ pid: '4242', type: 'IPv6', name: '*:3000' }]), {
      connectLoopback: vi.fn().mockResolvedValue({ status: 'failed', detail: 'EPERM' }),
    })
    await expect(probeListenerEvidence(3000, io)).resolves.toMatchObject({ status: 'unavailable' })
  })

  it('never counts a ::1 listener — it cannot receive a 127.0.0.1 connection', async () => {
    const io = lsofIo(lsofListing([{ pid: '4242', type: 'IPv6', name: '[::1]:3000' }]))
    await expect(probeListenerEvidence(3000, io)).resolves.toEqual({ status: 'none' })
    expect(io.connectLoopback).not.toHaveBeenCalled()
  })

  it('ignores a LAN-address listener on the same port and picks the loopback one', async () => {
    // Two processes can legitimately share a port on different specific
    // addresses. Only the one on 127.0.0.1 is what the relay talks to, so
    // this is a clean answer, not an ambiguity.
    const io = lsofIo(lsofListing([
      { pid: '4242', type: 'IPv4', name: '127.0.0.1:3000' },
      { pid: '5555', type: 'IPv4', name: '172.16.9.1:3000' },
    ]))
    await expect(probeListenerEvidence(3000, io)).resolves.toMatchObject({
      status: 'found',
      evidence: { id: '4242', cwd: '/Users/dev/project-4242' },
    })
    expect(io.connectLoopback).not.toHaveBeenCalled()
  })

  it('answers none when only a LAN-address listener holds the port', async () => {
    const io = lsofIo(lsofListing([{ pid: '5555', type: 'IPv4', name: '172.16.9.1:3000' }]))
    await expect(probeListenerEvidence(3000, io)).resolves.toEqual({ status: 'none' })
  })

  it('does not connect-probe when an IPv4 listener already proves the destination', async () => {
    const io = lsofIo(lsofListing([{ pid: '4242', type: 'IPv4', name: '*:3000' }]))
    await expect(probeListenerEvidence(3000, io)).resolves.toMatchObject({ status: 'found', evidence: { id: '4242' } })
    expect(io.connectLoopback).not.toHaveBeenCalled()
  })

  it('is ambiguous when a second process holds a wildcard IPv6 listener beside the IPv4 one', async () => {
    // With SO_REUSEPORT both could be accepting 127.0.0.1; nothing here can
    // say which one the relay will land on.
    const io = lsofIo(lsofListing([
      { pid: '4242', type: 'IPv4', name: '127.0.0.1:3000' },
      { pid: '5555', type: 'IPv6', name: '*:3000' },
    ]))
    await expect(probeListenerEvidence(3000, io)).resolves.toMatchObject({ status: 'ambiguous' })
  })

  it('treats one process holding both an IPv4 and an IPv6 wildcard socket as one listener', async () => {
    const io = lsofIo(lsofListing([
      { pid: '4242', type: 'IPv4', name: '*:3000' },
      { pid: '4242', type: 'IPv6', name: '*:3000' },
    ]))
    await expect(probeListenerEvidence(3000, io)).resolves.toMatchObject({ status: 'found', evidence: { id: '4242' } })
  })

  it('reads lsof\'s exit status 1 with no output as "nothing is listening"', async () => {
    const io = lsofIo({ status: 'failed', detail: '', exitCode: 1, stderr: '' })
    await expect(probeListenerEvidence(3000, io)).resolves.toEqual({ status: 'none' })
  })

  it('still fails closed when lsof exits 1 with a complaint', async () => {
    const io = lsofIo({ status: 'failed', detail: 'lsof: permission denied', exitCode: 1, stderr: 'lsof: permission denied' })
    await expect(probeListenerEvidence(3000, io)).resolves.toMatchObject({ status: 'unavailable' })
  })
})

describe('probeListenerEvidence — linux /proc', () => {
  // 0100007F:0BB8 = 127.0.0.1:3000, state 0A = LISTEN, inode 987654.
  const PROC_NET_TCP = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000  00000000  1000        0 987654 1 0000 100 0 0 10 0',
    '   1: 0100007F:1F90 00000000:0000 01 00000000:00000000 00:00000000  00000000  1000        0 111111 1 0000 100 0 0 10 0',
  ].join('\n')

  function procIo(overrides: Partial<EvidenceIo> = {}): EvidenceIo {
    return makeIo({
      platform: 'linux',
      readFile: vi.fn(async (p: string) => {
        if (p === '/proc/net/tcp') return PROC_NET_TCP
        if (p === '/proc/net/tcp6') return ''
        if (p === '/proc/4242/stat') {
          const beforeStarttime = ['S', '1', '4242', '4242', '0', '-1', '4194304']
            .concat(Array.from({ length: 12 }, () => '0'))
            .join(' ')
          return `4242 (node (dev)) ${beforeStarttime} 55512345 0 0 0`
        }
        return null
      }),
      readDir: vi.fn(async (p: string) => {
        if (p === '/proc') return ['1', '4242', 'net', 'self']
        if (p === '/proc/4242/fd') return ['0', '1', '2', '17']
        if (p === '/proc/1/fd') return ['0']
        return null
      }),
      readLink: vi.fn(async (p: string) => {
        if (p === '/proc/4242/fd/17') return 'socket:[987654]'
        if (p === '/proc/4242/fd/0') return '/dev/null'
        if (p === '/proc/1/fd/0') return '/dev/null'
        if (p === '/proc/4242/cwd') return '/home/dev/project-a'
        return null
      }),
      ...overrides,
    })
  }

  it('finds the listening pid through the socket inode and reports start time and cwd', async () => {
    await expect(probeListenerEvidence(3000, procIo())).resolves.toEqual({
      status: 'found',
      evidence: {
        kind: 'process',
        id: '4242',
        startedAt: '55512345',
        cwd: '/home/dev/project-a',
      },
    })
  })

  it('ignores sockets that are not in LISTEN state', async () => {
    await expect(probeListenerEvidence(8080, procIo())).resolves.toEqual({ status: 'none' })
  })

  it('returns none when nothing is listening on the port', async () => {
    await expect(probeListenerEvidence(9999, procIo())).resolves.toEqual({ status: 'none' })
  })

  it('is ambiguous — not none — when the listener exists but its fds are unreadable', async () => {
    // Another user's process holds the port: /proc/net/tcp still shows the
    // LISTEN row, but we cannot read its fds. "I could not look" must never
    // read as "nobody is there".
    const io = procIo({
      readDir: vi.fn(async (p: string) => {
        if (p === '/proc') return ['1', '4242']
        return null
      }),
    })
    await expect(probeListenerEvidence(3000, io)).resolves.toMatchObject({ status: 'ambiguous' })
  })

  it('is ambiguous when two processes hold the port', async () => {
    const io = procIo({
      readDir: vi.fn(async (p: string) => {
        if (p === '/proc') return ['1', '4242', '5555']
        if (p === '/proc/4242/fd') return ['17']
        if (p === '/proc/5555/fd') return ['17']
        return null
      }),
      readLink: vi.fn(async (p: string) => {
        if (p === '/proc/4242/fd/17') return 'socket:[987654]'
        if (p === '/proc/5555/fd/17') return 'socket:[987654]'
        return null
      }),
    })
    await expect(probeListenerEvidence(3000, io)).resolves.toMatchObject({ status: 'ambiguous' })
  })

  it('fails closed when only part of the /proc listener tables could be read', async () => {
    // `/proc/net/tcp` was readable and empty, but `/proc/net/tcp6` was not.
    // A v6-bound dev server would live in exactly the file we could not read,
    // so "no row here" is not "nothing is listening".
    const io = procIo({
      readFile: vi.fn(async (p: string) => (p === '/proc/net/tcp' ? 'header only\n' : null)),
    })
    await expect(probeListenerEvidence(3000, io)).resolves.toMatchObject({ status: 'unavailable' })
  })

  it('fails closed when neither /proc listener table could be read', async () => {
    const io = procIo({ readFile: vi.fn(async () => null) })
    await expect(probeListenerEvidence(3000, io)).resolves.toMatchObject({ status: 'unavailable' })
  })

  it('still answers none when both tables were readable and held no LISTEN row', async () => {
    const io = procIo({
      readFile: vi.fn(async (p: string) => (p.startsWith('/proc/net/tcp') ? 'header only\n' : null)),
    })
    await expect(probeListenerEvidence(3000, io)).resolves.toEqual({ status: 'none' })
  })

  // Same port, different addresses. /proc prints IPv4 as little-endian hex
  // (0100007F = 127.0.0.1, 0109A8C0 = 192.168.9.1) and IPv6 as four such
  // words (all zero = ::, ...01000000 = ::1).
  const LAN_ROW = '   2: 0109A8C0:0BB8 00000000:0000 0A 00000000:00000000 00:00000000  00000000  1000        0 555555 1 0000 100 0 0 10 0'
  const V6_ANY_ROW = '   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000  00000000  1000        0 666666 1 0000 100 0 0 10 0'
  const V6_LOOPBACK_ROW = '   0: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000  00000000  1000        0 777777 1 0000 100 0 0 10 0'

  function procTablesIo(tcp: string[], tcp6: string[], overrides: Partial<EvidenceIo> = {}): EvidenceIo {
    const base = procIo()
    return procIo({
      readFile: vi.fn(async (p: string) => {
        if (p === '/proc/net/tcp') return ['header', ...tcp].join('\n')
        if (p === '/proc/net/tcp6') return ['header', ...tcp6].join('\n')
        return base.readFile(p)
      }),
      readDir: vi.fn(async (p: string) => {
        if (p === '/proc') return ['1', '4242', '5555']
        if (p === '/proc/4242/fd') return ['17']
        if (p === '/proc/5555/fd') return ['17']
        return null
      }),
      readLink: vi.fn(async (p: string) => {
        if (p === '/proc/4242/fd/17') return 'socket:[987654]'
        if (p === '/proc/5555/fd/17') return 'socket:[555555]'
        if (p === '/proc/4242/cwd') return '/home/dev/project-a'
        if (p === '/proc/5555/cwd') return '/home/dev/project-b'
        return null
      }),
      ...overrides,
    })
  }

  it('picks the 127.0.0.1 listener over a LAN-address listener on the same port', async () => {
    const io = procTablesIo([PROC_NET_TCP.split('\n')[1], LAN_ROW], [])
    await expect(probeListenerEvidence(3000, io)).resolves.toMatchObject({
      status: 'found',
      evidence: { id: '4242', cwd: '/home/dev/project-a' },
    })
  })

  it('answers none when only a LAN-address listener holds the port', async () => {
    const io = procTablesIo([LAN_ROW], [])
    await expect(probeListenerEvidence(3000, io)).resolves.toEqual({ status: 'none' })
  })

  it('never counts a ::1 listener as reachable from 127.0.0.1', async () => {
    const io = procTablesIo([], [V6_LOOPBACK_ROW])
    await expect(probeListenerEvidence(3000, io)).resolves.toEqual({ status: 'none' })
    expect(io.connectLoopback).not.toHaveBeenCalled()
  })

  it('takes a :: listener only once 127.0.0.1 has actually connected to it', async () => {
    const io = procTablesIo([], [V6_ANY_ROW], {
      readLink: vi.fn(async (p: string) => {
        if (p === '/proc/4242/fd/17') return 'socket:[666666]'
        if (p === '/proc/4242/cwd') return '/home/dev/project-a'
        return null
      }),
      connectLoopback: vi.fn().mockResolvedValue({ status: 'connected' }),
    })
    await expect(probeListenerEvidence(3000, io)).resolves.toMatchObject({ status: 'found', evidence: { id: '4242' } })
  })

  it('answers none for a :: listener that turns out to be IPv6-only', async () => {
    const io = procTablesIo([], [V6_ANY_ROW], {
      readLink: vi.fn(async (p: string) => (p === '/proc/4242/fd/17' ? 'socket:[666666]' : null)),
      connectLoopback: vi.fn().mockResolvedValue({ status: 'refused' }),
    })
    await expect(probeListenerEvidence(3000, io)).resolves.toEqual({ status: 'none' })
  })

  it('fails closed when the identified process has no readable cwd', async () => {
    const io = procIo({
      readLink: vi.fn(async (p: string) => {
        if (p === '/proc/4242/fd/17') return 'socket:[987654]'
        return null
      }),
    })
    await expect(probeListenerEvidence(3000, io)).resolves.toMatchObject({ status: 'unavailable' })
  })
})

describe('fingerprintEvidence', () => {
  const base = { kind: 'process' as const, id: '4242', startedAt: '55512345', cwd: '/home/dev/a' }

  it('is a full sha256 digest, not a truncated prefix', () => {
    expect(fingerprintEvidence(base)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is stable for the same runtime', () => {
    expect(fingerprintEvidence(base)).toBe(fingerprintEvidence({ ...base }))
  })

  it('changes when the process restarts (same pid, new start time)', () => {
    expect(fingerprintEvidence({ ...base, startedAt: '55599999' })).not.toBe(fingerprintEvidence(base))
  })

  it('changes when another project takes the port over', () => {
    expect(fingerprintEvidence({ ...base, id: '5555', cwd: '/home/dev/b' })).not.toBe(fingerprintEvidence(base))
  })

  it('separates a container from a process and tracks its project label', () => {
    const container = { kind: 'container' as const, id: 'c1', startedAt: 'now', name: 'p', projectLabel: 'proj-a' }
    expect(fingerprintEvidence(container)).not.toBe(fingerprintEvidence(base))
    expect(fingerprintEvidence({ ...container, projectLabel: 'proj-b' }))
      .not.toBe(fingerprintEvidence(container))
  })
})
