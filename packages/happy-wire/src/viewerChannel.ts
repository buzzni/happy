import * as z from 'zod';

/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary viewer-channel-strict-design.md
 * (F5, viewer channel v1) — the remote browser screen of a strict machine, over a
 * relay that can neither read, alter nor replay it.
 *
 * The client opens a WebSocket to `VIEWER_CHANNEL_PATH` on the screen's preview
 * host and sends, as its first message, a bound `browser-viewer:channel-open`
 * request (rpcBinding.ts) sealed with the machine key. It carries a channel key
 * and a channel id the client made. The daemon's first message is the open reply:
 * a proof sealed with the proof key, or a refusal. After that every WebSocket
 * message is one binary frame:
 *
 *   0x01 | kind | AES-256-GCM(payload) | tag
 *
 * sealed with the direction's frame key,
 * `HKDF-SHA256(channelKey, salt = daemonNonce, info = viewerFrameKeyInfo(...))`,
 * under the nonce `dir | seq`. The sequence is never sent: each side counts from
 * 1 per direction, so a replayed, reordered or dropped frame does not open. The
 * AAD binds version, kind and key info. A daemon nonce fresh for every open
 * means a replayed open (after a restart forgot its nonce) gets keys nobody holds.
 *
 * Pure and browser-safe: HKDF and AES-GCM run in each side's own crypto, checked
 * against `fixtures/viewerChannel.v1.json`.
 */

export const VIEWER_CHANNEL_VERSION = 1;
export const VIEWER_CHANNEL_OPEN_METHOD = 'browser-viewer:channel-open';
export const VIEWER_CHANNEL_PATH = '/v1/viewer-channel';
export const VIEWER_CHANNEL_KEY_HASH = 'sha256';
export const VIEWER_CHANNEL_KEY_LENGTH = 32;
/** Largest payload one frame carries; the daemon splits larger reads. */
export const VIEWER_FRAME_MAX_PAYLOAD_BYTES = 64 * 1024;

const FRAME_VERSION = 1;
const TAG_BYTES = 16;

export const viewerChannelCapabilitySchema = z.object({ version: z.literal(VIEWER_CHANNEL_VERSION) });
export type ViewerChannelCapability = z.infer<typeof viewerChannelCapabilitySchema>;
export const VIEWER_CHANNEL_CAPABILITY: ViewerChannelCapability = { version: VIEWER_CHANNEL_VERSION };

export type ViewerDirection = 'in' | 'out';

const bytes16 = z.string().regex(/^[A-Za-z0-9+/]{22}==$/);
const bytes32 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
const viewerKeySchema = z.string().regex(/^bv1_[A-Za-z0-9_-]{32}$/);
const leaseIdSchema = z.string().regex(/^[0-9a-f]{64}$/);

const openParamsSchema = z.object({
  viewerChannel: z.literal(VIEWER_CHANNEL_VERSION),
  channelKey: bytes32,
  channelId: bytes16,
  viewerKey: viewerKeySchema,
  leaseId: leaseIdSchema,
}).strict();
export type ViewerChannelOpenParams = z.infer<typeof openParamsSchema>;

/** The `params` of a bound `browser-viewer:channel-open`; null for anything malformed. */
export function readViewerChannelOpenParams(value: unknown): ViewerChannelOpenParams | null {
  const parsed = openParamsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const capsSchema = z.object({
  resize: z.enum(['remote', 'scale']),
  maxFrameBytes: z.number().int().positive().max(VIEWER_FRAME_MAX_PAYLOAD_BYTES),
}).strict();
export type ViewerChannelCaps = z.infer<typeof capsSchema>;

const proofSchema = z.object({
  viewerChannel: z.literal(VIEWER_CHANNEL_VERSION),
  nonce: bytes16,
  channelId: bytes16,
  viewerKey: viewerKeySchema,
  leaseId: leaseIdSchema,
  display: z.string().regex(/^:\d{1,4}$/),
  daemonNonce: bytes16,
  caps: capsSchema,
}).strict();
export type ViewerChannelProof = z.infer<typeof proofSchema>;

/**
 * The opened proof of an open reply. It must answer this open (its binding nonce)
 * and this channel, and name the screen the client started — the viewer key and
 * display of its own sealed `start-bound` answer, and the lease its token was for.
 * The caps a client acts on are the ones inside it.
 */
export function readViewerChannelProof(
  value: unknown,
  expected: { nonce: string; channelId: string; viewerKey: string; leaseId: string; display: string },
):
  | { ok: true; daemonNonce: string; caps: ViewerChannelCaps }
  | { ok: false; code: 'VIEWER_PROOF_MALFORMED' | 'VIEWER_PROOF_MISMATCH' } {
  const parsed = proofSchema.safeParse(value);
  if (!parsed.success) return { ok: false, code: 'VIEWER_PROOF_MALFORMED' };
  const proof = parsed.data;
  if (
    proof.nonce !== expected.nonce
    || proof.channelId !== expected.channelId
    || proof.viewerKey !== expected.viewerKey
    || proof.leaseId !== expected.leaseId
    || proof.display !== expected.display
  ) {
    return { ok: false, code: 'VIEWER_PROOF_MISMATCH' };
  }
  return { ok: true, daemonNonce: proof.daemonNonce, caps: proof.caps };
}

const openReplySchema = z.union([
  z.object({ ok: z.literal(true), proof: z.string().min(1) }).strict(),
  // `sealed` is a bound refusal sealed with the machine key; a plaintext one says nothing a client may show.
  z.object({ ok: z.literal(false), sealed: z.string().min(1).optional() }).strict(),
]);
export type ViewerChannelOpenReply = z.infer<typeof openReplySchema>;

/** The daemon's first (text) message; null for anything else, which ends the channel. */
export function readViewerChannelOpenReply(text: string): ViewerChannelOpenReply | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = openReplySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** HKDF info for one direction's frame key; the salt is the daemon nonce, the input key the channel key. */
export function viewerFrameKeyInfo(dir: ViewerDirection, leaseId: string, channelId: string): string {
  return `saycode/viewer-frame/v1/${dir}/${leaseId}/${channelId}`;
}

/** HKDF info for the proof key, with an empty salt: the daemon nonce is inside the proof. */
export function viewerProofKeyInfo(channelId: string): string {
  return `saycode/viewer-proof/v1/${channelId}`;
}

export const VIEWER_FRAME_KIND = { rfb: 1, close: 2, closed: 3 } as const;
export type ViewerFrameKind = keyof typeof VIEWER_FRAME_KIND;

/** in: RFB bytes and the user's close. out: RFB bytes and why the daemon ended the channel. */
const KINDS_BY_DIRECTION: Record<ViewerDirection, readonly ViewerFrameKind[]> = {
  in: ['rfb', 'close'],
  out: ['rfb', 'closed'],
};

export const VIEWER_CLOSED_REASONS = ['client-closed', 'vnc-closed', 'daemon-stopping'] as const;
export type ViewerClosedReason = (typeof VIEWER_CLOSED_REASONS)[number];

/** The 12-byte AES-GCM nonce of frame `seq` in `dir`: direction (4 bytes) then sequence (8), big-endian. */
export function viewerFrameNonce(dir: ViewerDirection, seq: number): Uint8Array {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new RangeError(`Viewer frame sequence out of range: ${seq}`);
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(0, dir === 'in' ? 1 : 2);
  view.setBigUint64(4, BigInt(seq));
  return nonce;
}

/** The AES-GCM additional data of a frame: version, kind and the key info of its direction. */
export function viewerFrameAad(kind: number, info: string): Uint8Array {
  const infoBytes = new TextEncoder().encode(info);
  const aad = new Uint8Array(2 + infoBytes.length);
  aad[0] = FRAME_VERSION;
  aad[1] = kind;
  aad.set(infoBytes, 2);
  return aad;
}

/** A frame for the wire: version, kind, then the ciphertext with its tag. */
export function encodeViewerFrame(kind: number, sealed: Uint8Array): Uint8Array {
  const frame = new Uint8Array(2 + sealed.length);
  frame[0] = FRAME_VERSION;
  frame[1] = kind;
  frame.set(sealed, 2);
  return frame;
}

/**
 * The kind and sealed part of a received frame; null for another version, a kind
 * this direction does not carry, or a size no frame has. The receiver ends the channel.
 */
export function readViewerFrame(frame: Uint8Array, dir: ViewerDirection): { kind: ViewerFrameKind; sealed: Uint8Array } | null {
  if (frame.length < 2 + TAG_BYTES || frame.length > 2 + VIEWER_FRAME_MAX_PAYLOAD_BYTES + TAG_BYTES) return null;
  if (frame[0] !== FRAME_VERSION) return null;
  const kind = KINDS_BY_DIRECTION[dir].find((name) => VIEWER_FRAME_KIND[name] === frame[1]);
  return kind ? { kind, sealed: frame.subarray(2) } : null;
}

/** The reason in an opened `closed` payload; null for anything a daemon does not send. */
export function readViewerClosedReason(payload: Uint8Array): ViewerClosedReason | null {
  const text = new TextDecoder().decode(payload);
  return (VIEWER_CLOSED_REASONS as readonly string[]).includes(text) ? text as ViewerClosedReason : null;
}
