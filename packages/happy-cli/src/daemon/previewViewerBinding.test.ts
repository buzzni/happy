/**
 * specs/runtime-isolation-hardening (H3, P3) — strict disjoint decoding of the
 * two binding variants.
 *
 * The whole point of a `purpose` field is that the two variants never blur
 * into each other. A viewer claim arriving on the project event, a project
 * claim on the viewer event, an unknown purpose, a half-filled viewer
 * binding — every one of those is a hard failure. None of them may degrade to
 * "unbound", because unbound is the compatibility path for an older
 * happy-server and would hand the caller exactly what it was denied.
 */
import { describe, expect, it } from 'vitest'
import { decodeProjectBinding, decodeViewerBinding } from './previewViewerBinding'

const VIEWER_KEY = 'bv1_abcdefghijklmnopqrstuvwxyz012345'

describe('decodeViewerBinding', () => {
    it('accepts the exact viewer shape', () => {
        expect(decodeViewerBinding({ purpose: 'viewer', viewerKey: VIEWER_KEY, leaseId: 'lease-1' })).toEqual({
            ok: true,
            binding: { purpose: 'viewer', viewerKey: VIEWER_KEY, leaseId: 'lease-1' },
        })
    })

    it('refuses a missing binding instead of treating it as unbound', () => {
        // The viewer events exist only for bound requests; "no binding" on one
        // of them is a caller error, never the old-server compatibility path.
        for (const absent of [undefined, null]) {
            expect(decodeViewerBinding(absent)).toEqual({
                ok: false,
                code: 'INVALID_REQUEST',
                message: 'This event carries bound viewer requests only',
            })
        }
    })

    it('refuses a project binding on the viewer event', () => {
        const decoded = decodeViewerBinding({ projectId: 'proj-1', leaseId: 'lease-1', workspacePaths: [] })
        expect(decoded.ok).toBe(false)
    })

    it('refuses a mixed project/viewer claim', () => {
        const decoded = decodeViewerBinding({
            purpose: 'viewer',
            viewerKey: VIEWER_KEY,
            leaseId: 'lease-1',
            projectId: 'proj-1',
        })
        expect(decoded).toEqual({
            ok: false,
            code: 'INVALID_REQUEST',
            message: 'binding mixes project and viewer claims',
        })
    })

    it('refuses a mixed claim that carries workspacePaths', () => {
        const decoded = decodeViewerBinding({
            purpose: 'viewer',
            viewerKey: VIEWER_KEY,
            leaseId: 'lease-1',
            workspacePaths: ['/srv/proj-1'],
        })
        expect(decoded).toEqual({
            ok: false,
            code: 'INVALID_REQUEST',
            message: 'binding mixes project and viewer claims',
        })
    })

    it.each([
        ['unknown purpose', { purpose: 'admin', viewerKey: VIEWER_KEY, leaseId: 'lease-1' }],
        ['null purpose', { purpose: null, viewerKey: VIEWER_KEY, leaseId: 'lease-1' }],
        ['numeric purpose', { purpose: 1, viewerKey: VIEWER_KEY, leaseId: 'lease-1' }],
        ['absent purpose', { viewerKey: VIEWER_KEY, leaseId: 'lease-1' }],
        ['missing viewerKey', { purpose: 'viewer', leaseId: 'lease-1' }],
        ['missing leaseId', { purpose: 'viewer', viewerKey: VIEWER_KEY }],
        ['empty leaseId', { purpose: 'viewer', viewerKey: VIEWER_KEY, leaseId: '' }],
        ['malformed viewerKey', { purpose: 'viewer', viewerKey: 'not-a-key', leaseId: 'lease-1' }],
        ['non-object', 'viewer'],
        ['array', []],
    ])('refuses %s', (_label, candidate) => {
        expect(decodeViewerBinding(candidate).ok).toBe(false)
    })
})

describe('decodeProjectBinding', () => {
    it('accepts the existing shape with purpose absent', () => {
        expect(decodeProjectBinding({ projectId: 'proj-1', leaseId: 'lease-1', workspacePaths: ['/srv/a'] })).toEqual({
            ok: true,
            binding: { projectId: 'proj-1', leaseId: 'lease-1', workspacePaths: ['/srv/a'] },
        })
    })

    it('defaults workspacePaths to an empty list when the field is absent', () => {
        expect(decodeProjectBinding({ projectId: 'proj-1', leaseId: 'lease-1' })).toEqual({
            ok: true,
            binding: { projectId: 'proj-1', leaseId: 'lease-1', workspacePaths: [] },
        })
    })

    it('refuses a viewer claim on the project event', () => {
        expect(decodeProjectBinding({ purpose: 'viewer', viewerKey: VIEWER_KEY, leaseId: 'lease-1' })).toEqual({
            ok: false,
            code: 'INVALID_REQUEST',
            message: 'binding mixes project and viewer claims',
        })
    })

    it('refuses a project binding that carries any purpose at all', () => {
        // Not just 'viewer': a project token is defined by the *absence* of a
        // purpose, so anything else is a variant this daemon does not know.
        for (const purpose of ['project', 'admin', null, 0]) {
            expect(decodeProjectBinding({ projectId: 'proj-1', leaseId: 'lease-1', purpose }).ok).toBe(false)
        }
    })

    it('refuses a project binding that smuggles a viewerKey', () => {
        expect(decodeProjectBinding({ projectId: 'proj-1', leaseId: 'lease-1', viewerKey: VIEWER_KEY }).ok).toBe(false)
    })

    it('refuses a malformed workspacePaths list rather than emptying it', () => {
        expect(decodeProjectBinding({ projectId: 'p', leaseId: 'l', workspacePaths: ['/a', 2] }).ok).toBe(false)
        expect(decodeProjectBinding({ projectId: 'p', leaseId: 'l', workspacePaths: 'x' }).ok).toBe(false)
    })

    it.each([
        ['missing projectId', { leaseId: 'lease-1' }],
        ['missing leaseId', { projectId: 'proj-1' }],
        ['non-object', 7],
        ['array', []],
    ])('refuses %s', (_label, candidate) => {
        expect(decodeProjectBinding(candidate).ok).toBe(false)
    })

    it('reports an absent binding separately so the relay can stay compatible', () => {
        // Unlike the viewer event, the *project* event predates H3 and an
        // older happy-server sends no binding at all.
        expect(decodeProjectBinding(undefined)).toEqual({ ok: true, binding: null })
        expect(decodeProjectBinding(null)).toEqual({ ok: true, binding: null })
    })
})
