/**
 * Opening a channel that carries its own keys — the remote terminal (terminal-binding-strict-design.md
 * §4-2) and the remote screen (viewer-channel-strict-design.md §4-2) — with a bound request sealed with
 * the machine key (happy-wire rpcBinding.ts).
 *
 * The open is not an RPC, so RpcHandlerManager's admission does not run: these are its two halves for
 * an open. `readBoundOpen` checks method, scope and window and names the refusal; `admitBoundOpenNonce`
 * remembers the nonce. Every open is held to the window and its nonce is remembered — on compat too,
 * and refused when full — because a replayed open would otherwise open a channel for recorded input.
 */

import { readBoundRpcRequest, RPC_BINDING_WINDOW_MS } from '@slopus/happy-wire';
import { RpcNonceGuard } from '@/api/rpc/rpcNonceGuard';

export function createBoundOpenNonceGuard(options: { maxEntries?: number } = {}): RpcNonceGuard {
    return new RpcNonceGuard({ windowMs: RPC_BINDING_WINDOW_MS, maxEntries: options.maxEntries ?? 10_000, whenFull: 'refuse' });
}

export type BoundOpenRefusal = { kind: 'refused'; code: string; error: string };

export type BoundOpenReading =
    | { kind: 'unbound' }
    | BoundOpenRefusal
    | { kind: 'bound'; params: unknown; nonce: string; issuedAt: number };

/** Read-only: what the opened open request says. Admitting it still takes `admitBoundOpenNonce`. */
export function readBoundOpen(opened: unknown, ctx: { method: string; machineId: string; now: number }): BoundOpenReading {
    const binding = readBoundRpcRequest(opened, { method: ctx.method, scope: ctx.machineId, now: ctx.now });
    if (binding.kind === 'refused') {
        return {
            kind: 'refused',
            code: binding.code,
            error: binding.code === 'RPC_REQUEST_STALE'
                ? 'Request was issued outside the allowed time window; check that the clocks of this device and the machine agree'
                : 'Request binding refused',
        };
    }
    if (binding.kind === 'unbound') return { kind: 'unbound' };
    return { kind: 'bound', params: binding.params, nonce: binding.nonce, issuedAt: binding.issuedAt };
}

/** Remembers the open's nonce; a refusal when it was seen already or the guard is full. */
export function admitBoundOpenNonce(
    nonceGuard: RpcNonceGuard,
    open: { nonce: string; issuedAt: number },
    now: number,
): BoundOpenRefusal | null {
    const admission = nonceGuard.admit(open.nonce, open.issuedAt, now);
    if (admission === 'replayed') return { kind: 'refused', code: 'RPC_REQUEST_REPLAYED', error: 'Request was already received' };
    if (admission === 'full') return { kind: 'refused', code: 'RPC_TOO_MANY_REQUESTS', error: 'Too many requests within the time window; retry shortly' };
    return null;
}
