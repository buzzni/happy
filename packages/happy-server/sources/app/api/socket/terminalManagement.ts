import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Socket } from 'socket.io';
import {
    getTerminalForManagement, listTerminalsForManagement, MAX_TERMINALS_PER_USER,
} from './terminalSessions';

const challengeLifetimeMs = 15_000;
// Daemons can defer the exit while serving their last replay page (10 seconds).
const closeTimeoutMs = 16_000;
const ed25519Spki = Buffer.from('302a300506032b6570032100', 'hex');

function bytes(value: unknown, length: number): Buffer | undefined {
    if (typeof value !== 'string' || value.length !== Math.ceil(length * 4 / 3)) return;
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length === length && decoded.toString('base64url') === value) return decoded;
}

function allowed(socket: Socket): boolean {
    return socket.data?.clientType === 'user-scoped';
}

export function readTerminalOwnerKey(socket: Socket, value: unknown): string | undefined {
    if (allowed(socket) && bytes(value, 32)) return value as string;
}

type Challenge = { nonce: string; action: 'list' | 'close'; target: string; expiresAt: number };

export function registerTerminalManagement(
    socket: Socket, userId: string, emitClose: (socketId: string, sessionId: string) => void,
): void {
    if (!allowed(socket)) return;
    let challenge: Challenge | undefined;
    let managing = false;
    socket.on('terminal-management-challenge', (data, ack) => {
        if (typeof ack !== 'function') return;
        if (managing) return ack({ ok: false });
        const action = data?.action;
        const target = data?.target;
        if (action !== 'list' && action !== 'close') return ack({ ok: false });
        if (typeof target !== 'string' || (action === 'list' ? target !== '' : !/^[a-f0-9-]{36}$/.test(target))) return ack({ ok: false });
        const nonce = randomBytes(32).toString('base64url');
        challenge = { nonce, action, target, expiresAt: Date.now() + challengeLifetimeMs };
        ack({ ok: true, nonce });
    });

    socket.on('terminal-manage', async (data, ack) => {
        if (typeof ack !== 'function') return;
        const issued = challenge;
        challenge = undefined;
        const key = bytes(data?.ownerKey, 32);
        const signature = bytes(data?.signature, 64);
        if (managing || !issued || issued.expiresAt <= Date.now() || issued.action !== data?.action || issued.target !== data?.target || !key || !signature) {
            return ack({ ok: false });
        }
        managing = true;
        try {
            const publicKey = createPublicKey({ key: Buffer.concat([ed25519Spki, key]), format: 'der', type: 'spki' });
            const message = Buffer.from(JSON.stringify(['terminal-management-v1', issued.nonce, issued.action, issued.target]));
            if (!verify(null, message, publicKey, signature)) return ack({ ok: false });

            if (issued.action === 'list') {
                const { active, sessions } = await listTerminalsForManagement(userId, data.ownerKey);
                return ack({ ok: true, active, limit: MAX_TERMINALS_PER_USER, sessions });
            }
            const session = await getTerminalForManagement(userId, issued.target);
            if (!session || session.ownerKey !== data.ownerKey) return ack({ ok: false });
            if (session.closedAt !== undefined && !session.occupiesSlot) return ack({ ok: true });
            if (session.closedAt === undefined) emitClose(session.daemonSocketId, session.id);
            const deadline = Date.now() + closeTimeoutMs;
            while (socket.connected && Date.now() < deadline) {
                await delay(125);
                const current = await getTerminalForManagement(userId, session.id);
                if (current?.closedAt !== undefined && !current.occupiesSlot) return ack({ ok: true });
                if (!current) break;
            }
            return ack({ ok: false, code: 'UNCONFIRMED' });
        } catch {
            return ack({ ok: false, code: issued.action === 'close' ? 'UNCONFIRMED' : 'UNAVAILABLE' });
        } finally {
            managing = false;
        }
    });
}
