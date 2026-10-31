import { describe, expect, it } from 'vitest';
import { hkdfSync, randomBytes } from 'node:crypto';
import { bindRpcRequest, terminalFrameKeyInfo, type TerminalOpenParams } from '@slopus/happy-wire';
import { decodeBase64, decryptWithDataKey, encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { bindTerminal, createTerminalOpenNonceGuard, decideTerminalOpen } from './terminalBindingSession';

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
        expect(terminal.openIn(frame(1))).toEqual({ kind: 'frame', frame: { v: 1, t: params.terminalId, dir: 'in', seq: 1, kind: 'input', data: 'k1' } });
        expect(terminal.openIn(frame(1))).toEqual({ kind: 'replayed' });
        expect(terminal.openIn(frame(2)).kind).toBe('frame');
        expect(terminal.openIn(frame(4))).toEqual({ kind: 'gap' });
    });

    it('does not open frames sealed for another direction, terminal or open', () => {
        const { params, terminal, opened } = bind();
        const outKeySealed = encodeBase64(encryptWithDataKey({ v: 1, t: params.terminalId, dir: 'in', seq: 1, kind: 'close' }, frameKey(params, opened.daemonNonce, 'out')));
        expect(terminal.openIn(outKeySealed)).toEqual({ kind: 'unreadable' });
        expect(terminal.openIn(sealIn(params, opened.daemonNonce, { seq: 1, kind: 'close', t: b64(16) }))).toEqual({ kind: 'unreadable' });
        expect(terminal.openIn(sealIn(params, b64(16), { seq: 1, kind: 'close' }))).toEqual({ kind: 'unreadable' });
        expect(terminal.openIn('not base64 at all')).toEqual({ kind: 'unreadable' });
        // Nothing unreadable moved the sequence.
        expect(terminal.openIn(sealIn(params, opened.daemonNonce, { seq: 1, kind: 'close' })).kind).toBe('frame');
    });
});
