/**
 * specs/runtime-isolation-hardening (H3, P3) — the viewer lease: a digest of
 * the runtime that was serving a viewer port when the token was minted, and
 * the gate every relayed viewer byte passes through.
 *
 * Unlike the project relay there is no "unbound" outcome here. The viewer
 * events were created for bound requests and nothing else, so an absent or
 * malformed binding is a refusal — degrading it to the project relay's
 * old-server compatibility path would hand a caller the check it just failed.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ViewerEvidenceResult } from './previewViewerEvidence'
import {
    acquireViewerLease,
    computeViewerLeaseId,
    enforceViewerRelayBinding,
    verifyViewerLease,
} from './previewViewerLease'

const KEY_A = 'bv1_abcdefghijklmnopqrstuvwxyz012345'
const KEY_B = 'bv1_abcdefghijklmnopqrstuvwxyz012346'
const FP = 'f'.repeat(64)

const found = (fingerprint = FP, kind: 'viewer-native' | 'viewer-container' = 'viewer-native'): ViewerEvidenceResult => ({
    status: 'found',
    evidence: { kind, fingerprint },
})

function deps(result: ViewerEvidenceResult = found()) {
    return { resolveEvidence: vi.fn(async () => result) }
}

describe('computeViewerLeaseId', () => {
    it('is domain separated from every other digest input it could collide with', () => {
        expect(computeViewerLeaseId(KEY_A, 6080, FP)).toMatch(/^[0-9a-f]{64}$/)
        expect(computeViewerLeaseId(KEY_A, 6080, FP)).not.toBe(computeViewerLeaseId(KEY_B, 6080, FP))
        expect(computeViewerLeaseId(KEY_A, 6080, FP)).not.toBe(computeViewerLeaseId(KEY_A, 6081, FP))
        expect(computeViewerLeaseId(KEY_A, 6080, FP)).not.toBe(computeViewerLeaseId(KEY_A, 6080, 'e'.repeat(64)))
    })

    it('is stable so a daemon restart over a live runtime reproduces the same lease', () => {
        expect(computeViewerLeaseId(KEY_A, 6080, FP)).toBe(computeViewerLeaseId(KEY_A, 6080, FP))
    })

    it('cannot be produced by concatenating other fields differently', () => {
        // NUL separation, not string joining: `a|b` and `a` + `|b` must differ.
        expect(computeViewerLeaseId(KEY_A, 6080, FP)).not.toBe(computeViewerLeaseId(`${KEY_A}\u00006080`, 6080, FP))
    })
})

describe('acquireViewerLease', () => {
    it('returns the lease and the evidence kind that produced it', async () => {
        await expect(acquireViewerLease({ viewerKey: KEY_A, port: 6080 }, deps())).resolves.toEqual({
            type: 'success',
            leaseId: computeViewerLeaseId(KEY_A, 6080, FP),
            evidenceKind: 'viewer-native',
        })
    })

    it('reports the container evidence kind in broker mode', async () => {
        await expect(acquireViewerLease({ viewerKey: KEY_A, port: 49123 }, deps(found(FP, 'viewer-container'))))
            .resolves.toMatchObject({ evidenceKind: 'viewer-container' })
    })

    it.each([
        ['a malformed viewer key', { viewerKey: 'nope', port: 6080 }],
        ['a missing viewer key', { port: 6080 } as never],
        ['a non-integer port', { viewerKey: KEY_A, port: 6080.5 }],
        ['port 0', { viewerKey: KEY_A, port: 0 }],
        ['port above the range', { viewerKey: KEY_A, port: 65_536 }],
    ])('refuses %s before looking at any runtime', async (_label, request) => {
        const d = deps()
        await expect(acquireViewerLease(request as never, d))
            .resolves.toMatchObject({ type: 'error', code: 'INVALID_REQUEST' })
        expect(d.resolveEvidence).not.toHaveBeenCalled()
    })

    it('passes the evidence failure through unchanged', async () => {
        const d = deps({ status: 'error', code: 'VIEWER_UNKNOWN', message: 'no lease' })
        await expect(acquireViewerLease({ viewerKey: KEY_A, port: 6080 }, d))
            .resolves.toEqual({ type: 'error', code: 'VIEWER_UNKNOWN', message: 'no lease' })
    })
})

describe('verifyViewerLease', () => {
    it('accepts the lease it just minted', async () => {
        const leaseId = computeViewerLeaseId(KEY_A, 6080, FP)
        await expect(verifyViewerLease({ viewerKey: KEY_A, port: 6080, leaseId }, deps()))
            .resolves.toEqual({ ok: true })
    })

    it('refuses a lease minted against a runtime that has since been replaced', async () => {
        const leaseId = computeViewerLeaseId(KEY_A, 6080, FP)
        await expect(verifyViewerLease({ viewerKey: KEY_A, port: 6080, leaseId }, deps(found('a'.repeat(64)))))
            .resolves.toMatchObject({ ok: false, code: 'LEASE_MISMATCH' })
    })

    it('refuses another user’s lease id on a runtime this key does own', async () => {
        // A/B swap: same machine, same live runtime, B's leaseId.
        const foreign = computeViewerLeaseId(KEY_B, 6080, FP)
        await expect(verifyViewerLease({ viewerKey: KEY_A, port: 6080, leaseId: foreign }, deps()))
            .resolves.toMatchObject({ ok: false, code: 'LEASE_MISMATCH' })
    })

    it('re-proves ownership rather than trusting the digest alone', async () => {
        // The digest says "unchanged runtime"; this says "still yours".
        const leaseId = computeViewerLeaseId(KEY_A, 6080, FP)
        const d = deps({ status: 'error', code: 'VIEWER_PORT_MISMATCH', message: 'moved' })
        await expect(verifyViewerLease({ viewerKey: KEY_A, port: 6080, leaseId }, d))
            .resolves.toMatchObject({ ok: false, code: 'VIEWER_PORT_MISMATCH' })
        expect(d.resolveEvidence).toHaveBeenCalledWith({ viewerKey: KEY_A, port: 6080 })
    })

    it('refuses an empty lease id without probing', async () => {
        const d = deps()
        await expect(verifyViewerLease({ viewerKey: KEY_A, port: 6080, leaseId: '' }, d))
            .resolves.toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
        expect(d.resolveEvidence).not.toHaveBeenCalled()
    })
})

describe('enforceViewerRelayBinding', () => {
    const leaseId = computeViewerLeaseId(KEY_A, 6080, FP)
    const binding = { purpose: 'viewer', viewerKey: KEY_A, leaseId }

    it('enforces a well formed binding over a matching runtime', async () => {
        await expect(enforceViewerRelayBinding(binding, 6080, deps())).resolves.toEqual({ outcome: 'enforced' })
    })

    it('never reports "unbound" — that path does not exist on viewer events', async () => {
        for (const absent of [undefined, null]) {
            const outcome = await enforceViewerRelayBinding(absent, 6080, deps())
            expect(outcome).toMatchObject({ outcome: 'rejected', code: 'INVALID_REQUEST' })
        }
    })

    it('refuses a project binding arriving on the viewer relay', async () => {
        const d = deps()
        await expect(enforceViewerRelayBinding({ projectId: 'p', leaseId }, 6080, d))
            .resolves.toMatchObject({ outcome: 'rejected', code: 'INVALID_REQUEST' })
        expect(d.resolveEvidence).not.toHaveBeenCalled()
    })

    it('refuses an unknown purpose without touching the runtime', async () => {
        const d = deps()
        await expect(enforceViewerRelayBinding({ purpose: 'admin', viewerKey: KEY_A, leaseId }, 6080, d))
            .resolves.toMatchObject({ outcome: 'rejected', code: 'INVALID_REQUEST' })
        expect(d.resolveEvidence).not.toHaveBeenCalled()
    })

    it('refuses B’s viewerKey with A’s lease on the port A is allowed to reach', async () => {
        await expect(enforceViewerRelayBinding({ purpose: 'viewer', viewerKey: KEY_B, leaseId }, 6080, deps()))
            .resolves.toMatchObject({ outcome: 'rejected', code: 'LEASE_MISMATCH' })
    })

    it('refuses the right key and lease against the wrong port', async () => {
        await expect(enforceViewerRelayBinding(binding, 6081, deps()))
            .resolves.toMatchObject({ outcome: 'rejected', code: 'LEASE_MISMATCH' })
    })

    it('refuses when the evidence could not be gathered, rather than relaying', async () => {
        const d = deps({ status: 'error', code: 'EVIDENCE_UNAVAILABLE', message: 'no proc' })
        await expect(enforceViewerRelayBinding(binding, 6080, d))
            .resolves.toMatchObject({ outcome: 'rejected', code: 'EVIDENCE_UNAVAILABLE' })
    })

    it('refuses in broker mode when the broker cannot prove the container', async () => {
        const d = deps({ status: 'error', code: 'VIEWER_EVIDENCE_UNSUPPORTED', message: 'old broker' })
        await expect(enforceViewerRelayBinding(binding, 6080, d))
            .resolves.toMatchObject({ outcome: 'rejected', code: 'VIEWER_EVIDENCE_UNSUPPORTED' })
    })
})
