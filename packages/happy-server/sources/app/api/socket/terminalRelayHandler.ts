/**
 * Server-side relay for the remote terminal feature
 * (specs/remote-terminal/ Phase 2). Forwards opaque, end-to-end-encrypted
 * frames between the client (web-ui xterm panel) and the daemon (PTY on
 * the user's machine). The server never sees plaintext stdin/stdout — the
 * `data` field of every frame is encrypted at the originating endpoint
 * with the user's existing rpc-call secret key.
 *
 * Wire shape:
 *   client → server: 'terminal-open'   { machineId, params }, ack
 *   server → daemon: 'terminal-open-fwd' { sessionId, params }, ack
 *   client → server: 'terminal-frame'  { sessionId, data }
 *   client → server: 'terminal-resize' { sessionId, cols, rows }
 *   client → server: 'terminal-close'  { sessionId }
 *   daemon → server: 'terminal-frame'  { sessionId, data }
 *   daemon → server: 'terminal-closed' { sessionId, code, signal }
 *
 * The same handler is registered on every socket; direction is inferred
 * from whether the originating socket's id matches `clientSocketId` or
 * `daemonSocketId` of the resolved session. Both endpoints may live on
 * different replicas, so routing goes through `io.to(socketId)` and the
 * session registry is shared — see specs/relay-cross-replica-routing.
 *
 * ACL: terminal-open succeeds only if the caller's userId already has a
 * machine-scoped daemon socket connected for the requested machineId.
 * This is the same trust boundary as today's rpc-call routing — a
 * different user's terminal request lands at "Machine not connected for
 * this user" and never reaches the daemon.
 */

import { Socket } from 'socket.io';
import { eventRouter } from '@/app/events/eventRouter';
import {
    findMachineSockets as findMachineSocketsCrossReplica,
    newestMachineSocket,
} from '@/app/events/findMachineSockets';
import { log } from '@/utils/log';
import { randomUUID } from 'node:crypto';
import {
    addTerminalSession,
    getTerminalSession,
    removeTerminalSession,
    findTerminalSessionsBySocketId,
    countActiveSessionsForUser,
    MAX_TERMINALS_PER_USER,
} from './terminalSessions';

const TERMINAL_OPEN_TIMEOUT_MS = 10_000;

/**
 * Every socket is auto-joined to a room named after its own id, so addressing
 * a room by socket id reaches that socket on whichever replica owns it
 * (specs/relay-cross-replica-routing). Replaces holding a Socket object,
 * which only works when both endpoints are on the same process.
 */
function emitToSocket(socketId: string, event: string, payload: unknown): void {
    eventRouter.server.to(socketId).emit(event, payload);
}

// Resolves the daemon socket across replicas via the machine room, then picks
// the newest one (see newestMachineSocket for why "newest" matters).
//
// previewRoutes.ts hits the same reconnect race but answers it differently: it
// fans out to every live socket and takes the first response (Promise.any).
// That is safe for an idempotent HTTP proxy hop; terminal-open spawns a PTY,
// so fanning out would leak duplicate shells. Pick one socket here.
async function findMachineSocket(userId: string, machineId: string) {
    const { sockets, degraded } = await findMachineSocketsCrossReplica(
        eventRouter.server,
        userId,
        machineId,
    );
    return { socket: newestMachineSocket(sockets), degraded };
}

export function terminalRelayHandler(userId: string, socket: Socket): void {
    socket.on('terminal-open', async (data: any, ack?: (response: any) => void) => {
        const reply = (resp: any) => { if (typeof ack === 'function') ack(resp); };
        try {
            const machineId = data?.machineId;
            if (!machineId || typeof machineId !== 'string') {
                reply({ ok: false, error: 'machineId is required' });
                return;
            }

            if (await countActiveSessionsForUser(userId) >= MAX_TERMINALS_PER_USER) {
                reply({ ok: false, error: 'Too many active terminals' });
                return;
            }

            const { socket: daemonSocket, degraded } = await findMachineSocket(userId, machineId);
            if (!daemonSocket) {
                // `degraded` means the cross-replica lookup itself failed, so we
                // do not know whether the daemon is there. Same user-facing
                // error, distinct log line — conflating the two is what made the
                // 2026-08-07 cluster-bus outage read as mass daemon disconnects.
                if (degraded) {
                    log({ module: 'terminal-relay', level: 'error' },
                        `terminal-open lookup degraded user=${userId} machine=${machineId} — cluster bus did not answer`);
                }
                reply({ ok: false, error: 'Machine not connected for this user' });
                return;
            }

            const sessionId = randomUUID();
            let daemonAck: unknown;
            try {
                daemonAck = await daemonSocket
                    .timeout(TERMINAL_OPEN_TIMEOUT_MS)
                    .emitWithAck('terminal-open-fwd', {
                        sessionId,
                        params: data?.params ?? null,
                    });
            } catch (err) {
                log({ module: 'terminal-relay', level: 'error' }, `terminal-open-fwd timeout: ${(err as Error).message}`);
                reply({ ok: false, error: 'Daemon did not acknowledge terminal-open in time' });
                return;
            }

            const ackResp = daemonAck as { ok?: boolean; error?: string } | null | undefined;
            if (!ackResp || ackResp.ok !== true) {
                reply({ ok: false, error: ackResp?.error ?? 'Daemon failed to open terminal' });
                return;
            }

            await addTerminalSession({
                id: sessionId,
                userId,
                machineId,
                clientSocketId: socket.id,
                daemonSocketId: daemonSocket.id,
                createdAt: Date.now(),
            });
            log({ module: 'terminal-relay' }, `[REMOTE-TERMINAL] open user=${userId} machine=${machineId} session=${sessionId}`);
            reply({ ok: true, sessionId });
        } catch (e) {
            log({ module: 'terminal-relay', level: 'error' }, `terminal-open error: ${(e as Error).message}`);
            reply({ ok: false, error: 'Internal error' });
        }
    });

    socket.on('terminal-frame', async (data: any) => {
        const session = await getTerminalSession(data?.sessionId);
        if (!session) return;
        // Direction is inferred from the source socket. Drop frames whose
        // source is not part of the session pair — defends against a
        // confused-deputy where a third socket guesses a sessionId.
        if (socket.id === session.clientSocketId) {
            emitToSocket(session.daemonSocketId, 'terminal-frame-fwd', {
                sessionId: session.id,
                data: data?.data,
            });
        } else if (socket.id === session.daemonSocketId) {
            emitToSocket(session.clientSocketId, 'terminal-frame', {
                sessionId: session.id,
                data: data?.data,
            });
        }
    });

    socket.on('terminal-resize', async (data: any) => {
        const session = await getTerminalSession(data?.sessionId);
        if (!session || socket.id !== session.clientSocketId) return;
        const cols = Number(data?.cols);
        const rows = Number(data?.rows);
        if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return;
        emitToSocket(session.daemonSocketId, 'terminal-resize-fwd', {
            sessionId: session.id,
            cols,
            rows,
        });
    });

    socket.on('terminal-close', async (data: any) => {
        const session = await getTerminalSession(data?.sessionId);
        if (!session) return;
        if (socket.id !== session.clientSocketId && socket.id !== session.daemonSocketId) return;
        if (socket.id === session.clientSocketId) {
            emitToSocket(session.daemonSocketId, 'terminal-close-fwd', { sessionId: session.id });
        }
        await removeTerminalSession(session.id);
        log({ module: 'terminal-relay' }, `[REMOTE-TERMINAL] close session=${session.id} (explicit)`);
    });

    socket.on('terminal-closed', async (data: any) => {
        // Daemon-originated close (PTY exited).
        const session = await getTerminalSession(data?.sessionId);
        if (!session || socket.id !== session.daemonSocketId) return;
        emitToSocket(session.clientSocketId, 'terminal-closed', {
            sessionId: session.id,
            code: data?.code,
            signal: data?.signal,
        });
        await removeTerminalSession(session.id);
        log({ module: 'terminal-relay' }, `[REMOTE-TERMINAL] close session=${session.id} exit=${data?.code} signal=${data?.signal}`);
    });

    socket.on('disconnect', async () => {
        const sessions = await findTerminalSessionsBySocketId(socket.id);
        if (sessions.length === 0) return;
        for (const session of sessions) {
            try {
                if (socket.id === session.clientSocketId) {
                    emitToSocket(session.daemonSocketId, 'terminal-close-fwd', { sessionId: session.id });
                } else if (socket.id === session.daemonSocketId) {
                    emitToSocket(session.clientSocketId, 'terminal-closed', {
                        sessionId: session.id,
                        code: -1,
                        signal: null,
                        reason: 'daemon-disconnected',
                    });
                }
            } catch {
                /* ignore — counterpart socket may also be tearing down */
            }
            await removeTerminalSession(session.id);
            log({ module: 'terminal-relay' }, `[REMOTE-TERMINAL] close session=${session.id} (socket disconnect)`);
        }
    });
}
