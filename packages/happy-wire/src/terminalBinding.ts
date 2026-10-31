import * as z from 'zod';

/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary terminal-binding-strict-design.md
 * (F9, contract v2) — a remote terminal the relay can neither read, alter nor replay.
 *
 * The client makes a terminal key and a terminal id and sends them in a bound
 * `terminal-open` request (rpcBinding.ts) sealed with the machine key. The
 * daemon answers with a proof sealed with the terminal key, carried in the
 * open ack's `caps.terminalBinding`, and picks a fresh `daemonNonce` for every
 * open. Frames in each direction are sealed with
 * `HKDF-SHA256(terminalKey, salt = daemonNonce, info = terminalFrameKeyInfo(...))`,
 * so a replayed open (after a daemon restart forgot its nonce) gets keys
 * nobody holds. Every control travels inside a sealed `terminal-frame`
 * (`{ v, t, dir, kind, ... }`); the relay sees only the session id.
 *
 * Pure and browser-safe: sealing and HKDF use each side's own crypto, checked
 * against `fixtures/terminalBinding.v1.json`.
 */

export const TERMINAL_BINDING_VERSION = 1;
export const TERMINAL_OPEN_METHOD = 'terminal-open';
export const TERMINAL_FRAME_KEY_HASH = 'sha256';
export const TERMINAL_FRAME_KEY_LENGTH = 32;

export const terminalBindingCapabilitySchema = z.object({ version: z.literal(TERMINAL_BINDING_VERSION) });
export type TerminalBindingCapability = z.infer<typeof terminalBindingCapabilitySchema>;
export const TERMINAL_BINDING_CAPABILITY: TerminalBindingCapability = { version: TERMINAL_BINDING_VERSION };

export type TerminalDirection = 'in' | 'out';

const bytes16 = z.string().regex(/^[A-Za-z0-9+/]{22}==$/);
const bytes32 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
const positiveInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const seqSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const openParamsSchema = z.object({
  terminalBinding: z.literal(TERMINAL_BINDING_VERSION),
  terminalKey: bytes32,
  terminalId: bytes16,
  cols: positiveInt.optional(),
  rows: positiveInt.optional(),
  cwd: z.string().optional(),
  shell: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  userId: z.string().optional(),
}).strict();
export type TerminalOpenParams = z.infer<typeof openParamsSchema>;

/** The `params` of a bound `terminal-open`; null for a v1 open or anything malformed. */
export function readTerminalOpenParams(value: unknown): TerminalOpenParams | null {
  const parsed = openParamsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const capsSchema = z.object({
  resume: z.boolean(),
  snapshot: z.boolean(),
  pagedResume: z.boolean(),
  attach: z.boolean().optional(),
  local: z.boolean().optional(),
}).strict();
export type TerminalProofCaps = z.infer<typeof capsSchema>;

const proofSchema = z.object({
  terminalBinding: z.literal(TERMINAL_BINDING_VERSION),
  nonce: bytes16,
  sessionId: z.string().min(1).max(256),
  terminalId: bytes16,
  daemonNonce: bytes16,
  caps: capsSchema,
}).strict();
export type TerminalProof = z.infer<typeof proofSchema>;

/**
 * The opened proof of an open ack. It must answer this open (its binding
 * nonce), this terminal and the session id the relay reported; the caps a
 * client acts on are the ones inside it, not the ack's plaintext.
 */
export function readTerminalProof(
  value: unknown,
  expected: { nonce: string; terminalId: string; sessionId: string },
):
  | { ok: true; daemonNonce: string; caps: TerminalProofCaps }
  | { ok: false; code: 'TERMINAL_PROOF_MALFORMED' | 'TERMINAL_PROOF_MISMATCH' } {
  const parsed = proofSchema.safeParse(value);
  if (!parsed.success) return { ok: false, code: 'TERMINAL_PROOF_MALFORMED' };
  const proof = parsed.data;
  if (proof.nonce !== expected.nonce || proof.terminalId !== expected.terminalId || proof.sessionId !== expected.sessionId) {
    return { ok: false, code: 'TERMINAL_PROOF_MISMATCH' };
  }
  return { ok: true, daemonNonce: proof.daemonNonce, caps: proof.caps };
}

/** HKDF info for one direction's frame key; the salt is the daemon nonce, the input key the terminal key. */
export function terminalFrameKeyInfo(dir: TerminalDirection, sessionId: string, terminalId: string): string {
  return `saycode/terminal-frame/v1/${dir}/${sessionId}/${terminalId}`;
}

const pageFields = {
  more: z.boolean().optional(),
  nextSeq: seqSchema.optional(),
  droppedChars: seqSchema.optional(),
};

const inBase = { v: z.literal(TERMINAL_BINDING_VERSION), t: bytes16, dir: z.literal('in'), seq: positiveInt };
/** Client → daemon. Every kind takes the next input `seq`, so none can be replayed or reordered. */
const inFrameSchema = z.discriminatedUnion('kind', [
  z.object({ ...inBase, kind: z.literal('input'), data: z.string() }).strict(),
  z.object({ ...inBase, kind: z.literal('resize'), cols: positiveInt, rows: positiveInt }).strict(),
  z.object({ ...inBase, kind: z.literal('close') }).strict(),
  z.object({ ...inBase, kind: z.literal('resume'), rid: bytes16, afterSeq: seqSchema, maxChars: positiveInt.optional() }).strict(),
  z.object({ ...inBase, kind: z.literal('attach'), rid: bytes16, afterSeq: seqSchema }).strict(),
]);
export type TerminalInFrame = z.infer<typeof inFrameSchema>;

const outBase = { v: z.literal(TERMINAL_BINDING_VERSION), t: bytes16, dir: z.literal('out') };
/**
 * Daemon → client. `output.seq` is the replay buffer's number; an answer to a
 * resume carries the `rid` it answers, so an old snapshot or gap replayed
 * later is not taken for the current one.
 */
const outFrameSchema = z.discriminatedUnion('kind', [
  z.object({ ...outBase, kind: z.literal('output'), seq: positiveInt, data: z.string(), rid: bytes16.optional(), more: pageFields.more, nextSeq: pageFields.nextSeq }).strict(),
  z.object({ ...outBase, kind: z.literal('snapshot'), rid: bytes16, seq: seqSchema, data: z.string(), ...pageFields }).strict(),
  z.object({ ...outBase, kind: z.literal('gap'), rid: bytes16, fromSeq: seqSchema, ...pageFields }).strict(),
  z.object({ ...outBase, kind: z.literal('closed'), code: z.number(), signal: z.number().nullable(), reason: z.string().max(64).optional(), lastSeq: seqSchema }).strict(),
]);
export type TerminalOutFrame = z.infer<typeof outFrameSchema>;

/** An opened frame of this terminal and direction; null for anything else, which the receiver drops. */
export function readTerminalFrame(value: unknown, expected: { terminalId: string; dir: 'in' }): TerminalInFrame | null;
export function readTerminalFrame(value: unknown, expected: { terminalId: string; dir: 'out' }): TerminalOutFrame | null;
export function readTerminalFrame(
  value: unknown,
  expected: { terminalId: string; dir: TerminalDirection },
): TerminalInFrame | TerminalOutFrame | null {
  const parsed = expected.dir === 'in' ? inFrameSchema.safeParse(value) : outFrameSchema.safeParse(value);
  if (!parsed.success || parsed.data.t !== expected.terminalId) return null;
  return parsed.data;
}

/**
 * Inbound frames are taken strictly in order. A repeat is a replay and is
 * dropped; a skip means the relay held one back, and the terminal ends
 * (`input-gap`): keystrokes with a hole can assemble another command.
 */
export function admitInboundSeq(lastSeq: number, seq: number): 'accept' | 'replayed' | 'gap' {
  if (seq <= lastSeq) return 'replayed';
  return seq === lastSeq + 1 ? 'accept' : 'gap';
}

/** Live output applies only as the next frame; a repeat is dropped, a skip asks for a resume (or ends a terminal that cannot). */
export function admitLiveOutputSeq(lastSeq: number, seq: number): 'apply' | 'duplicate' | 'gap' {
  if (seq <= lastSeq) return 'duplicate';
  return seq === lastSeq + 1 ? 'apply' : 'gap';
}
