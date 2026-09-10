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
 */

import crypto from 'node:crypto'
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

export type ExecResult =
  | { status: 'ok'; stdout: string }
  /** The binary is not installed — a definite answer, not a failure. */
  | { status: 'missing' }
  | { status: 'failed'; detail: string }

export interface EvidenceIo {
  platform: string
  exec(file: string, args: string[], timeoutMs: number): Promise<ExecResult>
  readFile(path: string): Promise<string | null>
  readDir(path: string): Promise<string[] | null>
  readLink(path: string): Promise<string | null>
}

const EXEC_TIMEOUT_MS = 5_000

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
        // else means it ran and failed, which is not the same answer.
        resolve(code === 'ENOENT'
          ? { status: 'missing' }
          : { status: 'failed', detail: (stderr || err.message).slice(0, 200) })
      })
    }),
    readFile: async (p) => fs.readFile(p, 'utf-8').catch(() => null),
    readDir: async (p) => fs.readdir(p).catch(() => null),
    readLink: async (p) => fs.readlink(p).catch(() => null),
  }
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
 * A publish address the daemon's own `127.0.0.1:{port}` connection lands on.
 * Anything else — a container published on one specific LAN address — is not
 * what the relay talks to, so it can neither identify the port nor rule it
 * out; see `hostPortMatch`.
 */
const LOOPBACK_PUBLISH_ADDRESSES = new Set(['0.0.0.0', '127.0.0.1', '::', '[::]', '::1', '[::1]', ''])

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
    if (LOOPBACK_PUBLISH_ADDRESSES.has(match[1].trim())) return 'loopback'
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

/** `/proc/net/tcp` LISTEN rows: `st` is `0A`, the inode is column 9. */
function listenInodesForPort(content: string, port: number): Set<string> {
  const inodes = new Set<string>()
  const wanted = port.toString(16).toUpperCase().padStart(4, '0')
  for (const line of content.split('\n').slice(1)) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 10) continue
    const local = columns[1]
    const state = columns[3]
    if (state !== '0A') continue
    if (!local || local.split(':')[1]?.toUpperCase() !== wanted) continue
    inodes.add(columns[9])
  }
  return inodes
}

async function probeViaProc(port: number, io: EvidenceIo): Promise<EvidenceProbeResult> {
  const inodes = new Set<string>()
  const unread: string[] = []
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const content = await io.readFile(file)
    // `null` is a failed read; an empty string is a readable, empty table.
    if (content === null) {
      unread.push(file)
      continue
    }
    for (const inode of listenInodesForPort(content, port)) inodes.add(inode)
  }
  if (inodes.size === 0) {
    // "No LISTEN row" is only an answer when every table was readable — a
    // v6-bound dev server lives in exactly the file we may have missed.
    return unread.length === 0
      ? { status: 'none' }
      : { status: 'unavailable', detail: `could not read ${unread.join(', ')}` }
  }

  const wanted = new Set([...inodes].map((inode) => `socket:[${inode}]`))
  const pids = await io.readDir('/proc')
  if (!pids) {
    return { status: 'ambiguous', detail: `port ${port} is in LISTEN but /proc could not be read` }
  }

  const owners = new Set<string>()
  for (const entry of pids) {
    if (!/^\d+$/.test(entry)) continue
    const fds = await io.readDir(`/proc/${entry}/fd`)
    if (!fds) continue
    for (const fd of fds) {
      const target = await io.readLink(`/proc/${entry}/fd/${fd}`)
      if (target && wanted.has(target)) {
        owners.add(entry)
        break
      }
    }
  }

  if (owners.size === 0) {
    // The socket exists — another user's process holds it, or its fds are not
    // readable. Reporting "none" here would say nobody is listening on a port
    // that is very much in use.
    return {
      status: 'ambiguous',
      detail: `port ${port} is in LISTEN but no readable process owns the socket`,
    }
  }
  if (owners.size > 1) {
    return { status: 'ambiguous', detail: `${owners.size} processes listen on port ${port}` }
  }

  const pid = [...owners][0]
  const startedAt = await readProcStartTime(pid, io)
  const cwd = await io.readLink(`/proc/${pid}/cwd`)
  if (!startedAt || !cwd) {
    return {
      status: 'unavailable',
      detail: `pid ${pid} holds port ${port} but its start time or cwd is unreadable`,
    }
  }
  return { status: 'found', evidence: { kind: 'process', id: pid, startedAt, cwd } }
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

async function probeViaLsof(port: number, io: EvidenceIo): Promise<EvidenceProbeResult> {
  const listing = await io.exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'], EXEC_TIMEOUT_MS)
  if (listing.status !== 'ok') {
    return {
      status: 'unavailable',
      detail: `no usable listener probe on this platform (lsof ${listing.status})`,
    }
  }

  const pids = new Set<string>()
  for (const line of listing.stdout.split('\n')) {
    if (line.startsWith('p')) {
      const pid = line.slice(1).trim()
      if (pid) pids.add(pid)
    }
  }
  if (pids.size === 0) return { status: 'none' }
  if (pids.size > 1) {
    return { status: 'ambiguous', detail: `${pids.size} processes listen on port ${port}` }
  }

  const pid = [...pids][0]
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
