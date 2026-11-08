import { afterEach, describe, expect, it, vi } from 'vitest';
import { hkdfSync, randomBytes } from 'node:crypto';
import { bindRpcRequest, terminalFrameKeyInfo, type TerminalOpenParams } from '@slopus/happy-wire';
import { decodeBase64, decryptWithDataKey, encodeBase64, encryptWithDataKey } from '@/api/encryption';
import type { DaemonTerminalEntry } from './daemonTerminalSessions';
import {
    bindTerminal,
    createTerminalOpenNonceGuard,
    decideTerminalOpen,
    receiveBoundTerminalFrame,
    restoreBoundTerminal,
    TERMINAL_IN_REORDER_MAX_HELD,
    TERMINAL_IN_REORDER_WINDOW_MS,
} from './terminalBindingSession';

const b64 = (n: number) => randomBytes(n).toString('base64');
const machineId = 'machine-1';
const caps = { resume: true, snapshot: true, pagedResume: true };

function openParams(overrides: Partial<TerminalOpenParams> = {}): TerminalOpenParams {
    return { terminalBinding: 1, terminalKey: b64(32), terminalId: b64(16), cols: 80, rows: 24, ...overrides };
}

function boundOpen(params: unknown, overrides: { method?: string; scope?: string; issuedAt?: number; nonce?: string } = {}) {
    return bindRpcRequest({
        method: overrides.method ?? 'terminal-open',
        scope: overrides.scope ?? machineId,
        issuedAt: overrides.issuedAt ?? Date.now(),
        nonce: overrides.nonce ?? b64(16),
        params,
    });
}

describe('decideTerminalOpen', () => {
    it('opens a bound terminal-open with terminal binding params', () => {
        const params = openParams();
        const request = boundOpen(params);
        const decision = decideTerminalOpen(request, { machineId, strict: true, nonceGuard: createTerminalOpenNonceGuard() });
        expect(decision).toEqual({ kind: 'bound', params, nonce: request.nonce });
    });

    it('keeps the v1 open on a compat machine and refuses it under strict', () => {
        const legacy = { cols: 80, rows: 24, cwd: '/w' };
        expect(decideTerminalOpen(legacy, { machineId, strict: false, nonceGuard: createTerminalOpenNonceGuard() }))
            .toEqual({ kind: 'legacy', params: legacy });
        expect(decideTerminalOpen(legacy, { machineId, strict: true, nonceGuard: createTerminalOpenNonceGuard() }))
            .toMatchObject({ kind: 'refused', code: 'TERMINAL_BINDING_REQUIRED' });
    });

    it('refuses a replayed open, on compat machines too', () => {
        const nonceGuard = createTerminalOpenNonceGuard();
        const request = boundOpen(openParams());
        expect(decideTerminalOpen(request, { machineId, strict: false, nonceGuard }).kind).toBe('bound');
        expect(decideTerminalOpen(request, { machineId, strict: false, nonceGuard }))
            .toMatchObject({ kind: 'refused', code: 'RPC_REQUEST_REPLAYED' });
    });

    it('refuses an open outside the time window, on compat machines too', () => {
        const request = boundOpen(openParams(), { issuedAt: Date.now() - 6 * 60_000 });
        expect(decideTerminalOpen(request, { machineId, strict: false, nonceGuard: createTerminalOpenNonceGuard() }))
            .toMatchObject({ kind: 'refused', code: 'RPC_REQUEST_STALE' });
    });

    it('refuses an open bound to another method or machine, or without terminal binding params', () => {
        const ctx = () => ({ machineId, strict: false, nonceGuard: createTerminalOpenNonceGuard() });
        expect(decideTerminalOpen(boundOpen(openParams(), { method: 'bash' }), ctx())).toMatchObject({ kind: 'refused', code: 'RPC_METHOD_MISMATCH' });
        expect(decideTerminalOpen(boundOpen(openParams(), { scope: 'machine-2' }), ctx())).toMatchObject({ kind: 'refused', code: 'RPC_SCOPE_MISMATCH' });
        expect(decideTerminalOpen(boundOpen({ cols: 80 }), ctx())).toMatchObject({ kind: 'refused', code: 'TERMINAL_BINDING_MALFORMED' });
    });

    it('refuses opens once the window holds as many as it remembers', () => {
        const nonceGuard = createTerminalOpenNonceGuard({ maxEntries: 1 });
        expect(decideTerminalOpen(boundOpen(openParams()), { machineId, strict: false, nonceGuard }).kind).toBe('bound');
        expect(decideTerminalOpen(boundOpen(openParams()), { machineId, strict: false, nonceGuard }))
            .toMatchObject({ kind: 'refused', code: 'RPC_TOO_MANY_REQUESTS' });
    });
});

describe('bindTerminal', () => {
    const sessionId = 'session-1';
    const frameKey = (params: TerminalOpenParams, daemonNonce: string, dir: 'in' | 'out') => new Uint8Array(hkdfSync(
        'sha256', decodeBase64(params.terminalKey), decodeBase64(daemonNonce),
        Buffer.from(terminalFrameKeyInfo(dir, sessionId, params.terminalId), 'utf8'), 32,
    ));
    const bind = (params = openParams()) => {
        const nonce = b64(16);
        const { terminal, proof } = bindTerminal({ params, nonce, sessionId, caps });
        const opened = decryptWithDataKey(decodeBase64(proof), decodeBase64(params.terminalKey));
        return { params, nonce, terminal, opened };
    };
    const sealIn = (params: TerminalOpenParams, daemonNonce: string, frame: Record<string, unknown>) =>
        encodeBase64(encryptWithDataKey({ v: 1, t: params.terminalId, dir: 'in', ...frame }, frameKey(params, daemonNonce, 'in')));

    it('answers with a proof the terminal key opens, naming the open, session, terminal and caps', () => {
        const { params, nonce, opened } = bind();
        expect(opened).toMatchObject({ terminalBinding: 1, nonce, sessionId, terminalId: params.terminalId, caps });
        expect(opened.daemonNonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    });

    it('picks a new daemon nonce for every open, so a replayed open gets other frame keys', () => {
        const params = openParams();
        const first = bindTerminal({ params, nonce: b64(16), sessionId, caps }).proof;
        const second = bindTerminal({ params, nonce: b64(16), sessionId, caps }).proof;
        const nonceOf = (proof: string) => decryptWithDataKey(decodeBase64(proof), decodeBase64(params.terminalKey)).daemonNonce;
        expect(nonceOf(first)).not.toBe(nonceOf(second));
    });

    it('seals outbound frames with the out key for this terminal', () => {
        const { params, terminal, opened } = bind();
        const sealed = terminal.sealOut({ kind: 'output', seq: 1, data: '$ ' });
        expect(decryptWithDataKey(decodeBase64(sealed), frameKey(params, opened.daemonNonce, 'out')))
            .toEqual({ v: 1, t: params.terminalId, dir: 'out', kind: 'output', seq: 1, data: '$ ' });
        expect(decryptWithDataKey(decodeBase64(sealed), frameKey(params, opened.daemonNonce, 'in'))).toBeNull();
    });

    it('takes inbound frames in order, drops a replay and reports a gap', () => {
        const { params, terminal, opened } = bind();
        const frame = (seq: number) => sealIn(params, opened.daemonNonce, { seq, kind: 'input', data: `k${seq}` });
        expect(terminal.openIn(frame(1))).toEqual({ kind: 'frames', frames: [{ v: 1, t: params.terminalId, dir: 'in', seq: 1, kind: 'input', data: 'k1' }] });
        expect(terminal.openIn(frame(1))).toEqual({ kind: 'replayed' });
        expect(terminal.openIn(frame(2)).kind).toBe('frames');
        expect(terminal.openIn(frame(4 + TERMINAL_IN_REORDER_MAX_HELD))).toEqual({ kind: 'gap' });
    });

    it('holds a frame that arrives ahead of the one before it and releases both in order', () => {
        const { params, terminal, opened } = bind();
        const frame = (seq: number) => sealIn(params, opened.daemonNonce, { seq, kind: 'input', data: `k${seq}` });
        expect(terminal.openIn(frame(1)).kind).toBe('frames');
        expect(terminal.openIn(frame(3))).toEqual({ kind: 'held', awaiting: 2 });
        expect(terminal.openIn(frame(3))).toEqual({ kind: 'replayed' });
        const released = terminal.openIn(frame(2));
        expect(released.kind === 'frames' && released.frames.map((f) => f.seq)).toEqual([2, 3]);
        expect(terminal.abandonHole(2)).toBe(false);
    });

    it('takes an attach past a hole, since a lost attempt used its seq, but never a repeat or another kind', () => {
        const { params, terminal, opened } = bind();
        const rid = b64(16);
        const attach = (seq: number) => sealIn(params, opened.daemonNonce, { seq, kind: 'attach', rid, afterSeq: 0 });
        expect(terminal.openAttach(attach(3))).toEqual({ kind: 'frame', frame: { v: 1, t: params.terminalId, dir: 'in', seq: 3, kind: 'attach', rid, afterSeq: 0 } });
        expect(terminal.openAttach(attach(3))).toEqual({ kind: 'replayed' });
        expect(terminal.openAttach(attach(2))).toEqual({ kind: 'replayed' });
        expect(terminal.openAttach(sealIn(params, opened.daemonNonce, { seq: 9, kind: 'input', data: 'x' }))).toEqual({ kind: 'unreadable' });
        // Input after it continues from the attach's seq.
        expect(terminal.openIn(sealIn(params, opened.daemonNonce, { seq: 4, kind: 'input', data: 'x' })).kind).toBe('frames');
    });

    it('restores from its exported state with the same keys and input position (a daemon adopting it)', () => {
        const { params, terminal, opened } = bind();
        const input = (seq: number) => sealIn(params, opened.daemonNonce, { seq, kind: 'input', data: `k${seq}` });
        expect(terminal.openIn(input(1)).kind).toBe('frames');
        expect(terminal.openIn(input(2)).kind).toBe('frames');
        const state = terminal.exportState();
        expect(state).toEqual({ terminalId: params.terminalId, terminalKey: params.terminalKey, daemonNonce: opened.daemonNonce, lastInSeq: 2 });

        const restored = restoreBoundTerminal({ sessionId, state });
        expect(restored.openIn(input(2))).toEqual({ kind: 'replayed' });
        expect(restored.openIn(input(3)).kind).toBe('frames');
        const sealed = restored.sealOut({ kind: 'output', seq: 9, data: 'x' });
        expect(decryptWithDataKey(decodeBase64(sealed), frameKey(params, opened.daemonNonce, 'out'))).toMatchObject({ seq: 9, data: 'x' });
    });

    it('does not open frames sealed for another direction, terminal or open', () => {
        const { params, terminal, opened } = bind();
        const outKeySealed = encodeBase64(encryptWithDataKey({ v: 1, t: params.terminalId, dir: 'in', seq: 1, kind: 'close' }, frameKey(params, opened.daemonNonce, 'out')));
        expect(terminal.openIn(outKeySealed)).toEqual({ kind: 'unreadable' });
        expect(terminal.openIn(sealIn(params, opened.daemonNonce, { seq: 1, kind: 'close', t: b64(16) }))).toEqual({ kind: 'unreadable' });
        expect(terminal.openIn(sealIn(params, b64(16), { seq: 1, kind: 'close' }))).toEqual({ kind: 'unreadable' });
        expect(terminal.openIn('not base64 at all')).toEqual({ kind: 'unreadable' });
        // Nothing unreadable moved the sequence.
        expect(terminal.openIn(sealIn(params, opened.daemonNonce, { seq: 1, kind: 'close' })).kind).toBe('frames');
    });
});

describe('receiveBoundTerminalFrame', () => {
    const sessionId = 'session-1';
    afterEach(() => { vi.useRealTimers(); });

    const setup = () => {
        const params = openParams();
        const { terminal, proof } = bindTerminal({ params, nonce: b64(16), sessionId, caps });
        const daemonNonce = decryptWithDataKey(decodeBase64(proof), decodeBase64(params.terminalKey)).daemonNonce;
        const inKey = new Uint8Array(hkdfSync(
            'sha256', decodeBase64(params.terminalKey), decodeBase64(daemonNonce),
            Buffer.from(terminalFrameKeyInfo('in', sessionId, params.terminalId), 'utf8'), 32,
        ));
        const writes: string[] = [];
        const end = vi.fn();
        const entry = { exit: null, session: { write: (data: string) => { writes.push(data); }, resize: () => {} } } as unknown as DaemonTerminalEntry;
        const receive = (seq: number) => receiveBoundTerminalFrame({
            sessionId,
            entry,
            binding: terminal,
            data: encodeBase64(encryptWithDataKey({ v: 1, t: params.terminalId, dir: 'in', seq, kind: 'input', data: `k${seq}` }, inKey)),
            sendSealed: () => {},
            sendClosed: () => {},
            end,
        });
        return { terminal, writes, end, receive };
    };

    it('writes frames a relay swapped in their order and keeps the terminal', () => {
        vi.useFakeTimers();
        const { terminal, writes, end, receive } = setup();
        receive(1);
        receive(3);
        receive(2);
        vi.advanceTimersByTime(TERMINAL_IN_REORDER_WINDOW_MS + 1);
        expect(writes).toEqual(['k1', 'k2', 'k3']);
        expect(end).not.toHaveBeenCalled();
        expect(terminal.closeReason).toBeUndefined();
    });

    it('ends the terminal when a hole stays open past the reorder window, writing nothing behind it', () => {
        vi.useFakeTimers();
        const { terminal, writes, end, receive } = setup();
        receive(1);
        receive(3);
        vi.advanceTimersByTime(TERMINAL_IN_REORDER_WINDOW_MS - 1);
        expect(end).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(end).toHaveBeenCalledTimes(1);
        expect(terminal.closeReason).toBe('input-gap');
        expect(writes).toEqual(['k1']);
    });

    it('ends the terminal at once when a frame is further ahead than the window holds', () => {
        const { terminal, writes, end, receive } = setup();
        receive(1);
        receive(3 + TERMINAL_IN_REORDER_MAX_HELD);
        expect(end).toHaveBeenCalledTimes(1);
        expect(terminal.closeReason).toBe('input-gap');
        expect(writes).toEqual(['k1']);
    });
});
