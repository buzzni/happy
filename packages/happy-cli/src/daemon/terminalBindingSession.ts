/**
 * The daemon side of the remote terminal contract v2 (aplus-dev-studio
 * specs/e2ee-machine-control-boundary terminal-binding-strict-design.md §4,
 * happy-wire terminalBinding.ts), shared by the relay path (apiMachine.ts) and
 * the direct path (controlServerTerminalWs.ts).
 *
 * `decideTerminalOpen` reads opened open params: a bound `terminal-open` with
 * a terminal key is a v2 terminal; an unbound one is the v1 open, kept on a
 * compat machine and refused under strict. Every open is held to the binding
 * window and its nonce is remembered — on compat too, and refused when full —
 * because a replayed open would otherwise open a shell for recorded input.
 *
 * `bindTerminal` picks a fresh daemon nonce, derives the per-direction frame
 * keys from it and the terminal key, and seals the proof the client checks.
 * A replayed open (after a restart forgot its nonce) therefore gets keys
 * nobody holds, and the input recorded for the first one opens nowhere. The
 * open itself still runs: a command it carries in `shell`/`args` runs again
 * (the memory-only nonce guard, rpcNonceGuard.ts).
 */

import { hkdfSync, randomBytes } from 'node:crypto';
import {
    admitInboundSeq,
    readBoundRpcRequest,
    readTerminalFrame,
    readTerminalOpenParams,
    terminalFrameKeyInfo,
    RPC_BINDING_WINDOW_MS,
    TERMINAL_BINDING_VERSION,
    TERMINAL_FRAME_KEY_HASH,
    TERMINAL_FRAME_KEY_LENGTH,
    TERMINAL_OPEN_METHOD,
    type TerminalInFrame,
    type TerminalOpenParams,
    type TerminalOutFrame,
    type TerminalProofCaps,
} from '@slopus/happy-wire';
import { decodeBase64, decryptWithDataKey, encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { RpcNonceGuard } from '@/api/rpc/rpcNonceGuard';

export function createTerminalOpenNonceGuard(options: { maxEntries?: number } = {}): RpcNonceGuard {
    return new RpcNonceGuard({ windowMs: RPC_BINDING_WINDOW_MS, maxEntries: options.maxEntries ?? 10_000, whenFull: 'refuse' });
}

export type TerminalOpenDecision =
    | { kind: 'legacy'; params: unknown }
    | { kind: 'bound'; params: TerminalOpenParams; nonce: string }
    | { kind: 'refused'; error: string; code: string };

export function decideTerminalOpen(
    opened: unknown,
    ctx: { machineId: string; strict: boolean; nonceGuard: RpcNonceGuard; now?: number },
): TerminalOpenDecision {
    const now = ctx.now ?? Date.now();
    const binding = readBoundRpcRequest(opened, { method: TERMINAL_OPEN_METHOD, scope: ctx.machineId, now });
    if (binding.kind === 'refused') {
        return {
            kind: 'refused',
            code: binding.code,
            error: binding.code === 'RPC_REQUEST_STALE'
                ? 'Request was issued outside the allowed time window; check that the clocks of this device and the machine agree'
                : 'Request binding refused',
        };
    }
    if (binding.kind === 'unbound') {
        return ctx.strict
            ? { kind: 'refused', code: 'TERMINAL_BINDING_REQUIRED', error: 'Strict machine control opens only bound terminals; update the app' }
            : { kind: 'legacy', params: opened };
    }
    const params = readTerminalOpenParams(binding.params);
    if (!params) return { kind: 'refused', code: 'TERMINAL_BINDING_MALFORMED', error: 'Terminal open params are malformed' };
    const admission = ctx.nonceGuard.admit(binding.nonce, binding.issuedAt, now);
    if (admission === 'replayed') return { kind: 'refused', code: 'RPC_REQUEST_REPLAYED', error: 'Request was already received' };
    if (admission === 'full') return { kind: 'refused', code: 'RPC_TOO_MANY_REQUESTS', error: 'Too many requests within the time window; retry shortly' };
    return { kind: 'bound', params, nonce: binding.nonce };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type TerminalOutBody = DistributiveOmit<TerminalOutFrame, 'v' | 't' | 'dir'>;
export type BoundTerminalCloseReason = 'client-closed' | 'relay-closed' | 'input-gap';

export interface BoundTerminal {
    readonly terminalId: string;
    /** Why the daemon ended it on this terminal's own account; carried on the sealed `closed`. */
    closeReason?: BoundTerminalCloseReason;
    /** Seals an outbound frame for `terminal-frame.data`. */
    sealOut(body: TerminalOutBody): string;
    /** Opens `terminal-frame.data` from the client and admits it in order. */
    openIn(data: string): { kind: 'frame'; frame: TerminalInFrame } | { kind: 'replayed' } | { kind: 'gap' } | { kind: 'unreadable' };
}

export function bindTerminal(input: {
    params: TerminalOpenParams;
    nonce: string;
    sessionId: string;
    caps: TerminalProofCaps;
}): { terminal: BoundTerminal; proof: string } {
    const { params, sessionId } = input;
    const terminalKey = decodeBase64(params.terminalKey);
    const daemonNonce = new Uint8Array(randomBytes(16));
    const frameKey = (dir: 'in' | 'out') => new Uint8Array(hkdfSync(
        TERMINAL_FRAME_KEY_HASH,
        terminalKey,
        daemonNonce,
        Buffer.from(terminalFrameKeyInfo(dir, sessionId, params.terminalId), 'utf8'),
        TERMINAL_FRAME_KEY_LENGTH,
    ));
    const inKey = frameKey('in');
    const outKey = frameKey('out');
    let lastInSeq = 0;

    const terminal: BoundTerminal = {
        terminalId: params.terminalId,
        sealOut: (body) => encodeBase64(encryptWithDataKey({ v: TERMINAL_BINDING_VERSION, t: params.terminalId, dir: 'out', ...body }, outKey)),
        openIn: (data) => {
            let opened: unknown = null;
            try {
                opened = decryptWithDataKey(decodeBase64(data), inKey);
            } catch {
                opened = null;
            }
            const frame = readTerminalFrame(opened, { terminalId: params.terminalId, dir: 'in' });
            if (!frame) return { kind: 'unreadable' };
            const admission = admitInboundSeq(lastInSeq, frame.seq);
            if (admission !== 'accept') return { kind: admission };
            lastInSeq = frame.seq;
            return { kind: 'frame', frame };
        },
    };
    const proof = encodeBase64(encryptWithDataKey({
        terminalBinding: TERMINAL_BINDING_VERSION,
        nonce: input.nonce,
        sessionId,
        terminalId: params.terminalId,
        daemonNonce: encodeBase64(daemonNonce),
        caps: input.caps,
    }, terminalKey));
    return { terminal, proof };
}
