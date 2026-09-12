/**
 * specs/runtime-isolation-hardening (H3, P3) — what is *actually* serving a
 * browser-viewer port, proven from the viewer key inwards.
 *
 * The order is the whole security property: viewerKey -> that key's lease ->
 * the runtime the lease names -> the thing actually listening. Looking the
 * other way round (port first, then whatever lease happens to hold it) is how
 * user A ends up leased user B's viewer on a shared machine, which machine
 * ACL alone does not prevent.
 */
import { describe, expect, it, vi } from 'vitest'
import type { EvidenceProbeResult } from './previewRuntimeEvidence'
import {
    resolveBrokerViewerEvidence,
    resolveNativeViewerEvidence,
} from './previewViewerEvidence'
import type { BrowserViewerLeaseRecord } from './browserViewerLeaseRegistry'
import { VIEWER_LISTENER_NOT_OWNED } from './previewNativeViewerListener'

const KEY_A = 'bv1_abcdefghijklmnopqrstuvwxyz012345'
const KEY_B = 'bv1_abcdefghijklmnopqrstuvwxyz012346'

const WEBSOCKIFY_PID = 4242
const CMDLINE = ['websockify', '--web', '/usr/share/novnc', '127.0.0.1:6080', '127.0.0.1:5900'].join('\0')

function nativeLease(overrides: Partial<BrowserViewerLeaseRecord> = {}): BrowserViewerLeaseRecord {
    return {
        viewerKey: KEY_A,
        slot: 0,
        display: ':99',
        vncPort: 5900,
        webPort: 6080,
        cdpPort: null,
        profileDir: '/home/u/.happy/browser-viewers/key/chrome-profile',
        lastUsedAt: 1_000,
        processIds: { xvfb: 4240, x11vnc: 4241, websockify: WEBSOCKIFY_PID },
        ...overrides,
    }
}

const processEvidence = (overrides: { id?: string; startedAt?: string } = {}): EvidenceProbeResult => ({
    status: 'found',
    evidence: {
        kind: 'process',
        id: overrides.id ?? String(WEBSOCKIFY_PID),
        startedAt: overrides.startedAt ?? '12345678',
        cwd: '/home/u',
    },
})

function nativeDeps(overrides: {
    lease?: BrowserViewerLeaseRecord | null
    probe?: EvidenceProbeResult
    cmdline?: string | null
} = {}) {
    return {
        getViewerLease: vi.fn(async () => overrides.lease === undefined ? nativeLease() : overrides.lease),
        probeListener: vi.fn(async (_port: number, _expectedPid: number) => overrides.probe ?? processEvidence()),
        readProcessCmdline: vi.fn(async () => overrides.cmdline === undefined ? CMDLINE : overrides.cmdline),
    }
}

describe('resolveNativeViewerEvidence', () => {
    it('proves the runtime when the lease, the listening pid and its cmdline all agree', async () => {
        const deps = nativeDeps()
        const result = await resolveNativeViewerEvidence({ viewerKey: KEY_A, port: 6080 }, deps)

        expect(result).toMatchObject({ status: 'found' })
        expect(result.status === 'found' && result.evidence.kind).toBe('viewer-native')
        expect(result.status === 'found' && result.evidence.fingerprint).toMatch(/^[0-9a-f]{64}$/)
        // The lease is looked up by key, not by port.
        expect(deps.getViewerLease).toHaveBeenCalledWith(KEY_A)
        // And the listener is proven against the pid that lease named, not
        // against whichever process the port happens to resolve to — a live
        // websockify has a forked worker holding the same socket.
        expect(deps.probeListener).toHaveBeenCalledWith(6080, WEBSOCKIFY_PID)
    })

    it('looks the lease up by the requested key and refuses another key holding the port', async () => {
        // A/B on one machine: B's viewer is on 6080, A asks for its own key.
        const deps = nativeDeps({ lease: null })
        const result = await resolveNativeViewerEvidence({ viewerKey: KEY_A, port: 6080 }, deps)

        expect(result).toMatchObject({ status: 'error', code: 'VIEWER_UNKNOWN' })
        expect(deps.probeListener).not.toHaveBeenCalled()
    })

    it('reports an unreadable registry as missing evidence, not as an unknown viewer', async () => {
        // A file that could not be read says nothing about whether the viewer
        // exists; VIEWER_UNKNOWN would be a confident answer nobody earned.
        const deps = {
            getViewerLease: vi.fn(async () => { throw new Error('EACCES leases.json') }),
            probeListener: vi.fn(async (_port: number, _expectedPid: number) => processEvidence()),
            readProcessCmdline: vi.fn(async () => CMDLINE),
        }
        await expect(resolveNativeViewerEvidence({ viewerKey: KEY_A, port: 6080 }, deps))
            .resolves.toMatchObject({ status: 'error', code: 'EVIDENCE_UNAVAILABLE' })
        expect(deps.probeListener).not.toHaveBeenCalled()
    })

    it('refuses a lease record that answers for another key, before touching the port', async () => {
        const deps = nativeDeps({ lease: nativeLease({ viewerKey: KEY_B }) })
        await expect(resolveNativeViewerEvidence({ viewerKey: KEY_A, port: 6080 }, deps))
            .resolves.toMatchObject({ status: 'error', code: 'VIEWER_RUNTIME_MISMATCH' })
        expect(deps.probeListener).not.toHaveBeenCalled()
    })

    it('refuses when the lease found for the key serves a different port', async () => {
        // A holds slot 1 (6081) but the request names B's port.
        const deps = nativeDeps({ lease: nativeLease({ slot: 1, webPort: 6081, vncPort: 5901, display: ':100' }) })
        const result = await resolveNativeViewerEvidence({ viewerKey: KEY_A, port: 6080 }, deps)

        expect(result).toMatchObject({ status: 'error', code: 'VIEWER_PORT_MISMATCH' })
        expect(deps.probeListener).not.toHaveBeenCalled()
    })

    it('refuses when the pid listening on the port is not the leased websockify', async () => {
        // pid reuse, or another user's process that grabbed the port.
        const deps = nativeDeps({ probe: processEvidence({ id: '9999' }) })
        await expect(resolveNativeViewerEvidence({ viewerKey: KEY_A, port: 6080 }, deps))
            .resolves.toMatchObject({ status: 'error', code: 'VIEWER_RUNTIME_MISMATCH' })
    })

    it('changes the fingerprint when the same pid is a different process run', async () => {
        // pid reuse with a matching cmdline is exactly what start time is for.
        const before = await resolveNativeViewerEvidence({ viewerKey: KEY_A, port: 6080 }, nativeDeps())
        const after = await resolveNativeViewerEvidence(
            { viewerKey: KEY_A, port: 6080 },
            nativeDeps({ probe: processEvidence({ startedAt: '99999999' }) }),
        )
        expect(before.status === 'found' && before.evidence.fingerprint)
            .not.toBe(after.status === 'found' && after.evidence.fingerprint)
    })

    it('refuses when the listening process is not websockify for this slot', async () => {
        const deps = nativeDeps({ cmdline: ['websockify', '--web', '/w', '127.0.0.1:6080', '127.0.0.1:5999'].join('\0') })
        await expect(resolveNativeViewerEvidence({ viewerKey: KEY_A, port: 6080 }, deps))
            .resolves.toMatchObject({ status: 'error', code: 'VIEWER_RUNTIME_MISMATCH' })
    })

    it('refuses when the cmdline serves another slot web port', async () => {
        const deps = nativeDeps({ cmdline: ['websockify', '--web', '/w', '127.0.0.1:6081', '127.0.0.1:5900'].join('\0') })
        await expect(resolveNativeViewerEvidence({ viewerKey: KEY_A, port: 6080 }, deps))
            .resolves.toMatchObject({ status: 'error', code: 'VIEWER_RUNTIME_MISMATCH' })
    })

    it('refuses a lease that records no websockify pid', async () => {
        const deps = nativeDeps({ lease: nativeLease({ processIds: { xvfb: 1, x11vnc: 2 } }) })
        await expect(resolveNativeViewerEvidence({ viewerKey: KEY_A, port: 6080 }, deps))
            .resolves.toMatchObject({ status: 'error', code: 'EVIDENCE_UNAVAILABLE' })
    })

    it('refuses when a container is publishing the port of a native viewer', async () => {
        const deps = nativeDeps({
            probe: {
                status: 'found',
                evidence: { kind: 'container', id: 'abc', startedAt: 't', name: 'n', projectLabel: null },
            },
        })
        await expect(resolveNativeViewerEvidence({ viewerKey: KEY_A, port: 6080 }, deps))
            .resolves.toMatchObject({ status: 'error', code: 'VIEWER_RUNTIME_MISMATCH' })
    })

    it.each([
        [{ status: 'none' } as EvidenceProbeResult, 'NO_LISTENER'],
        [{ status: 'busy', detail: 'gate' } as EvidenceProbeResult, 'EVIDENCE_BUSY'],
        [{ status: 'ambiguous', detail: 'two' } as EvidenceProbeResult, 'EVIDENCE_UNAVAILABLE'],
        [{ status: 'unavailable', detail: 'no proc' } as EvidenceProbeResult, 'EVIDENCE_UNAVAILABLE'],
    ])('maps probe %j to %s', async (probe, code) => {
        await expect(resolveNativeViewerEvidence({ viewerKey: KEY_A, port: 6080 }, nativeDeps({ probe })))
            .resolves.toMatchObject({ status: 'error', code })
    })

    it('reports a proven not-the-owner result as a runtime mismatch, not as missing evidence', async () => {
        // The viewer prober read the fd tables and the leased pid is simply
        // not there. Calling that "unavailable" would make someone else's
        // runtime look like a retryable hiccup.
        const probe: EvidenceProbeResult = {
            status: 'ambiguous',
            detail: `${VIEWER_LISTENER_NOT_OWNED}: pid 4242 does not hold the socket listening on port 6080`,
        }
        await expect(resolveNativeViewerEvidence({ viewerKey: KEY_A, port: 6080 }, nativeDeps({ probe })))
            .resolves.toMatchObject({ status: 'error', code: 'VIEWER_RUNTIME_MISMATCH' })
    })

    it('keeps every other ambiguity as missing evidence', async () => {
        const probe: EvidenceProbeResult = { status: 'ambiguous', detail: 'two distinct inodes listen on port 6080' }
        await expect(resolveNativeViewerEvidence({ viewerKey: KEY_A, port: 6080 }, nativeDeps({ probe })))
            .resolves.toMatchObject({ status: 'error', code: 'EVIDENCE_UNAVAILABLE' })
    })

    it('refuses when the cmdline cannot be read', async () => {
        await expect(resolveNativeViewerEvidence({ viewerKey: KEY_A, port: 6080 }, nativeDeps({ cmdline: null })))
            .resolves.toMatchObject({ status: 'error', code: 'EVIDENCE_UNAVAILABLE' })
    })

    it('never starts or adopts anything while verifying', async () => {
        const deps = nativeDeps()
        await resolveNativeViewerEvidence({ viewerKey: KEY_A, port: 6080 }, deps)
        // Only read-only deps exist on the interface at all; this pins the
        // shape so a future "just restart it" cannot be added quietly.
        expect(Object.keys(deps).sort()).toEqual(['getViewerLease', 'probeListener', 'readProcessCmdline'])
    })
})

describe('resolveBrokerViewerEvidence', () => {
    const brokerLease = (overrides: Record<string, unknown> = {}) => ({
        viewerKey: KEY_A,
        webPort: 49123,
        profileVolume: 'vol',
        ready: true,
        lastUsedAt: 1,
        isolation: 'container' as const,
        runtimeFingerprint: 'container-fp-1',
        ...overrides,
    })

    it('accepts the broker fingerprint once key and port both match', async () => {
        const lookupBrokerLease = vi.fn(async () => brokerLease())
        const result = await resolveBrokerViewerEvidence({ viewerKey: KEY_A, port: 49123 }, { lookupBrokerLease })

        expect(result).toMatchObject({ status: 'found' })
        expect(result.status === 'found' && result.evidence.kind).toBe('viewer-container')
        expect(lookupBrokerLease).toHaveBeenCalledWith(KEY_A)
    })

    it('refuses a broker lease that has no verified fingerprint, without falling back', async () => {
        // An older broker, or one that could not read the container. Native
        // registry is not consulted: in broker mode it describes nothing.
        const lookupBrokerLease = vi.fn(async () => brokerLease({ runtimeFingerprint: undefined }))
        await expect(resolveBrokerViewerEvidence({ viewerKey: KEY_A, port: 49123 }, { lookupBrokerLease }))
            .resolves.toMatchObject({ status: 'error', code: 'VIEWER_EVIDENCE_UNSUPPORTED' })
    })

    it('refuses when the broker has no lease for the key', async () => {
        const lookupBrokerLease = vi.fn(async () => null)
        await expect(resolveBrokerViewerEvidence({ viewerKey: KEY_A, port: 49123 }, { lookupBrokerLease }))
            .resolves.toMatchObject({ status: 'error', code: 'VIEWER_UNKNOWN' })
    })

    it('refuses when the broker lease serves a different port', async () => {
        const lookupBrokerLease = vi.fn(async () => brokerLease({ webPort: 49999 }))
        await expect(resolveBrokerViewerEvidence({ viewerKey: KEY_A, port: 49123 }, { lookupBrokerLease }))
            .resolves.toMatchObject({ status: 'error', code: 'VIEWER_PORT_MISMATCH' })
    })

    it('refuses a lease answering for another viewer key', async () => {
        const lookupBrokerLease = vi.fn(async () => brokerLease({ viewerKey: KEY_B }))
        await expect(resolveBrokerViewerEvidence({ viewerKey: KEY_A, port: 49123 }, { lookupBrokerLease }))
            .resolves.toMatchObject({ status: 'error', code: 'VIEWER_RUNTIME_MISMATCH' })
    })

    it('surfaces a broker failure as unavailable evidence, never as success', async () => {
        const lookupBrokerLease = vi.fn(async () => { throw new Error('broker socket gone') })
        await expect(resolveBrokerViewerEvidence({ viewerKey: KEY_A, port: 49123 }, { lookupBrokerLease }))
            .resolves.toMatchObject({ status: 'error', code: 'EVIDENCE_UNAVAILABLE' })
    })

    it('separates the two evidence domains so one can never stand in for the other', async () => {
        const brokerResult = await resolveBrokerViewerEvidence(
            { viewerKey: KEY_A, port: 6080 },
            { lookupBrokerLease: vi.fn(async () => brokerLease({ webPort: 6080, runtimeFingerprint: 'x' })) },
        )
        const nativeResult = await resolveNativeViewerEvidence({ viewerKey: KEY_A, port: 6080 }, nativeDeps())
        expect(brokerResult.status === 'found' && brokerResult.evidence.fingerprint)
            .not.toBe(nativeResult.status === 'found' && nativeResult.evidence.fingerprint)
    })
})
