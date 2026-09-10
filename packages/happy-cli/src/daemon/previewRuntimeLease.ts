/**
 * specs/runtime-isolation-hardening (H3) — the daemon half of per-request
 * preview binding.
 *
 * A lease is not a stored grant: it is `sha256(projectId | port | evidence
 * fingerprint)` of the runtime that was serving the port when the token was
 * minted. Deriving it instead of storing it means a daemon restart does not
 * invalidate every open preview, and there is no lease table that can drift
 * away from what is actually running.
 *
 * Three independent things have to hold, and the digest alone covers only the
 * first:
 *
 * 1. **The runtime has not changed.** The evidence fingerprint pins the exact
 *    container or process. A restart, a port handed to another project, or a
 *    rogue process taking the port over all change it.
 * 2. **The runtime belongs to this project.** A container id proves *a*
 *    runtime, never *whose*: ownership comes from the container's
 *    `aplus.projectId` label, or — for a plain dev-server process — from its
 *    cwd sitting inside a workspace path the *studio* verified and returned.
 *    Without this, project A could be leased project B's port simply because
 *    something was listening there. Caller-supplied workspace paths are not
 *    accepted anywhere: they arrive from happy-server's authenticated studio
 *    callback, never from the browser or the token.
 * 3. **The port registry does not contradict the claim.** A row naming a
 *    different project is a positive contradiction; registry silence proves
 *    nothing (container-published host ports never go through
 *    `allocate-port`), so silence alone can neither authorize nor refuse.
 *
 * Project ACL is deliberately absent here — the daemon has no access to the
 * studio's project tables and must not pretend otherwise. Authorization
 * happens at mint (studio) and is re-checked per request by happy-server
 * against the studio callback.
 */

import crypto from 'node:crypto'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { PortRegistryData } from './portRegistry'
import { fingerprintEvidence, type EvidenceProbeResult, type ListenerEvidence } from './previewRuntimeEvidence'

export type RuntimeLeaseErrorCode =
  | 'INVALID_REQUEST'
  | 'NO_LISTENER'
  | 'EVIDENCE_UNAVAILABLE'
  /** The probe gate refused to look right now (load bound); retryable. */
  | 'EVIDENCE_BUSY'
  | 'PORT_PROJECT_MISMATCH'
  | 'PROJECT_OWNERSHIP_MISMATCH'
  | 'WORKSPACE_UNVERIFIED'
  | 'LEASE_MISMATCH'

export interface RuntimeLeaseDeps {
  probeEvidence(port: number): Promise<EvidenceProbeResult>
  readPortRegistry(): Promise<PortRegistryData>
  /** Resolves symlinks; null when the path does not exist. */
  canonicalize(target: string): Promise<string | null>
}

export function createRuntimeLeaseCanonicalizer(): (target: string) => Promise<string | null> {
  return async (target: string) => fs.realpath(target).catch(() => null)
}

/**
 * What the studio asserts, all of it server-verified before it reaches here:
 * the project, the port, and the workspace paths that project owns on this
 * machine (project root and its worktrees).
 */
export interface RuntimeBindingRequest {
  projectId: string
  port: number
  workspacePaths: string[]
}

export type LeaseAcquireResult =
  | { type: 'success'; leaseId: string; evidenceKind: string }
  | { type: 'error'; code: RuntimeLeaseErrorCode; message: string }

export type LeaseVerifyResult =
  | { ok: true }
  | { ok: false; code: RuntimeLeaseErrorCode; message: string }

export function computeLeaseId(projectId: string, port: number, fingerprint: string): string {
  return crypto.createHash('sha256').update(`${projectId}|${port}|${fingerprint}`).digest('hex')
}

/** Registry rows written before the composite key used the bare projectId. */
function projectIdOfRegistryKey(key: string, entry: { projectId?: string }): string {
  if (entry.projectId) return entry.projectId
  const separator = key.indexOf(':')
  return separator === -1 ? key : key.slice(separator + 1)
}

async function contradictedByRegistry(
  projectId: string,
  port: number,
  deps: RuntimeLeaseDeps,
): Promise<string | null> {
  const registry = await deps.readPortRegistry().catch(() => ({} as PortRegistryData))
  for (const [key, entry] of Object.entries(registry)) {
    if (entry.port !== port) continue
    const owner = projectIdOfRegistryKey(key, entry)
    if (owner !== projectId) return owner
  }
  return null
}

/** `/a/b` contains `/a/b` and `/a/b/c`, but never `/a/b-evil`. */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

type OwnershipFailure = { code: RuntimeLeaseErrorCode; message: string }

async function proveProjectOwnership(
  evidence: ListenerEvidence,
  request: RuntimeBindingRequest,
  deps: RuntimeLeaseDeps,
): Promise<OwnershipFailure | null> {
  if (evidence.kind === 'container') {
    if (evidence.projectLabel === request.projectId) return null
    return {
      code: 'PROJECT_OWNERSHIP_MISMATCH',
      message: evidence.projectLabel
        ? `Container on port ${request.port} belongs to another project`
        : `Container on port ${request.port} carries no aplus.projectId label`,
    }
  }

  if (request.workspacePaths.length === 0) {
    return {
      code: 'WORKSPACE_UNVERIFIED',
      message: `No verified workspace path for project ${request.projectId}; cannot prove the process on port ${request.port} belongs to it`,
    }
  }

  const cwd = await deps.canonicalize(evidence.cwd)
  if (!cwd) {
    return {
      code: 'EVIDENCE_UNAVAILABLE',
      message: `Working directory of the process on port ${request.port} could not be resolved`,
    }
  }
  for (const workspace of request.workspacePaths) {
    const canonicalWorkspace = await deps.canonicalize(workspace)
    if (canonicalWorkspace && isInside(canonicalWorkspace, cwd)) return null
  }
  return {
    code: 'PROJECT_OWNERSHIP_MISMATCH',
    message: `The process on port ${request.port} runs outside the project workspace`,
  }
}

async function resolveOwnedRuntime(
  request: RuntimeBindingRequest,
  deps: RuntimeLeaseDeps,
): Promise<{ fingerprint: string; evidenceKind: string } | OwnershipFailure> {
  if (await contradictedByRegistry(request.projectId, request.port, deps)) {
    return {
      code: 'PORT_PROJECT_MISMATCH',
      message: `Port ${request.port} is registered to another project`,
    }
  }

  const probe = await deps.probeEvidence(request.port)
  if (probe.status === 'none') {
    return { code: 'NO_LISTENER', message: `Nothing is listening on 127.0.0.1:${request.port}` }
  }
  if (probe.status === 'busy') {
    return { code: 'EVIDENCE_BUSY', message: probe.detail }
  }
  if (probe.status === 'ambiguous' || probe.status === 'unavailable') {
    return { code: 'EVIDENCE_UNAVAILABLE', message: probe.detail }
  }

  const ownership = await proveProjectOwnership(probe.evidence, request, deps)
  if (ownership) return ownership

  return {
    fingerprint: fingerprintEvidence(probe.evidence),
    evidenceKind: probe.evidence.kind,
  }
}

function isValidRequest(request: RuntimeBindingRequest): boolean {
  return Boolean(request.projectId)
    && Number.isInteger(request.port)
    && request.port >= 1
    && request.port <= 65535
    && Array.isArray(request.workspacePaths)
}

export async function acquireRuntimeLease(
  request: RuntimeBindingRequest,
  deps: RuntimeLeaseDeps,
): Promise<LeaseAcquireResult> {
  if (!isValidRequest(request)) {
    return { type: 'error', code: 'INVALID_REQUEST', message: 'projectId and a valid port are required' }
  }

  const runtime = await resolveOwnedRuntime(request, deps)
  if ('code' in runtime) {
    return { type: 'error', code: runtime.code, message: runtime.message }
  }
  return {
    type: 'success',
    leaseId: computeLeaseId(request.projectId, request.port, runtime.fingerprint),
    evidenceKind: runtime.evidenceKind,
  }
}

export async function verifyRuntimeLease(
  request: RuntimeBindingRequest & { leaseId: string },
  deps: RuntimeLeaseDeps,
): Promise<LeaseVerifyResult> {
  if (!isValidRequest(request) || !request.leaseId) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'projectId, port and leaseId are required' }
  }

  // Ownership is re-proven here, not inherited from mint: the digest says the
  // runtime is unchanged, and this says it is still this project's runtime.
  const runtime = await resolveOwnedRuntime(request, deps)
  if ('code' in runtime) {
    return { ok: false, code: runtime.code, message: runtime.message }
  }

  const expected = computeLeaseId(request.projectId, request.port, runtime.fingerprint)
  if (expected !== request.leaseId) {
    return {
      ok: false,
      code: 'LEASE_MISMATCH',
      message: 'The runtime serving this port is not the one the token was issued for',
    }
  }
  return { ok: true }
}

/**
 * Gate applied to every relayed preview request.
 *
 * `binding` absent means the request came from a happy-server that predates
 * H3 — the server is the component that rolls forward first, so this is
 * allowed and reported as `unbound` for logging. The reverse skew (a bound
 * token reaching an old daemon) cannot be handled here at all, which is why
 * the enforced outcome is echoed back to the server: silence from an old
 * daemon is what the server treats as "not enforced".
 */
export type RelayBindingOutcome =
  | { outcome: 'enforced' }
  | { outcome: 'unbound' }
  | { outcome: 'rejected'; code: RuntimeLeaseErrorCode; message: string }

export async function enforceRelayBinding(
  binding: unknown,
  port: number,
  deps: RuntimeLeaseDeps,
): Promise<RelayBindingOutcome> {
  if (binding === undefined || binding === null) return { outcome: 'unbound' }
  if (typeof binding !== 'object') {
    return { outcome: 'rejected', code: 'INVALID_REQUEST', message: 'binding must be an object' }
  }
  const candidate = binding as { projectId?: unknown; leaseId?: unknown; workspacePaths?: unknown }
  if (typeof candidate.projectId !== 'string' || typeof candidate.leaseId !== 'string') {
    return { outcome: 'rejected', code: 'INVALID_REQUEST', message: 'binding requires projectId and leaseId' }
  }
  const workspacePaths = candidate.workspacePaths ?? []
  if (!Array.isArray(workspacePaths) || workspacePaths.some((entry) => typeof entry !== 'string')) {
    // A malformed workspace list is refused rather than emptied: an empty list
    // is itself a meaningful (and stricter) input, and silently substituting
    // it would hide a broken caller.
    return { outcome: 'rejected', code: 'INVALID_REQUEST', message: 'workspacePaths must be a list of strings' }
  }

  const verified = await verifyRuntimeLease(
    {
      projectId: candidate.projectId,
      port,
      leaseId: candidate.leaseId,
      workspacePaths: workspacePaths as string[],
    },
    deps,
  )
  if (!verified.ok) {
    return { outcome: 'rejected', code: verified.code, message: verified.message }
  }
  return { outcome: 'enforced' }
}
