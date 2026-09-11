/**
 * specs/runtime-isolation-hardening (H3, P3) — the viewer half of per-request
 * preview binding.
 *
 * Like the project lease (previewRuntimeLease.ts) this is derived, not
 * stored: `sha256('browser-viewer' | viewerKey | port | runtime
 * fingerprint)`. Deriving it means a daemon restart over a live viewer
 * reproduces the same lease instead of invalidating every open session, and
 * there is no table that can drift away from what is actually running.
 *
 * Three things have to hold, and the digest alone covers only the first:
 *
 * 1. **The runtime has not changed.** The fingerprint pins this run of this
 *    process or container — a restart, a replacement, or the same runtime
 *    republished on another port all change it.
 * 2. **The runtime belongs to this viewer key.** That is decided in
 *    previewViewerEvidence.ts, by looking the lease up *by key* and only then
 *    checking what is on the port. Machine ACL cannot supply this: on a
 *    shared machine both users pass it.
 * 3. **Ownership is re-proven per request**, not inherited from mint — the
 *    digest says "unchanged", the evidence says "still yours".
 *
 * The user's identity is deliberately absent from this file. The daemon has
 * no user table and must not pretend otherwise: happy-server derives the
 * viewerKey from the authenticated user and re-checks machine access per
 * request. What the daemon owns is the step nobody else can take — proving
 * which runtime a key actually reaches.
 */

import crypto from 'node:crypto'
import { validateViewerKey } from './remoteViewer'
import { decodeViewerBinding } from './previewViewerBinding'
import type {
    ViewerEvidenceKind,
    ViewerEvidenceRequest,
    ViewerEvidenceResult,
    ViewerEvidenceErrorCode,
} from './previewViewerEvidence'

export type ViewerLeaseErrorCode = ViewerEvidenceErrorCode | 'INVALID_REQUEST' | 'LEASE_MISMATCH'

export interface ViewerLeaseDeps {
    /** Native or broker adapter — chosen once, never fallen back between. */
    resolveEvidence(request: ViewerEvidenceRequest): Promise<ViewerEvidenceResult>
}

export type ViewerLeaseAcquireResult =
    | { type: 'success'; leaseId: string; evidenceKind: ViewerEvidenceKind }
    | { type: 'error'; code: ViewerLeaseErrorCode; message: string }

export type ViewerLeaseVerifyResult =
    | { ok: true }
    | { ok: false; code: ViewerLeaseErrorCode; message: string }

/**
 * No "unbound" member, unlike the project relay: the viewer events exist only
 * for bound requests, so there is no older-server shape to be compatible with.
 */
export type ViewerRelayBindingOutcome =
    | { outcome: 'enforced' }
    | { outcome: 'rejected'; code: ViewerLeaseErrorCode; message: string }

export function computeViewerLeaseId(viewerKey: string, port: number, fingerprint: string): string {
    // NUL separated and domain prefixed: a project lease, a viewer lease and
    // any future purpose can never be run into the same digest input.
    return crypto.createHash('sha256')
        .update(['browser-viewer', viewerKey, String(port), fingerprint].join('\0'))
        .digest('hex')
}

function isValidRequest(request: { viewerKey?: unknown; port?: unknown }): boolean {
    return typeof request.viewerKey === 'string'
        && validateViewerKey(request.viewerKey)
        && Number.isInteger(request.port)
        && (request.port as number) >= 1
        && (request.port as number) <= 65535
}

export async function acquireViewerLease(
    request: ViewerEvidenceRequest,
    deps: ViewerLeaseDeps,
): Promise<ViewerLeaseAcquireResult> {
    if (!isValidRequest(request)) {
        return { type: 'error', code: 'INVALID_REQUEST', message: 'a valid viewerKey and port are required' }
    }
    const evidence = await deps.resolveEvidence({ viewerKey: request.viewerKey, port: request.port })
    if (evidence.status === 'error') {
        return { type: 'error', code: evidence.code, message: evidence.message }
    }
    return {
        type: 'success',
        leaseId: computeViewerLeaseId(request.viewerKey, request.port, evidence.evidence.fingerprint),
        evidenceKind: evidence.evidence.kind,
    }
}

export async function verifyViewerLease(
    request: ViewerEvidenceRequest & { leaseId: string },
    deps: ViewerLeaseDeps,
): Promise<ViewerLeaseVerifyResult> {
    if (!isValidRequest(request) || !request.leaseId) {
        return { ok: false, code: 'INVALID_REQUEST', message: 'viewerKey, port and leaseId are required' }
    }
    const evidence = await deps.resolveEvidence({ viewerKey: request.viewerKey, port: request.port })
    if (evidence.status === 'error') {
        return { ok: false, code: evidence.code, message: evidence.message }
    }
    const expected = computeViewerLeaseId(request.viewerKey, request.port, evidence.evidence.fingerprint)
    if (expected !== request.leaseId) {
        return {
            ok: false,
            code: 'LEASE_MISMATCH',
            message: 'The runtime serving this viewer is not the one the token was issued for',
        }
    }
    return { ok: true }
}

/**
 * Gate applied to every relayed viewer request, HTTP and WS alike, before any
 * byte reaches the port.
 */
export async function enforceViewerRelayBinding(
    binding: unknown,
    port: number,
    deps: ViewerLeaseDeps,
): Promise<ViewerRelayBindingOutcome> {
    const decoded = decodeViewerBinding(binding)
    if (!decoded.ok) {
        return { outcome: 'rejected', code: decoded.code, message: decoded.message }
    }
    const verified = await verifyViewerLease(
        { viewerKey: decoded.binding.viewerKey, port, leaseId: decoded.binding.leaseId },
        deps,
    )
    if (!verified.ok) {
        return { outcome: 'rejected', code: verified.code, message: verified.message }
    }
    return { outcome: 'enforced' }
}
