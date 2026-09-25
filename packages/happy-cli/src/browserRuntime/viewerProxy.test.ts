import { describe, expect, it } from 'vitest'
import { BrowserRuntimeError, type AuthContext, type InteractiveCapability, type ProfileId } from './contracts'
import { ViewerProxy } from './viewerProxy'

const PROFILE = 'profile-a' as ProfileId
const NOW = 1_000_000

function capability(overrides: Partial<InteractiveCapability> = {}): InteractiveCapability {
    return {
        kind: 'interactive', capabilityId: 'cap-1', principalId: 'p1' as never, workspaceId: 'w1' as never, machineId: 'm1' as never,
        viewerSessionId: 'viewer-1', profileId: PROFILE, operations: ['viewerTicket', 'takeOver', 'releaseControl'],
        issuedAtMs: NOW - 1_000, expiresAtMs: NOW + 240_000, ...overrides,
    }
}
const auth = (credential: AuthContext['credential']): AuthContext => ({ credential, verifiedAtMs: NOW })

function proxy(options: { now?: () => number; revoked?: Set<string> } = {}) {
    const revoked = options.revoked ?? new Set<string>()
    const now = options.now ?? (() => NOW)
    return new ViewerProxy({
        now,
        isCapabilityLive: (cap) => cap.expiresAtMs > now() && !revoked.has(cap.capabilityId),
        endpoint: (profileId) => profileId === PROFILE ? { host: '127.0.0.1', port: 1 } : undefined,
        vncPassword: 'synthpw1',
        allowedOrigins: [],
        leases: { userControl: () => ({ tabs: [], settling: false }), subscribe: () => () => undefined },
    })
}

describe('viewer tickets', () => {
    it('issues a one-time ticket that expires after 30 seconds or with the capability, whichever is first', () => {
        const viewer = proxy()
        const ticket = viewer.issueTicket(auth(capability()), { profileId: PROFILE })
        expect(ticket.expiresAtMs).toBe(NOW + 30_000)
        expect(ticket.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(viewer.consumeTicket(ticket.ticket)).toMatchObject({ profileId: PROFILE, capability: { capabilityId: 'cap-1' } })
        expect(viewer.consumeTicket(ticket.ticket)).toBeUndefined()
        const short = viewer.issueTicket(auth(capability({ expiresAtMs: NOW + 5_000 })), { profileId: PROFILE })
        expect(short.expiresAtMs).toBe(NOW + 5_000)
    })

    it('refuses an expired ticket and one whose capability was revoked after issue', () => {
        let now = NOW
        const revoked = new Set<string>()
        const viewer = proxy({ now: () => now, revoked })
        const late = viewer.issueTicket(auth(capability()), { profileId: PROFILE })
        now += 30_000
        expect(viewer.consumeTicket(late.ticket)).toBeUndefined()
        const revokedTicket = viewer.issueTicket(auth(capability({ capabilityId: 'cap-2' })), { profileId: PROFILE })
        revoked.add('cap-2')
        expect(viewer.consumeTicket(revokedTicket.ticket)).toBeUndefined()
    })

    it('requires an interactive capability with viewerTicket for exactly this profile', () => {
        const viewer = proxy()
        const denied = (a: AuthContext, profileId = PROFILE) => expect(() => viewer.issueTicket(a, { profileId })).toThrowError(BrowserRuntimeError)
        denied(auth(capability({ operations: ['takeOver'] })))
        denied(auth(capability()), 'profile-b' as ProfileId)
        denied(auth({ kind: 'agent-grant', grantId: 'g', principalId: 'p1', workspaceId: 'w1', machineId: 'm1', agentSessionId: 'a',
            profileId: PROFILE, allowedOrigins: [], operations: ['viewerTicket'], taskSpaceIds: [], issuedAtMs: NOW - 1, expiresAtMs: NOW + 1_000 } as never))
        denied(auth(capability({ expiresAtMs: NOW })))
    })

    it('reports RUNTIME_UNAVAILABLE for a profile without a viewer endpoint', () => {
        const viewer = proxy()
        const other = 'profile-b' as ProfileId
        expect(() => viewer.issueTicket(auth(capability({ profileId: other })), { profileId: other }))
            .toThrowError(expect.objectContaining({ code: 'RUNTIME_UNAVAILABLE' }))
    })
})
