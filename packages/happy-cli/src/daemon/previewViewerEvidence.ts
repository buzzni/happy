/**
 * specs/runtime-isolation-hardening (H3, P3) — runtime evidence for a
 * *browser viewer* port.
 *
 * The project-side evidence (previewRuntimeEvidence.ts) answers "what is
 * listening here, and does it belong to project X". A viewer needs a
 * different question answered, in a different order:
 *
 *     viewerKey -> that key's lease -> the runtime the lease names
 *                                   -> the thing actually listening
 *
 * Starting from the port instead — taking whatever lease happens to hold it —
 * is the failure this module exists to prevent. On a shared machine, user A
 * and user B both pass the machine ACL; if A's request were matched to
 * whatever runtime owns the port, A would be handed B's viewer. Machine
 * access and per-user runtime ownership are separate pieces of evidence, and
 * only the second one is decided here.
 *
 * Two modes, deliberately disjoint:
 *
 * - **native** — websockify/x11vnc/Xvfb owned by the daemon uid. The proof is
 *   the leased websockify pid actually being the process the relay's own
 *   `127.0.0.1:{port}` connection reaches, its start time (pids are reused),
 *   and its cmdline naming this slot's web *and* vnc ports.
 * - **broker** — a root-managed container. The daemon has no Docker access
 *   and is not given any; the broker hands over an opaque fingerprint it
 *   produced *after* verifying the container id, `State.StartedAt`, the exact
 *   viewer label and the loopback publish mapping.
 *
 * There is no fallback between them. A broker-mode daemon that cannot get a
 * fingerprint refuses the binding; it never reads the native registry, which
 * in that mode describes nothing that is running.
 *
 * Nothing here starts, adopts or replaces a runtime. Verification that can
 * repair what it is verifying cannot be used to refuse anything.
 */

import crypto from 'node:crypto'
import type { BrowserViewerLeaseRecord } from './browserViewerLeaseRegistry'
import type { BrowserSessionBrokerLease } from './browserSessionBrokerContract'
import type { EvidenceProbeResult } from './previewRuntimeEvidence'
import { VIEWER_LISTENER_NOT_OWNED } from './previewNativeViewerListener'
import { viewerProcessMatchesLease } from './remoteViewer'

export type ViewerEvidenceErrorCode =
    | 'NO_LISTENER'
    | 'EVIDENCE_UNAVAILABLE'
    /** The probe gate refused to look right now (load bound); retryable. */
    | 'EVIDENCE_BUSY'
    /** No lease exists for this viewer key on this machine. */
    | 'VIEWER_UNKNOWN'
    /** The key's lease serves a different port than the request names. */
    | 'VIEWER_PORT_MISMATCH'
    /** Something is there, but it is not the runtime this lease names. */
    | 'VIEWER_RUNTIME_MISMATCH'
    /** The broker cannot prove the container — an old broker, or a failed read. */
    | 'VIEWER_EVIDENCE_UNSUPPORTED'

export type ViewerEvidenceKind = 'viewer-native' | 'viewer-container'

export interface ViewerRuntimeEvidence {
    kind: ViewerEvidenceKind
    /** Opaque identity of *this run* of the runtime behind the port. */
    fingerprint: string
}

export type ViewerEvidenceResult =
    | { status: 'found'; evidence: ViewerRuntimeEvidence }
    | { status: 'error'; code: ViewerEvidenceErrorCode; message: string }

export interface ViewerEvidenceRequest {
    viewerKey: string
    port: number
}

/** Read-only by construction: there is no start/adopt/replace dependency here. */
export interface NativeViewerEvidenceDeps {
    getViewerLease(viewerKey: string): Promise<BrowserViewerLeaseRecord | null>
    /**
     * `expectedPid` is the websockify pid the *lease* names, resolved before
     * this call — the order is never reversed.
     *
     * It is a parameter rather than something the prober rediscovers because
     * a healthy viewer has **more than one process holding the port**:
     * websockify forks a worker that inherits the listening socket, so both
     * appear as owners while a request is in flight (observed on Linux:
     * parent 3821832 and worker 3821834 on one IPv4 inode). A generic
     * "exactly one owner" probe reads that as ambiguous and refuses a
     * perfectly healthy viewer, so the viewer path proves the *expected* pid
     * owns the single reachable inode instead. The generic project probe
     * stays strict and is not involved.
     */
    probeListener(port: number, expectedPid: number): Promise<EvidenceProbeResult>
    readProcessCmdline(pid: number): Promise<string | null>
}

export interface BrokerViewerEvidenceDeps {
    lookupBrokerLease(viewerKey: string): Promise<BrowserSessionBrokerLease | null>
}

function error(code: ViewerEvidenceErrorCode, message: string): ViewerEvidenceResult {
    return { status: 'error', code, message }
}

/**
 * Domain-separated so a native digest can never be read as a container one,
 * even if their inputs ever collided. NUL separator: no field can contain one.
 */
function digest(domain: string, parts: string[]): string {
    return crypto.createHash('sha256').update([domain, ...parts].join('\0')).digest('hex')
}

export async function resolveNativeViewerEvidence(
    request: ViewerEvidenceRequest,
    deps: NativeViewerEvidenceDeps,
): Promise<ViewerEvidenceResult> {
    // 1. key -> lease. Never port -> lease.
    let lease: BrowserViewerLeaseRecord | null
    try {
        lease = await deps.getViewerLease(request.viewerKey)
    } catch (e) {
        // A registry that could not be read says nothing about whether this
        // viewer exists. Reporting it as VIEWER_UNKNOWN would turn an I/O
        // fault into a confident "no such viewer" — the same mistake the
        // broker adapter avoids, and the reason both answer EVIDENCE_UNAVAILABLE.
        return error('EVIDENCE_UNAVAILABLE', e instanceof Error ? e.message : String(e))
    }
    if (!lease) {
        return error('VIEWER_UNKNOWN', `No viewer lease for this key on this machine`)
    }
    // 1b. the record handed back must be the one that was asked for. The
    //     registry is a file on disk and the lookup is a dependency; a
    //     mismatch here is a broken contract, not a near miss, and it is the
    //     single check that keeps "key -> lease" from degrading into
    //     "whatever the lookup felt like returning". Same rule as the broker
    //     adapter.
    if (lease.viewerKey !== request.viewerKey) {
        return error('VIEWER_RUNTIME_MISMATCH', 'The viewer registry answered for a different key')
    }
    // 2. the lease must be the one that owns the port under discussion.
    if (lease.webPort !== request.port) {
        return error('VIEWER_PORT_MISMATCH', `This viewer does not serve port ${request.port}`)
    }
    const websockifyPid = lease.processIds?.websockify
    if (!websockifyPid) {
        return error('EVIDENCE_UNAVAILABLE', 'The viewer lease records no websockify process to verify')
    }

    // 3. the runtime actually reachable at the relay's destination, proven
    //    against the pid the lease named in step 2.
    const probe = await deps.probeListener(request.port, websockifyPid)
    if (probe.status === 'none') {
        return error('NO_LISTENER', `Nothing is listening on 127.0.0.1:${request.port}`)
    }
    if (probe.status === 'busy') return error('EVIDENCE_BUSY', probe.detail)
    if (probe.status === 'ambiguous' || probe.status === 'unavailable') {
        // The viewer prober reports one *definite* negative through this
        // channel: it read the fd tables and the leased pid demonstrably does
        // not hold the listening socket. That is "someone else's runtime",
        // not "could not tell" — reporting it as missing evidence would make
        // a real ownership failure look retryable.
        return probe.detail.startsWith(`${VIEWER_LISTENER_NOT_OWNED}:`)
            ? error('VIEWER_RUNTIME_MISMATCH', probe.detail)
            : error('EVIDENCE_UNAVAILABLE', probe.detail)
    }
    if (probe.evidence.kind !== 'process') {
        // A container answering on a native viewer's port is not this viewer,
        // whatever else it is.
        return error('VIEWER_RUNTIME_MISMATCH', `Port ${request.port} is held by a container, not this viewer`)
    }
    if (probe.evidence.id !== String(websockifyPid)) {
        return error('VIEWER_RUNTIME_MISMATCH', `Port ${request.port} is held by another process`)
    }

    // 4. the process is really this slot's websockify — cmdline names both
    //    the web port and the vnc port, so a same-pid impostor serving a
    //    different slot does not pass.
    const cmdline = await deps.readProcessCmdline(websockifyPid).catch(() => null)
    if (cmdline === null) {
        return error('EVIDENCE_UNAVAILABLE', 'The viewer process command line could not be read')
    }
    if (!viewerProcessMatchesLease('websockify', cmdline, lease)) {
        return error('VIEWER_RUNTIME_MISMATCH', 'The process on this port does not serve this viewer slot')
    }

    return {
        status: 'found',
        evidence: {
            kind: 'viewer-native',
            // Start time is what makes a restart visible at all: pids are
            // reused, and a reused pid whose cmdline happens to match would
            // otherwise look identical to the run the token was minted for.
            fingerprint: digest('browser-viewer-native', [
                String(websockifyPid),
                probe.evidence.startedAt,
                String(lease.webPort),
                String(lease.vncPort),
                lease.display,
            ]),
        },
    }
}

export async function resolveBrokerViewerEvidence(
    request: ViewerEvidenceRequest,
    deps: BrokerViewerEvidenceDeps,
): Promise<ViewerEvidenceResult> {
    let lease: BrowserSessionBrokerLease | null
    try {
        lease = await deps.lookupBrokerLease(request.viewerKey)
    } catch (e) {
        // "Could not ask" is missing evidence, never absence and never
        // permission to look somewhere weaker.
        return error('EVIDENCE_UNAVAILABLE', e instanceof Error ? e.message : String(e))
    }
    if (!lease) {
        return error('VIEWER_UNKNOWN', 'No browser session for this key on this machine')
    }
    if (lease.viewerKey !== request.viewerKey) {
        return error('VIEWER_RUNTIME_MISMATCH', 'The broker answered for a different viewer')
    }
    if (lease.webPort !== request.port) {
        return error('VIEWER_PORT_MISMATCH', `This viewer does not serve port ${request.port}`)
    }
    if (!lease.runtimeFingerprint) {
        // An older broker, or one that could not read the container. Refusing
        // here is the point: the native registry describes nothing in broker
        // mode, so "fall back" would mean "stop checking".
        return error(
            'VIEWER_EVIDENCE_UNSUPPORTED',
            'The browser session broker did not prove which container serves this viewer',
        )
    }
    return {
        status: 'found',
        evidence: {
            kind: 'viewer-container',
            fingerprint: digest('browser-viewer-container', [lease.runtimeFingerprint]),
        },
    }
}
