import { describe, expect, it } from 'vitest';
import { hkdfSync, randomBytes } from 'node:crypto';
import fixture from './fixtures/terminalBinding.v1.json';
import {
  admitInboundSeq,
  admitLiveOutputSeq,
  readTerminalFrame,
  readTerminalOpenParams,
  readTerminalProof,
  terminalBindingCapabilitySchema,
  terminalFrameKeyInfo,
  TERMINAL_BINDING_CAPABILITY,
  TERMINAL_FRAME_KEY_HASH,
  TERMINAL_FRAME_KEY_LENGTH,
  type TerminalProof,
} from './terminalBinding';

const b64 = (bytes: number) => randomBytes(bytes).toString('base64');
const terminalId = b64(16);
const nonce = b64(16);
const sessionId = 'session-1';

describe('terminal binding capability', () => {
  it('advertises version 1', () => {
    expect(terminalBindingCapabilitySchema.parse(TERMINAL_BINDING_CAPABILITY)).toEqual({ version: 1 });
    expect(terminalBindingCapabilitySchema.safeParse({ version: 2 }).success).toBe(false);
  });
});

describe('readTerminalOpenParams', () => {
  const valid = { terminalBinding: 1, terminalKey: b64(32), terminalId, cols: 80, rows: 24, cwd: '/w', userId: 'u' };

  it('reads open params that carry a 32-byte terminal key and a 16-byte id', () => {
    expect(readTerminalOpenParams(valid)).toEqual(valid);
  });

  it('refuses params without the binding marker (the v1 open) or with a short key', () => {
    const { terminalBinding: _marker, ...v1 } = valid;
    expect(readTerminalOpenParams(v1)).toBeNull();
    expect(readTerminalOpenParams({ ...valid, terminalKey: b64(16) })).toBeNull();
    expect(readTerminalOpenParams({ ...valid, terminalId: b64(8) })).toBeNull();
    expect(readTerminalOpenParams({ ...valid, cols: 0 })).toBeNull();
    expect(readTerminalOpenParams({ ...valid, extra: true })).toBeNull();
  });
});

describe('readTerminalProof', () => {
  const caps = { resume: true, snapshot: true, pagedResume: true };
  const proof: TerminalProof = { terminalBinding: 1, nonce, sessionId, terminalId, daemonNonce: b64(16), caps };

  it('returns the daemon nonce and caps of a proof for this open and session', () => {
    expect(readTerminalProof(proof, { nonce, terminalId, sessionId })).toEqual({ ok: true, daemonNonce: proof.daemonNonce, caps });
  });

  it('refuses a proof for another open, terminal or session', () => {
    expect(readTerminalProof(proof, { nonce: b64(16), terminalId, sessionId })).toEqual({ ok: false, code: 'TERMINAL_PROOF_MISMATCH' });
    expect(readTerminalProof(proof, { nonce, terminalId: b64(16), sessionId })).toEqual({ ok: false, code: 'TERMINAL_PROOF_MISMATCH' });
    expect(readTerminalProof(proof, { nonce, terminalId, sessionId: 'other' })).toEqual({ ok: false, code: 'TERMINAL_PROOF_MISMATCH' });
    expect(readTerminalProof({ ...proof, caps: undefined }, { nonce, terminalId, sessionId })).toEqual({ ok: false, code: 'TERMINAL_PROOF_MALFORMED' });
    expect(readTerminalProof(null, { nonce, terminalId, sessionId })).toEqual({ ok: false, code: 'TERMINAL_PROOF_MALFORMED' });
  });
});

describe('readTerminalFrame', () => {
  const rid = b64(16);

  it('reads each inbound kind for its terminal', () => {
    for (const frame of [
      { kind: 'input', data: 'ls\r' },
      { kind: 'resize', cols: 120, rows: 40 },
      { kind: 'close' },
      { kind: 'resume', rid, afterSeq: 3, maxChars: 4096 },
      { kind: 'attach', rid, afterSeq: 0 },
    ]) {
      const value = { v: 1, t: terminalId, dir: 'in', seq: 1, ...frame };
      expect(readTerminalFrame(value, { terminalId, dir: 'in' })).toEqual(value);
    }
  });

  it('reads each outbound kind for its terminal', () => {
    for (const frame of [
      { kind: 'output', seq: 1, data: '$ ' },
      { kind: 'output', seq: 2, data: 'x', rid, more: true, nextSeq: 3 },
      { kind: 'snapshot', rid, seq: 9, data: 'screen', more: false, nextSeq: 10, droppedChars: 5 },
      { kind: 'gap', rid, fromSeq: 4, droppedChars: 100 },
      { kind: 'closed', code: 0, signal: null, reason: 'client-closed', lastSeq: 9 },
    ]) {
      const value = { v: 1, t: terminalId, dir: 'out', ...frame };
      expect(readTerminalFrame(value, { terminalId, dir: 'out' })).toEqual(value);
    }
  });

  it('drops a frame of another terminal or direction, or one that does not fit its kind', () => {
    const input = { v: 1, t: terminalId, dir: 'in', seq: 1, kind: 'input', data: 'x' };
    expect(readTerminalFrame(input, { terminalId: b64(16), dir: 'in' })).toBeNull();
    expect(readTerminalFrame(input, { terminalId, dir: 'out' })).toBeNull();
    expect(readTerminalFrame({ ...input, kind: 'output' }, { terminalId, dir: 'in' })).toBeNull();
    expect(readTerminalFrame({ ...input, seq: 0 }, { terminalId, dir: 'in' })).toBeNull();
    expect(readTerminalFrame({ ...input, v: 2 }, { terminalId, dir: 'in' })).toBeNull();
    expect(readTerminalFrame({ v: 1, t: terminalId, dir: 'in', seq: 1, kind: 'resize', cols: -1, rows: 2 }, { terminalId, dir: 'in' })).toBeNull();
    expect(readTerminalFrame('x', { terminalId, dir: 'in' })).toBeNull();
  });
});

describe('sequence admission', () => {
  it('takes inbound frames only in order: a repeat is a replay, a skip is a gap', () => {
    expect(admitInboundSeq(0, 1)).toBe('accept');
    expect(admitInboundSeq(4, 5)).toBe('accept');
    expect(admitInboundSeq(4, 4)).toBe('replayed');
    expect(admitInboundSeq(4, 2)).toBe('replayed');
    expect(admitInboundSeq(4, 6)).toBe('gap');
  });

  it('applies live output only as the next one', () => {
    expect(admitLiveOutputSeq(0, 1)).toBe('apply');
    expect(admitLiveOutputSeq(7, 7)).toBe('duplicate');
    expect(admitLiveOutputSeq(7, 9)).toBe('gap');
  });
});

describe('frame keys', () => {
  it('names direction, session and terminal in the HKDF info', () => {
    expect(terminalFrameKeyInfo('in', 's', 't')).toBe('saycode/terminal-frame/v1/in/s/t');
    expect(terminalFrameKeyInfo('out', 's', 't')).not.toBe(terminalFrameKeyInfo('in', 's', 't'));
  });

  it('matches the shared test vectors every implementation checks itself against', () => {
    for (const vector of fixture.frameKeys) {
      const key = Buffer.from(hkdfSync(
        TERMINAL_FRAME_KEY_HASH,
        Buffer.from(vector.terminalKey, 'base64'),
        Buffer.from(vector.daemonNonce, 'base64'),
        Buffer.from(terminalFrameKeyInfo(vector.dir as 'in' | 'out', vector.sessionId, vector.terminalId), 'utf8'),
        TERMINAL_FRAME_KEY_LENGTH,
      ));
      expect(key.toString('base64')).toBe(vector.frameKey);
    }
  });
});
