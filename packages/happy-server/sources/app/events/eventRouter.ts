import { db } from "@/storage/db";
import { Server, Socket } from "socket.io";
import { log } from "@/utils/log";
import { GitHubProfile } from "@/app/api/types";
import { AccountProfile } from "@/types";
import { getPublicUrl } from "@/storage/files";
import { isAutomationExecutionSessionId, type SessionMessageContent } from "@slopus/happy-wire";
import { hasActiveUserScopedSocketIn, userScopedRoom } from "@/app/events/hasActiveUserScopedSocket";
import { deliverManagedSession } from "@/app/api/socket/managed/managedDelivery";

// === CONNECTION TYPES ===

export interface SessionScopedConnection {
    connectionType: 'session-scoped';
    socket: Socket;
    userId: string;
    sessionId: string;
    happyClient?: string;
}

export interface UserScopedConnection {
    connectionType: 'user-scoped';
    socket: Socket;
    userId: string;
    happyClient?: string;
    /**
     * Opened only to send (RPC calls, a terminal relay, a title write). Keeps
     * every user-scoped handler but never joins the user-scoped fan-out room,
     * so nothing addressed to `user-scoped-only` / `all-interested-in-session`
     * reaches it and it does not count as a human watching a screen. It still
     * joins the account room `user:{id}`, so an emit with the default
     * `all-user-authenticated-connections` filter would reach it. Opt-in by the
     * client handshake; older clients and servers keep today's behaviour.
     */
    transportOnly?: true;
}

export interface MachineScopedConnection {
    connectionType: 'machine-scoped';
    socket: Socket;
    userId: string;
    machineId: string;
    happyClient?: string;
}

export type ClientConnection = SessionScopedConnection | UserScopedConnection | MachineScopedConnection;

// === RECIPIENT FILTER TYPES ===

export type RecipientFilter =
    | { type: 'all-interested-in-session'; sessionId: string }
    | { type: 'user-scoped-only' }
    /** Human clients plus the servers watching this session's stream (`watchSessionStream`). */
    | { type: 'session-stream'; sessionId: string }
    | { type: 'machine-scoped-only'; machineId: string }  // For update-machine: sends to user-scoped + only the specific machine
    | { type: 'all-user-authenticated-connections' };

// === UPDATE EVENT TYPES (Persistent) ===

export type UpdateEvent = {
    type: 'new-message';
    sessionId: string;
    message: {
        id: string;
        seq: number;
        content: SessionMessageContent;
        localId: string | null;
        createdAt: number;
        updatedAt: number;
    }
} | {
    type: 'new-session';
    sessionId: string;
    seq: number;
    metadata: string;
    metadataVersion: number;
    agentState: string | null;
    agentStateVersion: number;
    dataEncryptionKey: string | null;
    active: boolean;
    activeAt: number;
    createdAt: number;
    updatedAt: number;
} | {
    type: 'update-session';
    sessionId: string;
    metadata?: {
        value: string | null;
        version: number;
    } | null | undefined;
    agentState?: {
        value: string | null;
        version: number;
    } | null | undefined;
} | {
    type: 'update-account';
    userId: string;
    settings?: {
        value: string | null;
        version: number;
    } | null | undefined;
    github?: GitHubProfile | null | undefined;
} | {
    type: 'new-machine';
    machineId: string;
    seq: number;
    metadata: string;
    metadataVersion: number;
    daemonState: string | null;
    daemonStateVersion: number;
    dataEncryptionKey: string | null;
    active: boolean;
    activeAt: number;
    createdAt: number;
    updatedAt: number;
} | {
    type: 'update-machine';
    machineId: string;
    metadata?: {
        value: string;
        version: number;
    };
    daemonState?: {
        value: string;
        version: number;
    };
    activeAt?: number;
} | {
    type: 'delete-machine';
    machineId: string;
} | {
    type: 'new-artifact';
    artifactId: string;
    seq: number;
    header: string;
    headerVersion: number;
    body: string;
    bodyVersion: number;
    dataEncryptionKey: string | null;
    createdAt: number;
    updatedAt: number;
} | {
    type: 'update-artifact';
    artifactId: string;
    header?: {
        value: string;
        version: number;
    };
    body?: {
        value: string;
        version: number;
    };
} | {
    type: 'delete-artifact';
    artifactId: string;
} | {
    type: 'delete-session';
    sessionId: string;
} | {
    type: 'relationship-updated';
    uid: string;
    status: 'none' | 'requested' | 'pending' | 'friend' | 'rejected';
    timestamp: number;
} | {
    type: 'new-feed-post';
    id: string;
    body: any;
    cursor: string;
    createdAt: number;
} | {
    type: 'kv-batch-update';
    changes: Array<{
        key: string;
        value: string | null; // null indicates deletion
        version: number; // -1 for deleted keys
    }>;
} | {
    type: 'automation-updated';
    projectId: string | null;
    automationId?: string;
    runId?: string;
    revision?: number;
    generation?: number;
    reason: 'viewer-key' | 'machine-key' | 'upsert' | 'delete' | 'sync' | 'run';
};

// === EPHEMERAL EVENT TYPES (Transient) ===

export type EphemeralEvent = {
    type: 'activity';
    id: string;
    active: boolean;
    activeAt: number;
    thinking?: boolean;
    reason?: 'session-socket-disconnected' | 'archived';
} | {
    type: 'machine-activity';
    id: string;
    active: boolean;
    activeAt: number;
} | {
    type: 'usage';
    id: string;
    key: string;
    tokens: Record<string, number>;
    cost: Record<string, number> | null;
    timestamp: number;
    sourceEventId?: string;
} | {
    type: 'machine-status';
    machineId: string;
    online: boolean;
    timestamp: number;
} | {
    // Token-level assistant preview relayed from the CLI. `data` is an
    // opaque session-key ciphertext; the server neither stores nor reads it.
    type: 'stream';
    id: string;
    time: number;
    data: string;
} | {
    type: 'session-event';
    sessionId: string;
    kind: 'done' | 'permission' | 'question';
    title: string;
    body: string;
    timestamp: number;
};

const SESSION_EVENT_IDENTITIES = {
    'new-message': 'sid',
    'new-session': 'id',
    'update-session': 'id',
    'update-account': null,
    'new-machine': null,
    'update-machine': null,
    'delete-machine': null,
    'new-artifact': null,
    'update-artifact': null,
    'delete-artifact': null,
    'delete-session': 'sid',
    'relationship-updated': null,
    'new-feed-post': null,
    'kv-batch-update': null,
    'automation-updated': null,
    'activity': 'id',
    'machine-activity': null,
    'usage': 'id',
    'machine-status': null,
    'stream': 'id',
    'session-event': 'sessionId',
} satisfies Record<UpdateEvent['type'] | EphemeralEvent['type'], 'id' | 'sid' | 'sessionId' | null>;

// === EVENT PAYLOAD TYPES ===

export interface UpdatePayload {
    id: string;
    seq: number;
    body: {
        t: UpdateEvent['type'];
        [key: string]: any;
    };
    createdAt: number;
}

export interface EphemeralPayload {
    type: EphemeralEvent['type'];
    [key: string]: any;
}

// === EVENT ROUTER CLASS ===

class EventRouter {
    private io!: Server;
    private deliveryDepth = new Map<string, number>();
    private deliveryTails = new Map<string, Promise<void>>();
    private protection = new Map<string, boolean>();
    private userConnections = new Map<string, Set<ClientConnection>>();

    // === INITIALIZATION ===

    init(io: Server): void {
        this.io = io;
    }

    /**
     * The managed socket server, when the deployment has one.
     *
     * Managed sockets are in none of the rooms below, so room fan-out reaches
     * them not at all; they are addressed explicitly in `emit`. Keeping them
     * out of the rooms is what makes the grant check possible — room delivery
     * happens inside the adapter, past any point a check could sit.
     */
    initManaged(io: Server | null): void {
        this.managedIo = io;
    }

    private managedIo: Server | null = null;

    // === CONNECTION MANAGEMENT (via Socket.IO rooms) ===

    addConnection(userId: string, connection: ClientConnection): void {
        const scope = connection.connectionType === 'session-scoped' ? connection.sessionId
            : connection.connectionType === 'machine-scoped' ? connection.machineId : undefined;
        // Recovery can bypass auth middleware and restore old socket data/rooms.
        // Disconnect invalid restored memberships before registering any receiver.
        if ((scope !== undefined && (typeof scope !== 'string' || scope.includes(':')))
            || (connection.socket.data?.managedDaemon && connection.socket.data?.piiProtectionVersion === 1)) {
            connection.socket.disconnect(true);
            return;
        }

        if (!this.userConnections.has(userId)) {
            this.userConnections.set(userId, new Set());
        }
        this.userConnections.get(userId)!.add(connection);

        const socket = connection.socket;
        const joinRoom = (room: string) => {
            socket.join(room);
            if (socket.data?.piiProtectionVersion === 1) socket.join(`${room}:pii-v1`);
        };
        joinRoom(`user:${userId}`);

        switch (connection.connectionType) {
            case 'user-scoped':
                if (!connection.transportOnly) joinRoom(userScopedRoom(userId));
                break;
            case 'session-scoped':
                joinRoom(`user:${userId}:session:${connection.sessionId}`);
                break;
            case 'machine-scoped':
                joinRoom(`user:${userId}:machine:${connection.machineId}`);
                break;
        }
    }

    /**
     * A transport-only server socket reads one session's stream (aplus-dev-studio specs/agent-app-api: an agent-app
     * turn relays the answer as it is written). It joins that session's watch room, never the user-scoped room: there
     * it would count as a human watching and hold back the account's push notifications.
     */
    watchSessionStream(userId: string, socket: Socket, sessionId: string): void {
        const room = sessionStreamWatchRoom(userId, sessionId);
        socket.join(room);
        if (socket.data?.piiProtectionVersion === 1) socket.join(`${room}:pii-v1`);
    }

    removeConnection(userId: string, connection: ClientConnection): void {
        const connections = this.userConnections.get(userId);
        if (connections) {
            connections.delete(connection);
            if (connections.size === 0) {
                this.userConnections.delete(userId);
            }
        }
        // Socket.IO automatically removes sockets from all rooms on disconnect
    }

    getConnections(userId: string): Set<ClientConnection> | undefined {
        return this.userConnections.get(userId);
    }

    /**
     * The Socket.IO server, for cross-replica room queries.
     *
     * Prefer this over `getConnections()` when resolving another endpoint's
     * socket: `userConnections` is process-local, so with replicas >= 2 it only
     * sees clients attached to *this* pod (specs/relay-cross-replica-routing).
     */
    get server(): Server {
        return this.io;
    }

    // === EVENT EMISSION METHODS ===

    emitUpdate(params: {
        userId: string;
        payload: UpdatePayload;
        sessionProtection?: boolean;
        recipientFilter?: RecipientFilter;
        skipSenderConnection?: ClientConnection;
    }): void {
        this.emit({
            userId: params.userId,
            eventName: 'update',
            sessionProtection: params.sessionProtection,
            payload: params.payload,
            recipientFilter: params.recipientFilter || { type: 'all-user-authenticated-connections' },
            skipSenderConnection: params.skipSenderConnection
        });
    }

    emitEphemeral(params: {
        userId: string;
        payload: EphemeralPayload;
        sessionProtection?: boolean;
        recipientFilter?: RecipientFilter;
        skipSenderConnection?: ClientConnection;
    }): void {
        this.emit({
            userId: params.userId,
            eventName: 'ephemeral',
            sessionProtection: params.sessionProtection,
            payload: params.payload,
            recipientFilter: params.recipientFilter || { type: 'all-user-authenticated-connections' },
            skipSenderConnection: params.skipSenderConnection
        });
    }

    // === PRESENCE QUERIES ===

    /**
     * Returns true if the user has a human-facing client (web-ui, mobile,
     * desktop) connected and not backgrounded. See
     * hasActiveUserScopedSocketIn for why session-scoped (CLI/agent) and
     * machine-scoped (daemon) sockets don't count.
     */
    async hasActiveUserScopedSocket(userId: string, piiProtection = false): Promise<boolean> {
        return hasActiveUserScopedSocketIn(this.io, userId, piiProtection);
    }

    async hasMachineSocket(userId: string, machineId: string): Promise<boolean> {
        const sockets = await this.io.in(`user:${userId}:machine:${machineId}`).fetchSockets();
        return sockets.some(s => s.data.clientType === 'machine-scoped' && s.data.machineId === machineId);
    }

    // === PRIVATE ROUTING LOGIC ===

    private getRoomsForFilter(userId: string, filter: RecipientFilter): string[] {
        switch (filter.type) {
            case 'all-user-authenticated-connections':
                return [`user:${userId}`];
            case 'user-scoped-only':
                return [userScopedRoom(userId)];
            case 'session-stream':
                return [userScopedRoom(userId), sessionStreamWatchRoom(userId, filter.sessionId)];
            case 'all-interested-in-session':
                // Union: session watchers + user-scoped (Socket.IO deduplicates)
                return [`user:${userId}:session:${filter.sessionId}`, userScopedRoom(userId)];
            case 'machine-scoped-only':
                // Union: specific machine + user-scoped
                return [`user:${userId}:machine:${filter.machineId}`, userScopedRoom(userId)];
        }
    }

    private emit(params: Parameters<EventRouter['deliver']>[0]): void {
        const body = params.eventName === 'update' ? params.payload.body : params.payload;
        const kind = params.eventName === 'update' ? body?.t : body?.type;
        if (!Object.prototype.hasOwnProperty.call(SESSION_EVENT_IDENTITIES, kind)) return;
        const field = SESSION_EVENT_IDENTITIES[kind as keyof typeof SESSION_EVENT_IDENTITIES];
        const sessionId = params.recipientFilter.type === 'all-interested-in-session' ? params.recipientFilter.sessionId : field ? body[field] : undefined;
        if (field && typeof sessionId !== 'string') return;
        const key = typeof sessionId === 'string' ? JSON.stringify([params.userId, sessionId]) : undefined;
        const remember = (value: boolean) => {
            if (!key) return;
            if (this.protection.size >= 10000) this.protection.delete(this.protection.keys().next().value!);
            this.protection.set(key, value);
        };
        const known = params.sessionProtection ?? (key ? this.protection.get(key) : false);
        if (known !== undefined && !this.deliveryTails.has(params.userId)) {
            remember(known);
            this.deliver({ ...params, sessionProtection: known });
            return;
        }
        // Bound retained stream payloads while an uncertain DB lookup is pending.
        const depth = this.deliveryDepth.get(params.userId) ?? 0;
        if (depth >= 256) { log({ module: 'pii-session-delivery' }, 'Session delivery withheld: queue limit'); return; }
        this.deliveryDepth.set(params.userId, depth + 1);
        const prior = this.deliveryTails.get(params.userId) ?? Promise.resolve();
        const next = prior.then(async () => {
            let protectedSession = known ?? (key ? this.protection.get(key) : false);
            if (protectedSession === undefined) {
                for (let attempt = 0; attempt < 2; attempt++) {
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    try {
                        const row = await Promise.race([
                            db.session.findFirst({ where: { id: sessionId, accountId: params.userId }, select: { piiProtection: true } }),
                            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('protection unavailable')), 2000); }),
                        ]);
                        protectedSession = row?.piiProtection !== false;
                        if (row) remember(protectedSession);
                        break;
                    } catch { if (attempt === 1) throw new Error('protection unavailable'); }
                    finally { clearTimeout(timer); }
                }
            } else remember(protectedSession);
            this.deliver({ ...params, sessionProtection: protectedSession });
        }).catch(() => { log({ module: 'pii-session-delivery' }, 'Session delivery withheld: protection unavailable'); });
        this.deliveryTails.set(params.userId, next);
        void next.then(() => {
            const remaining = (this.deliveryDepth.get(params.userId) ?? 1) - 1;
            if (remaining) this.deliveryDepth.set(params.userId, remaining); else this.deliveryDepth.delete(params.userId);
            if (this.deliveryTails.get(params.userId) === next) this.deliveryTails.delete(params.userId);
        });
    }

    private deliver(params: {
        userId: string;
        eventName: 'update' | 'ephemeral';
        sessionProtection?: boolean;
        payload: any;
        recipientFilter: RecipientFilter;
        skipSenderConnection?: ClientConnection;
    }): void {
        const body = params.payload?.body;
        const sessionId = params.eventName === 'update'
            ? body?.sid ?? body?.sessionId ?? (['new-session', 'update-session'].includes(body?.t) ? body?.id : undefined)
            : params.payload?.sessionId ?? (['activity', 'stream', 'usage'].includes(params.payload?.type) ? params.payload?.id : undefined);
        const internal = isAutomationExecutionSessionId(sessionId);
        // A run owns this session. Ordinary clients read its result through the
        // authorized run projection; generic fan-out must not create another chat.
        const rooms = (internal ? [`user:${params.userId}:session:${sessionId}`]
            : this.getRoomsForFilter(params.userId, params.recipientFilter))
            .map(room => params.sessionProtection ? `${room}:pii-v1` : room);

        // Managed children of this session, addressed explicitly. Each packet
        // is released by the replica holding the socket, after that replica
        // re-reads the grant.
        const managedSessionId = internal ? sessionId
            : params.recipientFilter.type === 'all-interested-in-session' ? params.recipientFilter.sessionId : null;
        if (!params.sessionProtection && managedSessionId) {
            deliverManagedSession(this.managedIo, {
                sessionId: managedSessionId,
                accountId: params.userId,
                event: params.eventName,
                args: [params.payload],
            });
        }

        const target = params.skipSenderConnection ? params.skipSenderConnection.socket.broadcast.to(rooms) : this.io.to(rooms);
        target.emit(params.eventName, params.payload);
    }
}

export const eventRouter = new EventRouter();

export function sessionStreamWatchRoom(userId: string, sessionId: string): string {
    return `user:${userId}:session-stream:${sessionId}`;
}

// === EVENT BUILDER FUNCTIONS ===

export function buildNewSessionUpdate(session: {
    piiProtection?: boolean;
    piiMode?: string;
    id: string;
    seq: number;
    metadata: string;
    metadataVersion: number;
    agentState: string | null;
    agentStateVersion: number;
    dataEncryptionKey: Uint8Array | null;
    active: boolean;
    lastActiveAt: Date;
    createdAt: Date;
    updatedAt: Date;
}, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'new-session',
            ...(session.piiProtection ? { piiProtection: true, piiMode: session.piiMode ?? 'isolated' } : {}),
            id: session.id,
            seq: session.seq,
            metadata: session.metadata,
            metadataVersion: session.metadataVersion,
            agentState: session.agentState,
            agentStateVersion: session.agentStateVersion,
            dataEncryptionKey: session.dataEncryptionKey ? Buffer.from(session.dataEncryptionKey).toString('base64') : null,
            active: session.active,
            activeAt: session.lastActiveAt.getTime(),
            createdAt: session.createdAt.getTime(),
            updatedAt: session.updatedAt.getTime()
        },
        createdAt: Date.now()
    };
}

export function buildNewMessageUpdate(message: {
    id: string;
    seq: number;
    content: SessionMessageContent;
    localId: string | null;
    createdAt: Date;
    updatedAt: Date;
}, sessionId: string, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'new-message',
            sid: sessionId,
            message: {
                id: message.id,
                seq: message.seq,
                content: message.content,
                localId: message.localId,
                createdAt: message.createdAt.getTime(),
                updatedAt: message.updatedAt.getTime()
            }
        },
        createdAt: Date.now()
    };
}

export function buildUpdateSessionUpdate(sessionId: string, updateSeq: number, updateId: string, metadata?: { value: string; version: number }, agentState?: { value: string; version: number }): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'update-session',
            id: sessionId,
            metadata,
            agentState
        },
        createdAt: Date.now()
    };
}

export function buildDeleteSessionUpdate(sessionId: string, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'delete-session',
            sid: sessionId
        },
        createdAt: Date.now()
    };
}

export function buildUpdateAccountUpdate(userId: string, profile: Partial<AccountProfile>, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'update-account',
            id: userId,
            ...profile,
            avatar: profile.avatar ? { ...profile.avatar, url: getPublicUrl(profile.avatar.path) } : undefined
        },
        createdAt: Date.now()
    };
}

export function buildNewMachineUpdate(machine: {
    id: string;
    seq: number;
    metadata: string;
    metadataVersion: number;
    daemonState: string | null;
    daemonStateVersion: number;
    dataEncryptionKey: Uint8Array | null;
    active: boolean;
    lastActiveAt: Date;
    createdAt: Date;
    updatedAt: Date;
}, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'new-machine',
            machineId: machine.id,
            seq: machine.seq,
            metadata: machine.metadata,
            metadataVersion: machine.metadataVersion,
            daemonState: machine.daemonState,
            daemonStateVersion: machine.daemonStateVersion,
            dataEncryptionKey: machine.dataEncryptionKey ? Buffer.from(machine.dataEncryptionKey).toString('base64') : null,
            active: machine.active,
            activeAt: machine.lastActiveAt.getTime(),
            createdAt: machine.createdAt.getTime(),
            updatedAt: machine.updatedAt.getTime()
        },
        createdAt: Date.now()
    };
}

export function buildUpdateMachineUpdate(machineId: string, updateSeq: number, updateId: string, metadata?: { value: string; version: number }, daemonState?: { value: string; version: number }): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'update-machine',
            machineId,
            metadata,
            daemonState
        },
        createdAt: Date.now()
    };
}

export function buildDeleteMachineUpdate(machineId: string, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'delete-machine',
            machineId
        },
        createdAt: Date.now()
    };
}

export function buildSessionActivityEphemeral(
    sessionId: string,
    active: boolean,
    activeAt: number,
    thinking?: boolean,
    reason?: 'session-socket-disconnected' | 'archived',
): EphemeralPayload {
    const payload: EphemeralPayload = {
        type: 'activity',
        id: sessionId,
        active,
        activeAt,
        thinking: thinking || false
    };
    if (reason) {
        payload.reason = reason;
    }
    return payload;
}

export function buildMachineActivityEphemeral(machineId: string, active: boolean, activeAt: number): EphemeralPayload {
    return {
        type: 'machine-activity',
        id: machineId,
        active,
        activeAt
    };
}

export function buildUsageEphemeral(
    sessionId: string,
    key: string,
    tokens: Record<string, number>,
    cost: Record<string, number> | null,
    sourceEventId?: string,
): EphemeralPayload {
    return {
        type: 'usage',
        id: sessionId,
        key,
        tokens,
        cost,
        timestamp: Date.now(),
        ...(sourceEventId ? { sourceEventId } : {}),
    };
}

export function buildMachineStatusEphemeral(machineId: string, online: boolean): EphemeralPayload {
    return {
        type: 'machine-status',
        machineId,
        online,
        timestamp: Date.now()
    };
}

/**
 * Session-level lifecycle event (Claude finished, needs permission, asks question).
 * Emitted alongside the mobile push so other clients (e.g. web) can surface a
 * tab-title counter or inline indicator without parsing every encrypted message.
 */
export function buildSessionEventEphemeral(sessionId: string, kind: 'done' | 'permission' | 'question', title: string, body: string): EphemeralPayload {
    return {
        type: 'session-event',
        sessionId,
        kind,
        title,
        body,
        timestamp: Date.now()
    };
}

export function buildNewArtifactUpdate(artifact: {
    id: string;
    seq: number;
    header: Uint8Array;
    headerVersion: number;
    body: Uint8Array;
    bodyVersion: number;
    dataEncryptionKey: Uint8Array;
    createdAt: Date;
    updatedAt: Date;
}, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'new-artifact',
            artifactId: artifact.id,
            seq: artifact.seq,
            header: Buffer.from(artifact.header).toString('base64'),
            headerVersion: artifact.headerVersion,
            body: Buffer.from(artifact.body).toString('base64'),
            bodyVersion: artifact.bodyVersion,
            dataEncryptionKey: Buffer.from(artifact.dataEncryptionKey).toString('base64'),
            createdAt: artifact.createdAt.getTime(),
            updatedAt: artifact.updatedAt.getTime()
        },
        createdAt: Date.now()
    };
}

export function buildUpdateArtifactUpdate(artifactId: string, updateSeq: number, updateId: string, header?: { value: string; version: number }, body?: { value: string; version: number }): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'update-artifact',
            artifactId,
            header,
            body
        },
        createdAt: Date.now()
    };
}

export function buildDeleteArtifactUpdate(artifactId: string, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'delete-artifact',
            artifactId
        },
        createdAt: Date.now()
    };
}

export function buildRelationshipUpdatedEvent(
    data: {
        uid: string;
        status: 'none' | 'requested' | 'pending' | 'friend' | 'rejected';
        timestamp: number;
    },
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'relationship-updated',
            ...data
        },
        createdAt: Date.now()
    };
}

export function buildNewFeedPostUpdate(feedItem: {
    id: string;
    body: any;
    cursor: string;
    createdAt: number;
}, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'new-feed-post',
            id: feedItem.id,
            body: feedItem.body,
            cursor: feedItem.cursor,
            createdAt: feedItem.createdAt
        },
        createdAt: Date.now()
    };
}

export function buildKVBatchUpdateUpdate(
    changes: Array<{ key: string; value: string | null; version: number }>,
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'kv-batch-update',
            changes
        },
        createdAt: Date.now()
    };
}

export function buildAutomationUpdate(
    data: {
        projectId: string | null;
        automationId?: string;
        runId?: string;
        revision?: number;
        generation?: number;
        reason: 'viewer-key' | 'machine-key' | 'upsert' | 'delete' | 'sync' | 'run';
    },
    updateSeq: number,
    updateId: string,
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: { t: 'automation-updated', ...data },
        createdAt: Date.now(),
    };
}
