import { createHmac, timingSafeEqual } from 'node:crypto'
import { BrowserRuntimeError, INTERACTIVE_OPERATIONS, POC_LIMITS, type AgentGrant, type AuthContext, type Credential, type InteractiveCapability, type Operation, type TaskSpaceId } from './contracts'
import { canonicalJson } from './policy'

export interface AuthKeys { agentKey: string | Buffer; interactiveKey: string | Buffer }
const forbiddenAgentOperations = new Set<Operation>(INTERACTIVE_OPERATIONS)
const interactiveCapabilityOperations = new Set<Operation>([
    ...INTERACTIVE_OPERATIONS,
    'cancel',
    'resume',
    'getTask',
    'subscribe',
])
const issuedAtClockSkewMs = 30_000

function sign(payload: Credential, key: string | Buffer): string {
    const body = Buffer.from(canonicalJson(payload)).toString('base64url')
    const mac = createHmac('sha256', key).update(`abp1.${body}`).digest('base64url')
    return `abp1.${body}.${mac}`
}

function validateCredential(credential: Credential, nowMs: number): void {
    const { issuedAtMs, expiresAtMs } = credential
    if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs) || issuedAtMs > nowMs + issuedAtClockSkewMs || expiresAtMs <= nowMs || expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > POC_LIMITS.maxGrantLifetimeMs) {
        throw new BrowserRuntimeError('UNAUTHORIZED', 'Credential is expired or outside its lifetime')
    }
    if (credential.kind === 'agent-grant' && credential.operations.some((operation) => forbiddenAgentOperations.has(operation))) {
        throw new BrowserRuntimeError('UNAUTHORIZED', 'Agent grant contains an interactive operation')
    }
    if (credential.kind === 'interactive' && credential.operations.some((operation) => !interactiveCapabilityOperations.has(operation))) {
        throw new BrowserRuntimeError('UNAUTHORIZED', 'Interactive capability contains a non-interactive operation')
    }
}

function mint(credential: Credential, key: string | Buffer, nowMs: number): string {
    validateCredential(credential, nowMs)
    return sign(credential, key)
}

export function mintAgentGrant(grant: AgentGrant, keys: AuthKeys, nowMs: number): string { return mint(grant, keys.agentKey, nowMs) }
export function mintInteractiveCapability(capability: InteractiveCapability, keys: AuthKeys, nowMs: number): string { return mint(capability, keys.interactiveKey, nowMs) }

export function verifyToken(token: string, keys: AuthKeys, nowMs: number, revoked: ReadonlySet<string> = new Set()): AuthContext {
    const parts = token.split('.')
    if (parts.length !== 3 || parts[0] !== 'abp1') throw new BrowserRuntimeError('UNAUTHORIZED', 'Malformed credential')
    let credential: Credential
    try { credential = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Credential } catch { throw new BrowserRuntimeError('UNAUTHORIZED', 'Malformed credential') }
    if (!credential || (credential.kind !== 'agent-grant' && credential.kind !== 'interactive')) throw new BrowserRuntimeError('UNAUTHORIZED', 'Unknown credential kind')
    const key = credential.kind === 'agent-grant' ? keys.agentKey : keys.interactiveKey
    const expected = createHmac('sha256', key).update(`abp1.${parts[1]}`).digest()
    let actual: Buffer
    try { actual = Buffer.from(parts[2], 'base64url') } catch { throw new BrowserRuntimeError('UNAUTHORIZED', 'Malformed signature') }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new BrowserRuntimeError('UNAUTHORIZED', 'Invalid credential signature')
    validateCredential(credential, nowMs)
    const revocationId = credential.kind === 'agent-grant' ? credential.grantId : credential.capabilityId
    if (revoked.has(revocationId)) throw new BrowserRuntimeError('UNAUTHORIZED', 'Credential has been revoked')
    return { credential, verifiedAtMs: nowMs }
}

export function assertOperation(auth: AuthContext, operation: Operation, expected: { principalId?: string; workspaceId?: string; machineId?: string; profileId?: string; agentSessionId?: string; taskSpaceId?: TaskSpaceId }): void {
    const credential = auth.credential
    if (!credential.operations.includes(operation)) throw new BrowserRuntimeError('SCOPE_DENIED', 'Operation is outside credential scope')
    for (const key of ['principalId', 'workspaceId', 'machineId', 'profileId'] as const) {
        if (expected[key] !== undefined && credential[key] !== expected[key]) throw new BrowserRuntimeError('SCOPE_DENIED', 'Credential scope does not match resource')
    }
    if (credential.kind === 'agent-grant') {
        if (expected.agentSessionId !== undefined && credential.agentSessionId !== expected.agentSessionId) throw new BrowserRuntimeError('SCOPE_DENIED', 'Agent session does not own task')
        if (expected.taskSpaceId && credential.taskSpaceIds.length > 0 && !credential.taskSpaceIds.includes(expected.taskSpaceId)) throw new BrowserRuntimeError('SCOPE_DENIED', 'Task space is outside grant scope')
    } else if (!interactiveCapabilityOperations.has(operation)) {
        throw new BrowserRuntimeError('SCOPE_DENIED', 'Interactive capability cannot perform agent operation')
    }
}
