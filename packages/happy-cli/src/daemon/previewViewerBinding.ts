/**
 * specs/runtime-isolation-hardening (H3, P3) — the two binding variants, and
 * the rule that they never blur into each other.
 *
 * - **project** (existing, unchanged on the wire): `{ projectId, leaseId,
 *   workspacePaths? }`. Defined by the *absence* of `purpose` — that is what
 *   keeps every already-signed token valid.
 * - **viewer** (new): `{ purpose: 'viewer', viewerKey, leaseId }`. The
 *   browser-viewer runtime is not a project runtime: it has no workspace
 *   paths and no project label, and its owner is a user, not a project.
 *
 * Every deviation is a hard failure. The one thing this must never do is turn
 * a malformed binding into "unbound": unbound is the compatibility path for a
 * happy-server that predates H3, so degrading into it would hand a caller
 * precisely the check it just failed. Only a *genuinely absent* binding on the
 * *project* event is compatibility; on a viewer event, which exists solely for
 * bound requests, absence is a caller error.
 */

import { validateViewerKey } from './remoteViewer'

export interface ProjectBindingClaim {
    projectId: string
    leaseId: string
    workspacePaths: string[]
}

export interface ViewerBindingClaim {
    purpose: 'viewer'
    viewerKey: string
    leaseId: string
}

export type BindingDecodeFailure = {
    ok: false
    code: 'INVALID_REQUEST'
    message: string
}

export type ViewerBindingDecodeResult =
    | { ok: true; binding: ViewerBindingClaim }
    | BindingDecodeFailure

export type ProjectBindingDecodeResult =
    /** `binding: null` is the older-happy-server path, not a malformed claim. */
    | { ok: true; binding: ProjectBindingClaim | null }
    | BindingDecodeFailure

const MIXED = 'binding mixes project and viewer claims'

function reject(message: string): BindingDecodeFailure {
    return { ok: false, code: 'INVALID_REQUEST', message }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
}

/** Fields that only ever belong to one variant — their presence picks a side. */
const PROJECT_ONLY_FIELDS = ['projectId', 'workspacePaths'] as const
const VIEWER_ONLY_FIELDS = ['purpose', 'viewerKey'] as const

function carriesAny(candidate: Record<string, unknown>, fields: readonly string[]): boolean {
    // `in` rather than a truthiness check: `{ purpose: null }` is a *stated*
    // purpose this daemon does not know, not an absent one.
    return fields.some((field) => field in candidate)
}

export function decodeViewerBinding(binding: unknown): ViewerBindingDecodeResult {
    if (binding === undefined || binding === null) {
        return reject('This event carries bound viewer requests only')
    }
    const candidate = asRecord(binding)
    if (!candidate) return reject('binding must be an object')

    if (carriesAny(candidate, PROJECT_ONLY_FIELDS)) return reject(MIXED)
    if (candidate.purpose !== 'viewer') return reject('binding purpose must be "viewer"')
    if (typeof candidate.viewerKey !== 'string' || !validateViewerKey(candidate.viewerKey)) {
        return reject('binding requires a valid viewerKey')
    }
    if (typeof candidate.leaseId !== 'string' || candidate.leaseId.length === 0) {
        return reject('binding requires leaseId')
    }
    return {
        ok: true,
        binding: { purpose: 'viewer', viewerKey: candidate.viewerKey, leaseId: candidate.leaseId },
    }
}

export function decodeProjectBinding(binding: unknown): ProjectBindingDecodeResult {
    if (binding === undefined || binding === null) return { ok: true, binding: null }
    const candidate = asRecord(binding)
    if (!candidate) return reject('binding must be an object')

    if (carriesAny(candidate, VIEWER_ONLY_FIELDS)) return reject(MIXED)
    if (typeof candidate.projectId !== 'string' || candidate.projectId.length === 0) {
        return reject('binding requires projectId and leaseId')
    }
    if (typeof candidate.leaseId !== 'string' || candidate.leaseId.length === 0) {
        return reject('binding requires projectId and leaseId')
    }
    const workspacePaths = candidate.workspacePaths ?? []
    if (!Array.isArray(workspacePaths) || workspacePaths.some((entry) => typeof entry !== 'string')) {
        // Refused rather than emptied: an empty list is itself a meaningful
        // (and stricter) input, so substituting it would hide a broken caller.
        return reject('workspacePaths must be a list of strings')
    }
    return {
        ok: true,
        binding: {
            projectId: candidate.projectId,
            leaseId: candidate.leaseId,
            workspacePaths: workspacePaths as string[],
        },
    }
}
