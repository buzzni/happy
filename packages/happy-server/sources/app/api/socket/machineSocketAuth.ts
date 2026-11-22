type MachineLookup = {
    machine: {
        findFirst(args: {
            where: { accountId: string; id: string; workMachineExecution: { is: null } };
            select: { id: true };
        }): Promise<{ id: string } | null>;
    };
};

export async function machineSocketIdentityExists(
    db: MachineLookup,
    accountId: string,
    machineId: string,
): Promise<boolean> {
    const machine = await db.machine.findFirst({
        where: { accountId, id: machineId, workMachineExecution: { is: null } },
        select: { id: true },
    });
    return machine !== null;
}
import type { Prisma } from '@prisma/client';
import type { createWorkMachineExecutionTokenIssuer, WorkMachineExecutionClaims } from '@/app/auth/workMachineExecutionToken';
import { authorizeWorkMachineExecution, authorizeWorkMachineSession } from '@/app/machine/workMachineExecution';


type WorkMachineLookup = Pick<Prisma.TransactionClient, 'workMachineExecution' | 'session' | '$queryRaw'>;
type DaemonClaims = Extract<WorkMachineExecutionClaims, { purpose: 'daemon' }>;
type SessionClaims = Extract<WorkMachineExecutionClaims, { purpose: 'session' }>;
type WorkMachineTokens = Awaited<ReturnType<typeof createWorkMachineExecutionTokenIssuer>>;

export async function authenticateWorkMachineSocket(
    db: WorkMachineLookup,
    issuer: WorkMachineTokens | null,
    token: string,
    machineId: string,
    now: number,
): Promise<DaemonClaims | null> {
    const claims = await issuer?.verify(token, 'daemon', now);
    if (!claims || claims.purpose !== 'daemon' || claims.machineId !== machineId) return null;
    return await authorizeWorkMachineExecution(db, claims) ? claims : null;
}

export async function authenticateWorkMachineSessionSocket(
    db: WorkMachineLookup,
    issuer: WorkMachineTokens | null,
    token: string,
    sessionId: string,
    now: number,
): Promise<SessionClaims | null> {
    const claims = await issuer?.verify(token, 'session', now);
    if (!claims || claims.purpose !== 'session' || claims.sessionId !== sessionId) return null;
    return await authorizeWorkMachineSession(db, claims) ? claims : null;
}

export async function legacySessionSocketAllowed(db: WorkMachineLookup, accountId: string, sessionId: string) {
    const protectedSession = await db.session.findFirst({
        where: { id: sessionId, accountId, workMachineId: { not: null } },
        select: { id: true },
    });
    return protectedSession === null;
}

const daemonSocketEvents = new Set([
    'ping', 'machine-alive', 'machine-update-metadata', 'machine-update-state', 'rpc-register', 'rpc-unregister',
]);
// Relay handlers bind frames to the terminal or preview opened by the daemon.
const daemonRelayEvents = new Set([
    'proxy-ws-data', 'proxy-ws-close', 'terminal-frame', 'terminal-snapshot', 'terminal-frame-gap', 'terminal-closed',
]);
// The automation handler locks the generation per call and decides drain itself.
const daemonAutomationEvents = new Set([
    'automation-key-register', 'automation-sync', 'automation-sync-ack', 'automation-claim', 'automation-missed-record',
    'automation-run-start', 'automation-run-heartbeat', 'automation-conversation-deliver', 'automation-run-report',
    'session-followup-sync', 'session-followup-claim', 'session-followup-evaluate', 'session-followup-deliver',
]);
const sessionSocketEvents = new Set([
    'update-metadata', 'update-state', 'session-alive', 'session-stream', 'message', 'session-end', 'usage-report', 'provider-usage-report',
]);
const rpcTargetEvents = new Set(['rpc-register', 'rpc-unregister', 'rpc-call']);

interface MachineSocketEvent {
    accountId: string;
    socketMachineId: string | undefined;
    socketSessionId?: string;
    workMachineBrowser?: boolean;
    claims: WorkMachineExecutionClaims | null;
    event: string;
    payload: unknown;
    now: number;
}

export async function workMachineSocketMayAct(db: WorkMachineLookup, input: MachineSocketEvent): Promise<boolean> {
    const { accountId, socketMachineId, socketSessionId, workMachineBrowser, claims, event, payload, now } = input;
    const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
    let target: string | undefined;
    const isRpc = rpcTargetEvents.has(event);
    const isSessionEvent = sessionSocketEvents.has(event);
    if (isRpc) {
        const method = data?.method;
        const separator = typeof method === 'string' ? method.indexOf(':') : -1;
        target = typeof method === 'string' && separator > 0 ? method.slice(0, separator) : undefined;
    } else if (daemonSocketEvents.has(event) && typeof data?.machineId === 'string') {
        target = data.machineId;
    } else if (isSessionEvent) {
        const sid = data?.sid ?? data?.sessionId;
        target = typeof sid === 'string' ? sid : undefined;
    }

    if (claims) {
        if (claims.accountId !== accountId || claims.expiresAt <= now) return false;
        if (claims.purpose === 'daemon') {
            if (claims.machineId === socketMachineId && (daemonRelayEvents.has(event) || daemonAutomationEvents.has(event))) {
                return authorizeWorkMachineExecution(db, claims);
            }
            if (claims.machineId !== socketMachineId || !daemonSocketEvents.has(event)) return false;
            return (event === 'ping' || target === claims.machineId) && authorizeWorkMachineExecution(db, claims);
        }
        if (claims.sessionId !== socketSessionId) return false;
        if (event === 'ping') return authorizeWorkMachineSession(db, claims);
        if (event === 'rpc-call' || (!isRpc && !isSessionEvent) || target !== claims.sessionId) return false;
        return authorizeWorkMachineSession(db, claims);
    }

    const machineIds = [...new Set([socketMachineId, isSessionEvent ? undefined : target].filter((id): id is string => !!id))];
    const sessionIds = [...new Set([socketSessionId, isSessionEvent || isRpc ? target : undefined].filter((id): id is string => !!id))];
    const protectedMachine = machineIds.length > 0 && await db.workMachineExecution.findFirst({
        where: { accountId, machineId: { in: machineIds } }, select: { machineId: true, frozenAt: true },
    });
    const protectedSession = sessionIds.length > 0 && await db.session.findFirst({
        where: { accountId, id: { in: sessionIds }, workMachineId: { not: null } },
        select: { workMachineExecution: { select: { frozenAt: true } } },
    });
    if (!protectedMachine && !protectedSession) return true;
    return workMachineBrowser === true && !socketMachineId && !socketSessionId && event === 'rpc-call'
        && (!protectedMachine || protectedMachine.frozenAt === null)
        && (!protectedSession || protectedSession.workMachineExecution?.frozenAt === null);
}
