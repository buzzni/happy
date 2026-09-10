/**
 * specs/runtime-isolation-hardening (H3) — evidence about what is *actually*
 * listening on a preview port right now.
 *
 * The relay has never had this. A signed preview token names a port, and the
 * daemon connects to `127.0.0.1:{port}` whatever happens to be there — so a
 * token minted for project A keeps working after the port is handed to
 * project B, or after A's server is replaced by something else entirely. The
 * port registry cannot answer it either: those rows are what the studio
 * *asked for*, not what is running.
 *
 * Two probes, in order:
 *
 * 1. **Container publish.** When a container publishes the host port, the
 *    container id, run start time and `aplus.projectId` label are the runtime
 *    identity. The start time is `State.StartedAt`, never `CreatedAt`:
 *    `CreatedAt` is the image instantiation time and survives `docker
 *    restart` unchanged, so a token minted before a restart would still
 *    verify against the process that replaced it. This must come first, and a
 *    docker query that *fails* must not fall through: with Docker Desktop the
 *    process holding the host socket is a single shared backend, identical
 *    for every container on the machine, so falling back would give every
 *    project the same identity.
 * 2. **Listening process.** pid + start time + cwd. Start time is what makes a
 *    restart visible (pids are reused), and cwd is what later proves the
 *    process belongs to the project's workspace.
 *
 * Every "I could not look" answer is `unavailable` or `ambiguous`, never
 * `none`: a missing start time, an unreadable cwd, an unidentifiable listener
 * and a failed docker query are all missing evidence, and treating any of them
 * as absence would hand out a lease over a runtime nobody verified.
 *
 * **The listener must be the one the relay reaches.** Both proxies connect to
 * exactly `127.0.0.1:{port}` (previewProxy.ts, previewWsProxy.ts), so the only
 * evidence that counts is a socket that can accept that connection:
 *
 * - IPv4 `0.0.0.0` or `127.0.0.1` — accepts it by definition.
 * - IPv6 `::` — accepts it only when the socket is dual-stack, and nothing in
 *   `/proc/net/tcp6` or `lsof` says whether it is (measured: a Node
 *   `listen(port)` and a `listen({host:'::', ipv6Only:true})` print the same
 *   line). So a lone `::` listener is taken only after an actual connect to
 *   127.0.0.1 succeeded; a refusal means nothing reaches the destination.
 * - IPv6 `::1`, and any specific LAN address — never. A dev server bound to
 *   `192.168.x.x:port` beside another on `127.0.0.1:port` is not an
 *   ambiguity: only the loopback one is what the relay talks to.
 *
 * There is no fallback to another destination: if 127.0.0.1 cannot be proven,
 * the answer is `none`/`ambiguous`/`unavailable`, never "try ::1 instead".
 */

import crypto from 'node:crypto'
import net from 'node:net'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'

export type ListenerEvidence =
  | {
    kind: 'container'
    /** Container id. */
    id: string
    /** `State.StartedAt` — the current run, not the container's creation. */
    startedAt: string
    name: string
    /** `aplus.projectId` label, or null when the container carries none. */
    projectLabel: string | null
  }
  | {
    kind: 'process'
    /** pid. */
    id: string
    /** Process start time (`/proc/<pid>/stat` field 22, or `ps -o lstart=`). */
    startedAt: string
    cwd: string
  }

export type EvidenceProbeResult =
  | { status: 'found'; evidence: ListenerEvidence }
  | { status: 'none' }
  | { status: 'ambiguous'; detail: string }
  | { status: 'unavailable'; detail: string }
  /** Not looked at all: the probe gate refused (see `createBoundedProbe`). */
  | { status: 'busy'; detail: string }

export type ExecResult =
  | { status: 'ok'; stdout: string }
  /** The binary is not installed — a definite answer, not a failure. */
  | { status: 'missing' }
  | { status: 'failed'; detail: string; exitCode?: number; stderr?: string }

/** Outcome of one TCP connect to `127.0.0.1:{port}` — the relay's destination. */
export type ConnectResult =
  | { status: 'connected' }
  /** The kernel answered RST: nothing accepts on that address. */
  | { status: 'refused' }
  | { status: 'failed'; detail: string }

export interface EvidenceIo {
  platform: string
  exec(file: string, args: string[], timeoutMs: number): Promise<ExecResult>
  readFile(path: string): Promise<string | null>
  readDir(path: string): Promise<string[] | null>
  readLink(path: string): Promise<string | null>
  /**
   * Reachability proof for a listener whose address family alone cannot
   * prove it (see module doc). Always 127.0.0.1 — the destination is not a
   * parameter, because the relay's is not either.
   */
  connectLoopback(port: number, timeoutMs: number): Promise<ConnectResult>
}

const EXEC_TIMEOUT_MS = 5_000
const CONNECT_TIMEOUT_MS = 2_000

/** The one address both preview proxies connect to. */
export const RELAY_DESTINATION_HOST = '127.0.0.1'

export function createEvidenceIo(): EvidenceIo {
  return {
    platform: process.platform,
    exec: (file, args, timeoutMs) => new Promise<ExecResult>((resolve) => {
      execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err) {
          resolve({ status: 'ok', stdout })
          return
        }
        const code = (err as NodeJS.ErrnoException).code
        // ENOENT from execFile means the binary itself is absent; anything
        // else means it ran and failed, which is not the same answer. A
        // numeric code is the process's own exit status (lsof uses 1 for
        // "nothing matched"), kept apart from the free-text detail.
        resolve(code === 'ENOENT'
          ? { status: 'missing' }
          : {
            status: 'failed',
            detail: (stderr || err.message).slice(0, 200),
            ...(typeof code === 'number' ? { exitCode: code } : {}),
            stderr: (stderr ?? '').slice(0, 200),
          })
      })
    }),
    readFile: async (p) => fs.readFile(p, 'utf-8').catch(() => null),
    readDir: async (p) => fs.readdir(p).catch(() => null),
    readLink: async (p) => fs.readlink(p).catch(() => null),
    connectLoopback: (port, timeoutMs) => new Promise<ConnectResult>((resolve) => {
      const socket = net.connect({ host: RELAY_DESTINATION_HOST, port })
      const finish = (result: ConnectResult) => {
        socket.removeAllListeners()
        socket.destroy()
        resolve(result)
      }
      socket.setTimeout(timeoutMs, () => finish({ status: 'failed', detail: `connect to ${RELAY_DESTINATION_HOST}:${port} timed out` }))
      socket.once('connect', () => finish({ status: 'connected' }))
      socket.once('error', (err: NodeJS.ErrnoException) => finish(
        err.code === 'ECONNREFUSED'
          ? { status: 'refused' }
          : { status: 'failed', detail: `${err.code ?? 'error'}: ${err.message}`.slice(0, 200) },
      ))
    }),
  }
}

export type ProbeFn = (port: number) => Promise<EvidenceProbeResult>

export interface ProbeLimits {
  /** Probes allowed to run at once. Each one is one or two subprocess spawns. */
  maxConcurrent: number
  /** Requests allowed to wait for a slot; the next one is refused outright. */
  maxQueued: number
  /** Longest a request may wait for a slot before it is refused. */
  maxWaitMs: number
}

/**
 * Measured on this project's macOS dev host (OrbStack docker, 12 containers):
 *
 * - container path (`docker ps` + `docker inspect`): 73–120 ms sequential;
 *   throughput saturates at 4 concurrent (~55 ms effective per probe) and
 *   per-slot latency then grows linearly (417 ms at 8, 862 ms at 16).
 * - native path (`docker ps` miss + `lsof -iTCP` + `ps` + `lsof -p`): ~280 ms
 *   sequential, ~150 ms effective at any concurrency from 2 to 16.
 * - unbounded, a 200-request Vite module burst spawned 400 docker CLIs at
 *   once and took 3.9 s in one run and 13 s in another.
 *
 * Eight slots is past the saturation point on both paths, so it costs no
 * throughput and keeps a burst from becoming hundreds of simultaneous
 * spawns. The wait bound is set from that throughput: 256 queued requests at
 * ~55–150 ms each drain in 14–38 s, and happy-server's relay RPC timeout is
 * 35 s — a request that cannot be served inside that is refused explicitly
 * rather than answered late. Note that this bounds *how many* probes run, not
 * *how much* a burst costs: 200 relayed sub-resources are still 200 probes.
 */
export const DEFAULT_PROBE_LIMITS: ProbeLimits = { maxConcurrent: 8, maxQueued: 256, maxWaitMs: 20_000 }

/**
 * Bound how many probes run at once — nothing more.
 *
 * This is a concurrency limiter, not a cache and not single-flight: every
 * request that gets a slot runs its own probe against the live system, so a
 * request queued behind a slow one still sees the listener as it is when its
 * own probe runs. Reusing an in-flight answer would hand the second request a
 * view from before it arrived, and that is the revocation window the whole
 * per-request design exists to close. When the bound cannot be honoured the
 * request is refused explicitly (`busy`) rather than waited for without limit
 * or answered from someone else's probe.
 */
export function createBoundedProbe(probe: ProbeFn, limits: ProbeLimits): ProbeFn {
  let running = 0
  const queue: Array<{ port: number; resolve: (r: EvidenceProbeResult) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }> = []

  const run = (port: number, resolve: (r: EvidenceProbeResult) => void, reject: (e: unknown) => void) => {
    running += 1
    probe(port).then(resolve, reject).finally(() => {
      running -= 1
      const next = queue.shift()
      if (next) {
        clearTimeout(next.timer)
        run(next.port, next.resolve, next.reject)
      }
    })
  }

  return (port) => new Promise<EvidenceProbeResult>((resolve, reject) => {
    if (running < limits.maxConcurrent) {
      run(port, resolve, reject)
      return
    }
    if (queue.length >= limits.maxQueued) {
      resolve({ status: 'busy', detail: `preview runtime probe queue is full (${queue.length} waiting, ${running} running)` })
      return
    }
    const entry = {
      port,
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = queue.indexOf(entry)
        if (index === -1) return
        queue.splice(index, 1)
        resolve({ status: 'busy', detail: `preview runtime probe waited longer than ${limits.maxWaitMs}ms for a slot` })
      }, limits.maxWaitMs),
    }
    entry.timer.unref?.()
    queue.push(entry)
  })
}

export function fingerprintEvidence(evidence: ListenerEvidence): string {
  const parts = evidence.kind === 'container'
    ? ['container', evidence.id, evidence.startedAt, evidence.name, evidence.projectLabel ?? '']
    : ['process', evidence.id, evidence.startedAt, evidence.cwd]
  // NUL separator: no field can contain one, so no two different runtimes can
  // be run together into the same digest input.
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex')
}

export async function probeListenerEvidence(port: number, io: EvidenceIo): Promise<EvidenceProbeResult> {
  const container = await probeContainerPublish(port, io)
  if (container.status !== 'none') return container
  return probeListeningProcess(port, io)
}

/**
 * A publish address the daemon's own `127.0.0.1:{port}` connection provably
 * lands on. `[::]` is deliberately absent: whether docker's proxy socket on it
 * takes IPv4 depends on its options, and the usual publish prints an IPv4
 * half beside it anyway. `[::1]` and specific LAN addresses never reach.
 * Anything not in this set can neither identify the port nor rule it out;
 * see `hostPortMatch`.
 */
const IPV4_REACHABLE_PUBLISH_ADDRESSES = new Set(['0.0.0.0', '127.0.0.1'])

export type HostPortMatch = 'loopback' | 'unreachable-address' | 'no-match'

/**
 * Host-port mappings look like
 * `0.0.0.0:32780->5173/tcp, [::]:32780->5173/tcp`, and unpublished ports
 * appear bare as `5173/tcp`.
 */
export function hostPortMatch(ports: string, port: number): HostPortMatch {
  let unreachable = false
  for (const mapping of ports.split(',')) {
    const match = mapping.trim().match(/^(.*):(\d+)->/)
    if (!match) continue
    if (Number.parseInt(match[2], 10) !== port) continue
    if (IPV4_REACHABLE_PUBLISH_ADDRESSES.has(match[1].trim())) return 'loopback'
    unreachable = true
  }
  return unreachable ? 'unreachable-address' : 'no-match'
}

async function probeContainerPublish(port: number, io: EvidenceIo): Promise<EvidenceProbeResult> {
  const result = await io.exec(
    'docker',
    ['ps', '--no-trunc', '--format', '{{.ID}}\t{{.Ports}}\t{{.Names}}\t{{.Label "aplus.projectId"}}'],
    EXEC_TIMEOUT_MS,
  )
  if (result.status === 'missing') return { status: 'none' }
  if (result.status === 'failed') {
    return { status: 'unavailable', detail: `docker ps failed: ${result.detail}` }
  }

  const matches: { id: string; name: string; projectLabel: string | null }[] = []
  let unreachableAddress = false
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue
    const [id, ports, name, projectLabel] = line.split('\t')
    if (!id || !ports) continue
    const match = hostPortMatch(ports, port)
    if (match === 'no-match') continue
    if (match === 'unreachable-address') {
      unreachableAddress = true
      continue
    }
    matches.push({
      id,
      name: (name ?? '').trim(),
      projectLabel: (projectLabel ?? '').trim() || null,
    })
  }

  if (matches.length > 1) {
    return { status: 'ambiguous', detail: `${matches.length} containers publish host port ${port}` }
  }
  if (matches.length === 0) {
    // A container publishing this port on an address we cannot reach leaves
    // the loopback address unexplained: something else may hold it, and this
    // container may be it through a route we did not model.
    return unreachableAddress
      ? {
        status: 'ambiguous',
        detail: `a container publishes port ${port} on a host address the relay does not reach over loopback`,
      }
      : { status: 'none' }
  }

  const candidate = matches[0]
  const startedAt = await readContainerStartedAt(candidate.id, io)
  if (!startedAt) {
    return { status: 'unavailable', detail: `container ${candidate.id} reported no start time` }
  }
  return { status: 'found', evidence: { kind: 'container', ...candidate, startedAt } }
}

/** Go's zero time — what a container that has never run reports. */
const DOCKER_NEVER_STARTED = '0001-01-01T00:00:00Z'

/**
 * `State.StartedAt` identifies the *run*. `docker ps` cannot report it (it
 * only offers `CreatedAt`), so this is a second call for the one container
 * that matched.
 */
async function readContainerStartedAt(id: string, io: EvidenceIo): Promise<string | null> {
  const inspected = await io.exec(
    'docker',
    ['inspect', '--format', '{{.State.StartedAt}}', id],
    EXEC_TIMEOUT_MS,
  )
  if (inspected.status !== 'ok') return null
  const startedAt = inspected.stdout.trim()
  if (!startedAt || startedAt === DOCKER_NEVER_STARTED || startedAt === '<no value>') return null
  return startedAt
}

async function probeListeningProcess(port: number, io: EvidenceIo): Promise<EvidenceProbeResult> {
  if (io.platform === 'linux') return probeViaProc(port, io)
  return probeViaLsof(port, io)
}

/**
 * How a LISTEN socket relates to the relay's destination.
 * - `v4`: bound to 0.0.0.0 or 127.0.0.1 — accepts 127.0.0.1 by definition.
 * - `v6-any`: bound to `::` — accepts 127.0.0.1 only if dual-stack, which
 *   has to be proven by connecting.
 * Everything else (::1, LAN addresses) is not a candidate at all.
 */
type DestinationClass = 'v4' | 'v6-any'

interface DestinationOwners {
  /** Processes holding a `v4` socket on the port. */
  v4: Set<string>
  /** Processes holding a `v6-any` socket on the port. */
  v6Any: Set<string>
  /** A candidate socket exists whose owning process could not be read. */
  unowned: boolean
}

/**
 * Decide which single process is the one `127.0.0.1:{port}` reaches, or why
 * that cannot be said. Shared by the /proc and lsof probes so both platforms
 * apply one rule.
 */
async function pickDestinationOwner(
  owners: DestinationOwners,
  port: number,
  io: EvidenceIo,
): Promise<{ status: 'found'; pid: string } | Exclude<EvidenceProbeResult, { status: 'found' }>> {
  if (owners.unowned) {
    // The socket exists — another user's process holds it, or its fds are
    // not readable. Reporting "none" here would say nobody is listening on
    // a port that is very much in use.
    return { status: 'ambiguous', detail: `port ${port} is in LISTEN but no readable process owns the socket` }
  }
  if (owners.v4.size > 1) {
    return { status: 'ambiguous', detail: `${owners.v4.size} processes listen on ${RELAY_DESTINATION_HOST}:${port}` }
  }
  if (owners.v4.size === 1) {
    const [pid] = owners.v4
    const others = [...owners.v6Any].filter((other) => other !== pid)
    if (others.length > 0) {
      // With SO_REUSEPORT both an IPv4 and a dual-stack `::` socket can be
      // accepting 127.0.0.1; nothing here can say which one a connection
      // lands on.
      return {
        status: 'ambiguous',
        detail: `port ${port} has an IPv4 listener and another process's wildcard IPv6 listener; cannot tell which accepts ${RELAY_DESTINATION_HOST}`,
      }
    }
    return { status: 'found', pid }
  }
  if (owners.v6Any.size === 0) return { status: 'none' }
  if (owners.v6Any.size > 1) {
    return { status: 'ambiguous', detail: `${owners.v6Any.size} processes hold a wildcard IPv6 listener on port ${port}` }
  }
  // A lone `::` listener. Dual-stack or v6-only is invisible in the tables;
  // the only proof is the destination itself answering.
  const reach = await io.connectLoopback(port, CONNECT_TIMEOUT_MS)
  if (reach.status === 'connected') {
    const [pid] = owners.v6Any
    return { status: 'found', pid }
  }
  if (reach.status === 'refused') return { status: 'none' }
  return { status: 'unavailable', detail: `could not prove ${RELAY_DESTINATION_HOST}:${port} reaches the IPv6 listener: ${reach.detail}` }
}

/** IPv4 in /proc is one little-endian 32-bit word; 0100007F is 127.0.0.1. */
const PROC_V4_REACHABLE = new Set(['00000000', '0100007F'])
const PROC_V6_ANY = '00000000000000000000000000000000'

/**
 * `/proc/net/tcp{,6}` LISTEN rows for the port: `st` is `0A`, the inode is
 * column 9. Returns each candidate inode with its destination class; rows on
 * addresses that cannot receive 127.0.0.1 are dropped here.
 */
export function listenSocketsForPort(
  content: string,
  port: number,
  table: 'tcp' | 'tcp6',
): Map<string, DestinationClass> {
  const sockets = new Map<string, DestinationClass>()
  const wanted = port.toString(16).toUpperCase().padStart(4, '0')
  for (const line of content.split('\n').slice(1)) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 10) continue
    const local = columns[1]
    const state = columns[3]
    if (state !== '0A') continue
    const [address, localPort] = local?.split(':') ?? []
    if (!address || localPort?.toUpperCase() !== wanted) continue
    const upper = address.toUpperCase()
    if (table === 'tcp' && PROC_V4_REACHABLE.has(upper)) sockets.set(columns[9], 'v4')
    else if (table === 'tcp6' && upper === PROC_V6_ANY) sockets.set(columns[9], 'v6-any')
  }
  return sockets
}

async function probeViaProc(port: number, io: EvidenceIo): Promise<EvidenceProbeResult> {
  const sockets = new Map<string, DestinationClass>()
  const unread: string[] = []
  for (const table of ['tcp', 'tcp6'] as const) {
    const content = await io.readFile(`/proc/net/${table}`)
    // `null` is a failed read; an empty string is a readable, empty table.
    if (content === null) {
      unread.push(`/proc/net/${table}`)
      continue
    }
    for (const [inode, klass] of listenSocketsForPort(content, port, table)) sockets.set(inode, klass)
  }
  if (sockets.size === 0) {
    // "No LISTEN row" is only an answer when every table was readable — a
    // dual-stack dev server lives in exactly the file we may have missed.
    return unread.length === 0
      ? { status: 'none' }
      : { status: 'unavailable', detail: `could not read ${unread.join(', ')}` }
  }

  const pids = await io.readDir('/proc')
  if (!pids) {
    return { status: 'ambiguous', detail: `port ${port} is in LISTEN but /proc could not be read` }
  }

  const ownersByInode = new Map<string, Set<string>>()
  const wanted = new Map([...sockets.keys()].map((inode) => [`socket:[${inode}]`, inode]))
  for (const entry of pids) {
    if (!/^\d+$/.test(entry)) continue
    const fds = await io.readDir(`/proc/${entry}/fd`)
    if (!fds) continue
    for (const fd of fds) {
      const target = await io.readLink(`/proc/${entry}/fd/${fd}`)
      const inode = target ? wanted.get(target) : undefined
      if (inode) ownersByInode.set(inode, new Set([...(ownersByInode.get(inode) ?? []), entry]))
    }
  }

  const owners: DestinationOwners = { v4: new Set(), v6Any: new Set(), unowned: false }
  for (const [inode, klass] of sockets) {
    const holders = ownersByInode.get(inode)
    if (!holders) {
      owners.unowned = true
      continue
    }
    // One socket shared by several processes (a pre-fork server) has no
    // single runtime identity; every holder counts, and the picker reports
    // more than one as ambiguous.
    for (const pid of holders) (klass === 'v4' ? owners.v4 : owners.v6Any).add(pid)
  }

  const picked = await pickDestinationOwner(owners, port, io)
  if (picked.status !== 'found') return picked

  const startedAt = await readProcStartTime(picked.pid, io)
  const cwd = await io.readLink(`/proc/${picked.pid}/cwd`)
  if (!startedAt || !cwd) {
    return {
      status: 'unavailable',
      detail: `pid ${picked.pid} holds port ${port} but its start time or cwd is unreadable`,
    }
  }
  return { status: 'found', evidence: { kind: 'process', id: picked.pid, startedAt, cwd } }
}

/**
 * `/proc/<pid>/stat` field 22. The command name (field 2) is parenthesised and
 * may contain spaces and parens of its own, so the split starts after the
 * final `)`.
 */
async function readProcStartTime(pid: string, io: EvidenceIo): Promise<string | null> {
  const stat = await io.readFile(`/proc/${pid}/stat`)
  if (!stat) return null
  const tail = stat.slice(stat.lastIndexOf(')') + 1).trim()
  const fields = tail.split(/\s+/)
  return fields[19] ?? null
}

function firstFieldValue(stdout: string, prefix: string): string | null {
  for (const line of stdout.split('\n')) {
    if (line.startsWith(prefix)) {
      const value = line.slice(prefix.length).trim()
      if (value) return value
    }
  }
  return null
}

/** lsof prints `*` for the wildcard address of either family. */
const LSOF_V4_REACHABLE = new Set(['*', '0.0.0.0', '127.0.0.1'])

/**
 * `lsof -Fpnt` output: one `p<pid>` line, then `f`/`t`/`n` per socket fd.
 * `t` is `IPv4`/`IPv6`, `n` is `<address>:<port>`. Classify each socket the
 * same way the /proc probe does.
 */
export function listenOwnersFromLsof(stdout: string, port: number): DestinationOwners {
  const owners: DestinationOwners = { v4: new Set(), v6Any: new Set(), unowned: false }
  let pid: string | null = null
  let type: string | null = null
  for (const line of stdout.split('\n')) {
    const key = line[0]
    const value = line.slice(1).trim()
    if (key === 'p') {
      pid = value || null
      type = null
    } else if (key === 't') {
      type = value
    } else if (key === 'n' && pid) {
      const separator = value.lastIndexOf(':')
      if (separator === -1 || value.slice(separator + 1) !== String(port)) continue
      const address = value.slice(0, separator)
      if (type === 'IPv4' && LSOF_V4_REACHABLE.has(address)) owners.v4.add(pid)
      else if (type === 'IPv6' && (address === '*' || address === '[::]')) owners.v6Any.add(pid)
    }
  }
  return owners
}

async function probeViaLsof(port: number, io: EvidenceIo): Promise<EvidenceProbeResult> {
  const listing = await io.exec('lsof', ['-nP', '-w', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpnt'], EXEC_TIMEOUT_MS)
  if (listing.status === 'failed' && listing.exitCode === 1 && !(listing.stderr ?? '').trim()) {
    // lsof's exit status for "no file matched": a readable answer of none.
    return { status: 'none' }
  }
  if (listing.status !== 'ok') {
    return {
      status: 'unavailable',
      detail: `no usable listener probe on this platform (lsof ${listing.status}${listing.status === 'failed' ? `: ${listing.detail}` : ''})`,
    }
  }

  const picked = await pickDestinationOwner(listenOwnersFromLsof(listing.stdout, port), port, io)
  if (picked.status !== 'found') return picked

  const pid = picked.pid
  const started = await io.exec('ps', ['-o', 'lstart=', '-p', pid], EXEC_TIMEOUT_MS)
  const cwd = await io.exec('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], EXEC_TIMEOUT_MS)
  const startedAt = started.status === 'ok' ? started.stdout.trim() : ''
  const cwdPath = cwd.status === 'ok' ? firstFieldValue(cwd.stdout, 'n') : null
  if (!startedAt || !cwdPath) {
    return {
      status: 'unavailable',
      detail: `pid ${pid} holds port ${port} but its start time or cwd is unreadable`,
    }
  }
  return { status: 'found', evidence: { kind: 'process', id: pid, startedAt, cwd: cwdPath } }
}
