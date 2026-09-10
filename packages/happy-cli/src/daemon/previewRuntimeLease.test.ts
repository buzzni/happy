import { describe, it, expect, vi } from 'vitest'
import {
  acquireRuntimeLease,
  verifyRuntimeLease,
  enforceRelayBinding,
  computeLeaseId,
  type RuntimeLeaseDeps,
} from './previewRuntimeLease'
import { fingerprintEvidence, type EvidenceProbeResult, type ListenerEvidence } from './previewRuntimeEvidence'

const WORKSPACE = '/home/dev/project-a'

const PROCESS_A: ListenerEvidence = {
  kind: 'process',
  id: '4242',
  startedAt: '55512345',
  cwd: WORKSPACE,
}

const CONTAINER_A: ListenerEvidence = {
  kind: 'container',
  id: 'container-a',
  startedAt: '2026-09-10 10:00:00',
  name: 'preview-a',
  projectLabel: 'proj-a',
}

function deps(overrides: Partial<RuntimeLeaseDeps> = {}): RuntimeLeaseDeps {
  return {
    probeEvidence: vi.fn(async (): Promise<EvidenceProbeResult> => ({ status: 'found', evidence: PROCESS_A })),
    readPortRegistry: vi.fn(async () => ({})),
    canonicalize: vi.fn(async (p: string) => p),
    ...overrides,
  }
}

const found = (evidence: ListenerEvidence) =>
  vi.fn(async (): Promise<EvidenceProbeResult> => ({ status: 'found', evidence }))

const request = (over: Partial<{ projectId: string; port: number; workspacePaths: string[] }> = {}) => ({
  projectId: 'proj-a',
  port: 3000,
  workspacePaths: [WORKSPACE],
  ...over,
})

describe('acquireRuntimeLease — project ownership must be proven, not assumed', () => {
  it('binds to a container that carries this project\'s aplus.projectId label', async () => {
    const result = await acquireRuntimeLease(
      request({ port: 32780, workspacePaths: [] }),
      deps({ probeEvidence: found(CONTAINER_A) }),
    )
    expect(result).toEqual({
      type: 'success',
      leaseId: computeLeaseId('proj-a', 32780, fingerprintEvidence(CONTAINER_A)),
      evidenceKind: 'container',
    })
  })

  it('refuses another project\'s container even when the registry knows nothing about the port', async () => {
    // The bypass this check exists for: with no registry row, project A could
    // otherwise be handed a lease over project B's container just because
    // something was listening there. A container id proves *a* runtime, never
    // *whose* runtime.
    const result = await acquireRuntimeLease(
      request({ port: 32780, workspacePaths: [] }),
      deps({ probeEvidence: found({ ...CONTAINER_A, projectLabel: 'proj-b' }) }),
    )
    expect(result).toMatchObject({ type: 'error', code: 'PROJECT_OWNERSHIP_MISMATCH' })
  })

  it('refuses a container with no aplus.projectId label at all', async () => {
    const result = await acquireRuntimeLease(
      request({ port: 32780, workspacePaths: [] }),
      deps({ probeEvidence: found({ ...CONTAINER_A, projectLabel: null }) }),
    )
    expect(result).toMatchObject({ type: 'error', code: 'PROJECT_OWNERSHIP_MISMATCH' })
  })

  it('binds a plain process whose cwd is inside the project workspace', async () => {
    const result = await acquireRuntimeLease(
      request({ workspacePaths: ['/home/dev'] }),
      deps(),
    )
    expect(result).toMatchObject({ type: 'success', evidenceKind: 'process' })
  })

  it('refuses a process running outside the project workspace', async () => {
    const result = await acquireRuntimeLease(
      request({ workspacePaths: ['/home/dev/project-b'] }),
      deps(),
    )
    expect(result).toMatchObject({ type: 'error', code: 'PROJECT_OWNERSHIP_MISMATCH' })
  })

  it('refuses a sibling directory that merely shares the workspace prefix', async () => {
    const result = await acquireRuntimeLease(
      request({ workspacePaths: ['/home/dev/project-a'] }),
      deps({ probeEvidence: found({ ...PROCESS_A, cwd: '/home/dev/project-a-evil' }) }),
    )
    expect(result).toMatchObject({ type: 'error', code: 'PROJECT_OWNERSHIP_MISMATCH' })
  })

  it('compares canonical paths so a symlinked workspace still matches', async () => {
    const result = await acquireRuntimeLease(
      request({ workspacePaths: ['/link/project-a'] }),
      deps({
        probeEvidence: found({ ...PROCESS_A, cwd: '/private/real/project-a/src' }),
        canonicalize: vi.fn(async (p: string) =>
          p.startsWith('/link/project-a') ? p.replace('/link', '/private/real') : p),
      }),
    )
    expect(result).toMatchObject({ type: 'success' })
  })

  it('refuses a process runtime when the studio supplied no workspace paths', async () => {
    // Without a server-verified workspace there is nothing to compare the cwd
    // against, and a caller-supplied path would be no evidence at all.
    const result = await acquireRuntimeLease(request({ workspacePaths: [] }), deps())
    expect(result).toMatchObject({ type: 'error', code: 'WORKSPACE_UNVERIFIED' })
  })

  it('fails closed when the cwd cannot be canonicalized', async () => {
    const result = await acquireRuntimeLease(
      request(),
      deps({ canonicalize: vi.fn(async () => null) }),
    )
    expect(result).toMatchObject({ type: 'error', code: 'EVIDENCE_UNAVAILABLE' })
  })
})

describe('acquireRuntimeLease — runtime and registry', () => {
  it('refuses when nothing is listening on the port', async () => {
    const result = await acquireRuntimeLease(
      request(),
      deps({ probeEvidence: vi.fn(async () => ({ status: 'none' as const })) }),
    )
    expect(result).toMatchObject({ type: 'error', code: 'NO_LISTENER' })
  })

  it('refuses when the runtime cannot be identified unambiguously', async () => {
    const result = await acquireRuntimeLease(
      request(),
      deps({ probeEvidence: vi.fn(async () => ({ status: 'ambiguous' as const, detail: 'two containers' })) }),
    )
    expect(result).toMatchObject({ type: 'error', code: 'EVIDENCE_UNAVAILABLE' })
  })

  it('refuses when the probe itself could not run', async () => {
    const result = await acquireRuntimeLease(
      request(),
      deps({ probeEvidence: vi.fn(async () => ({ status: 'unavailable' as const, detail: 'docker ps failed' })) }),
    )
    expect(result).toMatchObject({ type: 'error', code: 'EVIDENCE_UNAVAILABLE' })
  })

  it('reports a saturated probe as busy — retryable, and never a lease', async () => {
    const d = deps({ probeEvidence: vi.fn(async (): Promise<EvidenceProbeResult> => ({ status: 'busy', detail: 'probe queue full' })) })
    await expect(acquireRuntimeLease(request(), d)).resolves.toMatchObject({ type: 'error', code: 'EVIDENCE_BUSY' })
    await expect(verifyRuntimeLease({ ...request(), leaseId: 'x' }, d)).resolves.toMatchObject({ ok: false, code: 'EVIDENCE_BUSY' })
    await expect(enforceRelayBinding({ projectId: 'proj-a', leaseId: 'x' }, 3000, d))
      .resolves.toMatchObject({ outcome: 'rejected', code: 'EVIDENCE_BUSY' })
  })

  it('refuses when the port registry says the port belongs to another project', async () => {
    const result = await acquireRuntimeLease(
      request(),
      deps({
        readPortRegistry: vi.fn(async () => ({
          'user-2:proj-b': { port: 3000, allocatedAt: 1, userId: 'user-2', projectId: 'proj-b' },
        })),
      }),
    )
    expect(result).toMatchObject({ type: 'error', code: 'PORT_PROJECT_MISMATCH' })
  })

  it('reads the project out of a legacy bare-projectId registry key', async () => {
    const result = await acquireRuntimeLease(
      request(),
      deps({ readPortRegistry: vi.fn(async () => ({ 'proj-b': { port: 3000, allocatedAt: 1 } })) }),
    )
    expect(result).toMatchObject({ type: 'error', code: 'PORT_PROJECT_MISMATCH' })
  })

  it('rejects a malformed request instead of leasing something', async () => {
    await expect(acquireRuntimeLease(request({ projectId: '' }), deps()))
      .resolves.toMatchObject({ type: 'error', code: 'INVALID_REQUEST' })
    await expect(acquireRuntimeLease(request({ port: 0 }), deps()))
      .resolves.toMatchObject({ type: 'error', code: 'INVALID_REQUEST' })
  })
})

describe('verifyRuntimeLease', () => {
  const leaseFor = (projectId: string, port: number, evidence: ListenerEvidence) =>
    computeLeaseId(projectId, port, fingerprintEvidence(evidence))

  it('accepts the lease while the same runtime is still serving the port', async () => {
    await expect(verifyRuntimeLease(
      { ...request(), leaseId: leaseFor('proj-a', 3000, PROCESS_A) },
      deps(),
    )).resolves.toEqual({ ok: true })
  })

  it('rejects after the dev server restarts — a new runtime must be re-authorized', async () => {
    const restarted = { ...PROCESS_A, startedAt: '55599999' }
    await expect(verifyRuntimeLease(
      { ...request(), leaseId: leaseFor('proj-a', 3000, PROCESS_A) },
      deps({ probeEvidence: found(restarted) }),
    )).resolves.toMatchObject({ ok: false, code: 'LEASE_MISMATCH' })
  })

  it('rejects once another project has taken the port over', async () => {
    await expect(verifyRuntimeLease(
      { ...request({ port: 32780, workspacePaths: [] }), leaseId: leaseFor('proj-a', 32780, CONTAINER_A) },
      deps({ probeEvidence: found({ ...CONTAINER_A, id: 'container-b', projectLabel: 'proj-b' }) }),
    )).resolves.toMatchObject({ ok: false, code: 'PROJECT_OWNERSHIP_MISMATCH' })
  })

  it('re-checks ownership on every request, not only at mint', async () => {
    // Same live runtime, but the workspace it must belong to no longer covers
    // its cwd — the lease digest alone would still match.
    await expect(verifyRuntimeLease(
      { ...request({ workspacePaths: ['/home/dev/project-b'] }), leaseId: leaseFor('proj-a', 3000, PROCESS_A) },
      deps(),
    )).resolves.toMatchObject({ ok: false, code: 'PROJECT_OWNERSHIP_MISMATCH' })
  })

  it('rejects a lease minted for a different project on the same live runtime', async () => {
    await expect(verifyRuntimeLease(
      { ...request(), leaseId: leaseFor('proj-b', 3000, PROCESS_A) },
      deps(),
    )).resolves.toMatchObject({ ok: false, code: 'LEASE_MISMATCH' })
  })

  it('rejects a lease presented against a different port', async () => {
    await expect(verifyRuntimeLease(
      { ...request({ port: 3001 }), leaseId: leaseFor('proj-a', 3000, PROCESS_A) },
      deps(),
    )).resolves.toMatchObject({ ok: false, code: 'LEASE_MISMATCH' })
  })

  it('rejects when the runtime is gone rather than passing the request through', async () => {
    await expect(verifyRuntimeLease(
      { ...request(), leaseId: leaseFor('proj-a', 3000, PROCESS_A) },
      deps({ probeEvidence: vi.fn(async () => ({ status: 'none' as const })) }),
    )).resolves.toMatchObject({ ok: false, code: 'NO_LISTENER' })
  })

  it('survives a daemon restart — the lease is derived, not stored', async () => {
    const leaseId = computeLeaseId('proj-a', 3000, fingerprintEvidence(PROCESS_A))
    await expect(verifyRuntimeLease({ ...request(), leaseId }, deps())).resolves.toEqual({ ok: true })
  })
})

describe('enforceRelayBinding', () => {
  const validLease = () => computeLeaseId('proj-a', 3000, fingerprintEvidence(PROCESS_A))
  const binding = () => ({ projectId: 'proj-a', leaseId: validLease(), workspacePaths: [WORKSPACE] })

  it('enforces a well-formed binding against the live runtime', async () => {
    await expect(enforceRelayBinding(binding(), 3000, deps()))
      .resolves.toEqual({ outcome: 'enforced' })
  })

  it('rejects a binding whose runtime no longer matches', async () => {
    await expect(enforceRelayBinding({ ...binding(), leaseId: 'stale' }, 3000, deps()))
      .resolves.toMatchObject({ outcome: 'rejected', code: 'LEASE_MISMATCH' })
  })

  it('rejects a malformed binding instead of treating it as absent', async () => {
    await expect(enforceRelayBinding({ projectId: 'proj-a' }, 3000, deps()))
      .resolves.toMatchObject({ outcome: 'rejected', code: 'INVALID_REQUEST' })
    await expect(enforceRelayBinding('proj-a', 3000, deps()))
      .resolves.toMatchObject({ outcome: 'rejected', code: 'INVALID_REQUEST' })
    await expect(enforceRelayBinding({ ...binding(), workspacePaths: 'not-a-list' }, 3000, deps()))
      .resolves.toMatchObject({ outcome: 'rejected', code: 'INVALID_REQUEST' })
  })

  it('passes through a request from a server that sends no binding', async () => {
    await expect(enforceRelayBinding(undefined, 3000, deps())).resolves.toEqual({ outcome: 'unbound' })
  })
})
