import { describe, expect, it } from 'vitest';
import { createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import fixture from './fixtures/viewerChannel.v1.json';
import {
  encodeViewerFrame,
  readViewerChannelOpenParams,
  readViewerChannelOpenReply,
  readViewerChannelProof,
  readViewerClosedReason,
  readViewerFrame,
  viewerChannelCapabilitySchema,
  viewerFrameAad,
  viewerFrameKeyInfo,
  viewerFrameNonce,
  viewerProofKeyInfo,
  VIEWER_CHANNEL_CAPABILITY,
  VIEWER_CHANNEL_KEY_HASH,
  VIEWER_CHANNEL_KEY_LENGTH,
  VIEWER_FRAME_KIND,
  VIEWER_FRAME_MAX_PAYLOAD_BYTES,
  type ViewerChannelProof,
} from './viewerChannel';

const b64 = (bytes: number) => randomBytes(bytes).toString('base64');
const channelId = b64(16);
const nonce = b64(16);
const viewerKey = `bv1_${'A'.repeat(32)}`;
const leaseId = 'a'.repeat(64);
const display = ':99';
const TAG = 16;

describe('viewer channel capability', () => {
  it('advertises version 1', () => {
    expect(viewerChannelCapabilitySchema.parse(VIEWER_CHANNEL_CAPABILITY)).toEqual({ version: 1 });
    expect(viewerChannelCapabilitySchema.safeParse({ version: 2 }).success).toBe(false);
  });
});

describe('readViewerChannelOpenParams', () => {
  const valid = { viewerChannel: 1, channelKey: b64(32), channelId, viewerKey, leaseId };

  it('reads open params naming a 32-byte channel key, a 16-byte id and the lease it opens', () => {
    expect(readViewerChannelOpenParams(valid)).toEqual(valid);
  });

  it('refuses params without the marker, with short keys, a malformed lease or extra fields', () => {
    const { viewerChannel: _marker, ...unmarked } = valid;
    expect(readViewerChannelOpenParams(unmarked)).toBeNull();
    expect(readViewerChannelOpenParams({ ...valid, channelKey: b64(16) })).toBeNull();
    expect(readViewerChannelOpenParams({ ...valid, channelId: b64(8) })).toBeNull();
    expect(readViewerChannelOpenParams({ ...valid, viewerKey: 'bv1_short' })).toBeNull();
    expect(readViewerChannelOpenParams({ ...valid, leaseId: 'A'.repeat(64) })).toBeNull();
    expect(readViewerChannelOpenParams({ ...valid, port: 5900 })).toBeNull();
    expect(readViewerChannelOpenParams(null)).toBeNull();
  });
});

describe('readViewerChannelProof', () => {
  const caps = { resize: 'remote' as const, maxFrameBytes: VIEWER_FRAME_MAX_PAYLOAD_BYTES };
  const proof: ViewerChannelProof = { viewerChannel: 1, nonce, channelId, viewerKey, leaseId, display, daemonNonce: b64(16), caps };
  const expected = { nonce, channelId, viewerKey, leaseId, display };

  it('returns the daemon nonce and caps of a proof for this open and screen', () => {
    expect(readViewerChannelProof(proof, expected)).toEqual({ ok: true, daemonNonce: proof.daemonNonce, caps });
  });

  it('refuses a proof for another open, channel, viewer, lease or display', () => {
    for (const other of [
      { nonce: b64(16) },
      { channelId: b64(16) },
      { viewerKey: `bv1_${'B'.repeat(32)}` },
      { leaseId: 'b'.repeat(64) },
      { display: ':100' },
    ]) {
      expect(readViewerChannelProof(proof, { ...expected, ...other })).toEqual({ ok: false, code: 'VIEWER_PROOF_MISMATCH' });
    }
  });

  it('refuses a malformed proof or caps outside what a frame can carry', () => {
    expect(readViewerChannelProof({ ...proof, caps: { ...caps, maxFrameBytes: VIEWER_FRAME_MAX_PAYLOAD_BYTES + 1 } }, expected))
      .toEqual({ ok: false, code: 'VIEWER_PROOF_MALFORMED' });
    expect(readViewerChannelProof({ ...proof, caps: { ...caps, resize: 'stretch' } }, expected)).toEqual({ ok: false, code: 'VIEWER_PROOF_MALFORMED' });
    expect(readViewerChannelProof({ ...proof, display: 'localhost:99' }, expected)).toEqual({ ok: false, code: 'VIEWER_PROOF_MALFORMED' });
    expect(readViewerChannelProof(null, expected)).toEqual({ ok: false, code: 'VIEWER_PROOF_MALFORMED' });
  });
});

describe('readViewerChannelOpenReply', () => {
  it('reads the daemon\'s first message: a proof, or a refusal that may be sealed', () => {
    expect(readViewerChannelOpenReply('{"ok":true,"proof":"cHJvb2Y="}')).toEqual({ ok: true, proof: 'cHJvb2Y=' });
    expect(readViewerChannelOpenReply('{"ok":false,"sealed":"c2VhbGVk"}')).toEqual({ ok: false, sealed: 'c2VhbGVk' });
    expect(readViewerChannelOpenReply('{"ok":false}')).toEqual({ ok: false });
  });

  it('reads anything else as no reply, so a relay cannot word one', () => {
    expect(readViewerChannelOpenReply('{"ok":false,"message":"proof mismatch"}')).toBeNull();
    expect(readViewerChannelOpenReply('{"ok":true}')).toBeNull();
    expect(readViewerChannelOpenReply('not json')).toBeNull();
  });
});

describe('key info', () => {
  it('names direction, lease and channel for frame keys, and the channel for the proof key', () => {
    expect(viewerFrameKeyInfo('in', 'l', 'c')).toBe('saycode/viewer-frame/v1/in/l/c');
    expect(viewerFrameKeyInfo('out', 'l', 'c')).toBe('saycode/viewer-frame/v1/out/l/c');
    expect(viewerProofKeyInfo('c')).toBe('saycode/viewer-proof/v1/c');
  });
});

describe('frame nonce and AAD', () => {
  it('lays the nonce out as direction then sequence, big-endian', () => {
    expect(Buffer.from(viewerFrameNonce('in', 1)).toString('hex')).toBe('000000010000000000000001');
    expect(Buffer.from(viewerFrameNonce('out', 258)).toString('hex')).toBe('000000020000000000000102');
    expect(Buffer.from(viewerFrameNonce('in', Number.MAX_SAFE_INTEGER)).toString('hex')).toBe('00000001001fffffffffffff');
  });

  it('has no nonce for a sequence that is not a positive safe integer', () => {
    expect(() => viewerFrameNonce('in', 0)).toThrow(RangeError);
    expect(() => viewerFrameNonce('in', 1.5)).toThrow(RangeError);
    expect(() => viewerFrameNonce('in', Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });

  it('binds version, kind and the key info into the AAD', () => {
    expect(Buffer.from(viewerFrameAad(VIEWER_FRAME_KIND.rfb, 'i')).toString('hex')).toBe('010169');
  });
});

describe('readViewerFrame', () => {
  const sealed = (payloadBytes: number) => new Uint8Array(payloadBytes + TAG);

  it('reads each kind its direction carries', () => {
    for (const [dir, kind] of [['in', 'rfb'], ['in', 'close'], ['out', 'rfb'], ['out', 'closed']] as const) {
      const frame = encodeViewerFrame(VIEWER_FRAME_KIND[kind], sealed(3));
      expect(readViewerFrame(frame, dir)).toEqual({ kind, sealed: frame.subarray(2) });
    }
  });

  it('drops a kind the other direction carries, an unknown kind or version, and a frame of the wrong size', () => {
    expect(readViewerFrame(encodeViewerFrame(VIEWER_FRAME_KIND.closed, sealed(1)), 'in')).toBeNull();
    expect(readViewerFrame(encodeViewerFrame(VIEWER_FRAME_KIND.close, sealed(0)), 'out')).toBeNull();
    expect(readViewerFrame(encodeViewerFrame(9, sealed(1)), 'in')).toBeNull();
    const versioned = encodeViewerFrame(VIEWER_FRAME_KIND.rfb, sealed(1));
    versioned[0] = 2;
    expect(readViewerFrame(versioned, 'in')).toBeNull();
    expect(readViewerFrame(new Uint8Array([1, 1, ...new Uint8Array(TAG - 1)]), 'in')).toBeNull();
    expect(readViewerFrame(encodeViewerFrame(VIEWER_FRAME_KIND.rfb, sealed(VIEWER_FRAME_MAX_PAYLOAD_BYTES + 1)), 'in')).toBeNull();
    expect(readViewerFrame(encodeViewerFrame(VIEWER_FRAME_KIND.rfb, sealed(VIEWER_FRAME_MAX_PAYLOAD_BYTES)), 'in')).not.toBeNull();
  });
});

describe('readViewerClosedReason', () => {
  it('reads only the reasons a daemon gives', () => {
    expect(readViewerClosedReason(new TextEncoder().encode('vnc-closed'))).toBe('vnc-closed');
    expect(readViewerClosedReason(new TextEncoder().encode('proof mismatch'))).toBeNull();
  });
});

describe('test vectors', () => {
  const channelKey = Buffer.from(fixture.channelKey, 'base64');
  const derive = (salt: Buffer, info: string) => Buffer.from(hkdfSync(
    VIEWER_CHANNEL_KEY_HASH, channelKey, salt, Buffer.from(info, 'utf8'), VIEWER_CHANNEL_KEY_LENGTH,
  )).toString('base64');

  it('derives the shared frame and proof keys', () => {
    const daemonNonce = Buffer.from(fixture.daemonNonce, 'base64');
    expect(derive(daemonNonce, viewerFrameKeyInfo('in', fixture.leaseId, fixture.channelId))).toBe(fixture.frameKeys.in);
    expect(derive(daemonNonce, viewerFrameKeyInfo('out', fixture.leaseId, fixture.channelId))).toBe(fixture.frameKeys.out);
    expect(derive(Buffer.alloc(0), viewerProofKeyInfo(fixture.channelId))).toBe(fixture.proofKey);
  });

  it('opens every shared frame with this module\'s nonce and AAD', () => {
    for (const vector of fixture.frames) {
      const dir = vector.dir as 'in' | 'out';
      const read = readViewerFrame(new Uint8Array(Buffer.from(vector.frame, 'base64')), dir);
      expect(read).not.toBeNull();
      expect(VIEWER_FRAME_KIND[read!.kind]).toBe(vector.kind);
      const info = viewerFrameKeyInfo(dir, fixture.leaseId, fixture.channelId);
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(fixture.frameKeys[dir], 'base64'), viewerFrameNonce(dir, vector.seq));
      decipher.setAAD(viewerFrameAad(vector.kind, info));
      decipher.setAuthTag(read!.sealed.subarray(read!.sealed.length - TAG));
      const payload = Buffer.concat([decipher.update(read!.sealed.subarray(0, read!.sealed.length - TAG)), decipher.final()]);
      expect(payload.toString('base64')).toBe(vector.payload);
    }
  });
});
