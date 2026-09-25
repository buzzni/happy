/**
 * Runtime viewer (D2): the Runtime is the RFB endpoint between the human
 * viewer and the browser container's x11vnc. Human input reaches the browser
 * only through here, and only while the viewer's capability owns the profile's
 * takeover lease.
 */
import { randomBytes } from 'node:crypto'
import { assertOperation } from './auth'
import { BrowserRuntimeError, VIEWER_LIMITS, type AuthContext, type InputOwner, type InteractiveCapability, type ProfileId, type TabId,
    type ViewerTicket, type ViewerTicketRequest } from './contracts'

export interface ViewerEndpoint { host: string; port: number }

/** The part of InputLeaseManager the viewer reads. */
export interface ViewerLeaseView {
    userControl(profileId: ProfileId): { tabs: Array<{ tabId: TabId; leaseEpoch: number; owner: Extract<InputOwner, { kind: 'user' }> }>; settling: boolean }
    subscribe(listener: () => void): () => void
}

export interface ViewerProxyOptions {
    leases: ViewerLeaseView
    /** x11vnc of the profile's browser container, on the profile network. */
    endpoint(profileId: ProfileId): ViewerEndpoint | undefined
    /** Per-run x11vnc password (VNC authentication, at most 8 characters). */
    vncPassword: string
    /** Expiry and revocation, checked again on every input and every second. */
    isCapabilityLive(capability: InteractiveCapability): boolean
    /** Tunnel origins allowed besides the Runtime's own loopback origin. */
    allowedOrigins: readonly string[]
    now?: () => number
    log?: (line: string) => void
}

interface TicketEntry { capability: InteractiveCapability; profileId: ProfileId; expiresAtMs: number }

export class ViewerProxy {
    private readonly tickets = new Map<string, TicketEntry>()
    private readonly now: () => number

    constructor(private readonly options: ViewerProxyOptions) {
        this.now = options.now ?? Date.now
    }

    issueTicket(auth: AuthContext, req: ViewerTicketRequest): ViewerTicket {
        assertOperation(auth, 'viewerTicket', { profileId: req.profileId })
        const capability = auth.credential
        if (capability.kind !== 'interactive') throw new BrowserRuntimeError('SCOPE_DENIED', 'Viewer tickets need an interactive capability')
        if (!this.options.isCapabilityLive(capability)) throw new BrowserRuntimeError('UNAUTHORIZED', 'Credential has expired or been revoked')
        if (!this.options.endpoint(req.profileId)) throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'No viewer is configured for profile')
        this.sweepTickets()
        if (this.tickets.size >= VIEWER_LIMITS.maxOutstandingTickets) throw new BrowserRuntimeError('QUOTA_EXCEEDED', 'Too many outstanding viewer tickets', true)
        const ticket = randomBytes(32).toString('base64url')
        const expiresAtMs = Math.min(this.now() + VIEWER_LIMITS.ticketTtlMs, capability.expiresAtMs)
        this.tickets.set(ticket, { capability, profileId: req.profileId, expiresAtMs })
        return { ticket, expiresAtMs }
    }

    /** One use only: the ticket is gone whether or not it is still valid. */
    consumeTicket(ticket: string): { capability: InteractiveCapability; profileId: ProfileId } | undefined {
        const entry = this.tickets.get(ticket)
        this.tickets.delete(ticket)
        if (!entry || entry.expiresAtMs <= this.now() || !this.options.isCapabilityLive(entry.capability)) return undefined
        return { capability: entry.capability, profileId: entry.profileId }
    }

    private sweepTickets(): void {
        const now = this.now()
        for (const [ticket, entry] of this.tickets) if (entry.expiresAtMs <= now) this.tickets.delete(ticket)
    }
}
