/**
 * specs/runtime-isolation-hardening (H3 viewer purpose) — listener evidence for
 * a *native* browser viewer, proven against the viewer we expect rather than
 * against whatever happens to hold the port.
 *
 * The generic probe asks "which process owns this port?" and refuses when more
 * than one does. websockify makes that question unanswerable: it forks a worker
 * and both processes keep the *same* listening socket, so a perfectly healthy
 * viewer looks like a contested port. From a real Linux run (root's probe,
 * 2026-09-11):
 *
 *   websockif 3821832 coder 3u IPv4 2287524552 TCP 127.0.0.1:46337 (LISTEN)
 *   websockif 3821834 coder 3u IPv4 2287524552 TCP 127.0.0.1:46337 (LISTEN)
 *   → "2 processes listen on 127.0.0.1:46337" → EVIDENCE_UNAVAILABLE
 *
 * Two pids, one inode. The port is not contested; it is inherited.
 *
 * So this probe counts **sockets, not processes**, and turns the ownership
 * question around:
 *
 * 1. There must be exactly one reachable listening socket on the port. Two
 *    *distinct* inodes is `SO_REUSEPORT`: the kernel picks which one accepts a
 *    connection, so nothing here can say which runtime the relay would reach.
 *    That stays a refusal.
 * 2. The pid the registry recorded for this viewer must hold that socket. Its
 *    fd table is the only place that says so, and it is checked directly —
 *    `/proc` is never scanned for "some process that looks like websockify".
 *    Process names and parent/child relationships are guesses; an fd pointing
 *    at `socket:[inode]` is the kernel's own answer.
 *
 * What it deliberately does not do: accept a second socket because the pids
 * look related, infer the viewer from the port number, or widen the reachable
 * address set. Every unreadable input is a refusal, never an assumption.
 */

import {
  listenSocketsForPort,
  probeContainerPublish,
  probeListenerEvidence,
  RELAY_DESTINATION_HOST,
  type EvidenceIo,
  type EvidenceProbeResult,
} from './previewRuntimeEvidence'

/** Same budget the generic probe gives one loopback reachability check. */
const CONNECT_TIMEOUT_MS = 2_000

const TCP6_TABLE = '/proc/net/tcp6'

/**
 * The kernel's own record of whether IPv6 exists on this machine. `1` means
 * the module was loaded with `disable=1`, and then `/proc/net/tcp6` is ENOENT
 * because there is no IPv6 stack — not because we failed to read it.
 */
const IPV6_DISABLED_FLAG = '/sys/module/ipv6/parameters/disable'

/**
 * specs/runtime-isolation-hardening (H3 viewer purpose) — the *only* reason an
 * absent `/proc/net/tcp6` is an answer rather than a gap.
 *
 * Observed on root's target (2026-09-11 rerun): `/proc/net/tcp6` ENOENT,
 * `/proc/sys/net/ipv6` absent, and this file containing a literal `1`. A
 * healthy IPv4 viewer was being refused for a table that cannot exist.
 *
 * This is a proof, not a tolerance. Nothing is inferred from the table simply
 * being missing: without this file, with anything other than `1` in it, or
 * with `0`, the missing table stays `unavailable`. And it can only ever
 * explain `/proc/net/tcp6` — an unreadable `/proc/net/tcp` is still a refusal
 * on a machine with no IPv6, because that is where the viewer's socket is.
 */
async function ipv6IsDisabled(io: EvidenceIo): Promise<boolean> {
  const flag = await io.readFile(IPV6_DISABLED_FLAG)
  return flag !== null && flag.trim() === '1'
}

/**
 * Prefix on the `ambiguous` detail for the one case that is a *definite*
 * negative rather than an unanswerable question: a listener is there and it
 * provably is not this viewer's. The caller may map it to a sharper lease code;
 * the status stays fail-closed either way.
 */
export const VIEWER_LISTENER_NOT_OWNED = 'viewer-listener-not-owned'

export async function probeNativeViewerListenerEvidence(
  port: number,
  expectedPid: number,
  io: EvidenceIo,
): Promise<EvidenceProbeResult> {
  // Non-Linux keeps the existing behaviour exactly. macOS has no /proc, and
  // the inherited-socket problem is not a reason to invent a new guarantee
  // there — lsof cannot show an inode the way /proc does.
  if (io.platform !== 'linux') return probeListenerEvidence(port, io)

  if (!Number.isInteger(expectedPid) || expectedPid <= 0) {
    return { status: 'unavailable', detail: `invalid expected viewer pid ${expectedPid}` }
  }

  // Container publish outranks the inode, exactly as in the generic probe. A
  // published container port is DNAT'd, so `127.0.0.1:{port}` lands inside the
  // container while the host-side LISTEN row belongs to docker's proxy — a
  // socket whose holder says nothing about what the relay actually reaches.
  // Proving an inode first would let a container quietly answer for a native
  // viewer's port. `none` is the only fall-through: it is what this returns
  // both when docker is absent and when no container publishes the port, and
  // every other answer (found / ambiguous / unavailable) is fail-closed here.
  const container = await probeContainerPublish(port, io)
  if (container.status !== 'none') return container

  const sockets = new Map<string, 'v4' | 'v6-any'>()
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

  // The one unread table that can be *proven* empty rather than assumed so.
  const missing = unread.length === 1 && unread[0] === TCP6_TABLE && await ipv6IsDisabled(io)
    ? []
    : unread

  if (sockets.size === 0) {
    // "No LISTEN row" is only an answer when every table was accounted for — a
    // dual-stack listener lives in exactly the file we may have missed.
    return missing.length === 0
      ? { status: 'none' }
      : { status: 'unavailable', detail: `could not read ${missing.join(', ')}` }
  }
  // A partial read cannot be used even when what we did read looks complete:
  // the unread table may hold the second socket that would make this
  // ambiguous.
  if (missing.length > 0) {
    return { status: 'unavailable', detail: `could not read ${missing.join(', ')}` }
  }

  if (sockets.size > 1) {
    return {
      status: 'ambiguous',
      detail: `port ${port} has ${sockets.size} distinct listening sockets; the kernel chooses which one accepts ${RELAY_DESTINATION_HOST}`,
    }
  }

  const [[inode, klass]] = [...sockets]

  if (klass === 'v6-any') {
    // A lone `::` listener. Dual-stack or v6-only is invisible in the tables;
    // the only proof that the relay's destination reaches it is the
    // destination itself answering.
    const reach = await io.connectLoopback(port, CONNECT_TIMEOUT_MS)
    if (reach.status === 'refused') return { status: 'none' }
    if (reach.status !== 'connected') {
      return {
        status: 'unavailable',
        detail: `could not prove ${RELAY_DESTINATION_HOST}:${port} reaches the IPv6 listener: ${reach.detail}`,
      }
    }
  }

  const owns = await pidHoldsSocket(expectedPid, inode, io)
  if (owns === null) {
    return { status: 'unavailable', detail: `could not read the fd table of viewer pid ${expectedPid}` }
  }
  if (!owns) {
    return {
      status: 'ambiguous',
      detail: `${VIEWER_LISTENER_NOT_OWNED}: pid ${expectedPid} does not hold the socket listening on port ${port}`,
    }
  }

  const startedAt = await readProcStartTime(expectedPid, io)
  const cwd = await io.readLink(`/proc/${expectedPid}/cwd`)
  if (!startedAt || !cwd) {
    return {
      status: 'unavailable',
      detail: `viewer pid ${expectedPid} holds port ${port} but its start time or cwd is unreadable`,
    }
  }
  return { status: 'found', evidence: { kind: 'process', id: String(expectedPid), startedAt, cwd } }
}

/**
 * Does this pid hold that socket? `null` means the fd table could not be read,
 * which is not the same answer as "no" — the caller refuses on either, but only
 * one of them is the viewer's fault.
 *
 * Other processes sharing the inode are irrelevant and are never looked for: a
 * forked worker holding the parent's socket is the normal case this exists for.
 */
async function pidHoldsSocket(pid: number, inode: string, io: EvidenceIo): Promise<boolean | null> {
  const fds = await io.readDir(`/proc/${pid}/fd`)
  if (!fds) return null
  const wanted = `socket:[${inode}]`
  for (const fd of fds) {
    if ((await io.readLink(`/proc/${pid}/fd/${fd}`)) === wanted) return true
  }
  return false
}

/**
 * `/proc/<pid>/stat` field 22. The command name (field 2) is parenthesised and
 * may contain spaces and parens of its own, so the split starts after the final
 * `)`. Digits only: a blank or malformed field would otherwise become part of a
 * lease digest and make two different runtimes hash the same.
 *
 * Duplicated from previewRuntimeEvidence rather than shared because that
 * module's copy is private and this file does not own it.
 */
async function readProcStartTime(pid: number, io: EvidenceIo): Promise<string | null> {
  const stat = await io.readFile(`/proc/${pid}/stat`)
  if (!stat) return null
  const tail = stat.slice(stat.lastIndexOf(')') + 1).trim()
  const field = tail.split(/\s+/)[19]
  return field && /^\d+$/.test(field) ? field : null
}
