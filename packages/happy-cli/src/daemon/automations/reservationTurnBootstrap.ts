import { reservationMonotonicNow as monotonicNow } from './reservationMonotonicClock';
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const directory = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !/[\x00-\x1f]/.test(value));
const schema = z.object({ version: z.literal(1), runId: id, sessionId: id, epoch: id,
  descriptorHash: z.string().regex(/^[a-f0-9]{64}$/), provider: z.enum(['claude', 'codex']),
  nativeId: z.string().uuid(), baseDirectory: directory, executionDirectory: directory,
  messageAuthorization: z.string().regex(/^[A-Za-z0-9_-]{1,200}\.[A-Za-z0-9_-]{43}$/), deadlineMonotonicMs: z.number().int().positive(),
}).strict();
export type ReservationTurnBootstrap = z.infer<typeof schema>;
export const RESERVATION_TURN_ENV = 'HAPPY_RESERVATION_BOOTSTRAP_FD';
const MAX_BOOTSTRAP_BYTES = 16384;

/** Parent keeps this FD only until spawn has inherited it; the child consumes and closes its own copy. */
export function stageReservationTurnBootstrap(value: ReservationTurnBootstrap): { fd: number; close(): void } {
  const encoded = Buffer.from(JSON.stringify(schema.parse(value)));
  if (encoded.length > MAX_BOOTSTRAP_BYTES) throw new Error('RESERVATION_BOOTSTRAP_INVALID');
  const directory = mkdtempSync(join(tmpdir(), 'happy-reservation-')), file = join(directory, 'bootstrap');
  let fd: number | undefined;
  try {
    writeFileSync(file, encoded, { mode: 0o600, flag: 'wx' });
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    unlinkSync(file); rmdirSync(directory);
  } catch {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(file); } catch {}
    try { rmdirSync(directory); } catch {}
    throw new Error('RESERVATION_BOOTSTRAP_INVALID');
  }
  const descriptor = fd, identity = fstatSync(fd); let closed = false;
  return { fd: descriptor, close: () => {
    if (closed) return;
    closed = true;
    try { const current = fstatSync(descriptor); if (current.dev === identity.dev && current.ino === identity.ino) closeSync(descriptor); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error; }
  } };
}
let captured: Readonly<ReservationTurnBootstrap> | undefined;
const authority = new AbortController();
let deadline = 0, expiryTimer: ReturnType<typeof setTimeout> | undefined;
function armAuthority(deadlineMonotonicMs: number): void {
  deadline = deadlineMonotonicMs;
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => authority.abort(), Math.max(0, deadline - monotonicNow())); expiryTimer.unref?.();
}
function authorityExpired(): boolean {
  try { if (captured && monotonicNow() >= deadline) authority.abort(); } catch { authority.abort(); }
  return authority.signal.aborted;
}
export function reservationTurnAuthoritySignal(): AbortSignal | undefined {
  if (!captured) return undefined;
  authorityExpired(); return authority.signal;
}
/** Only the authenticated per-launch daemon channel invokes this; it never revives an expired epoch. */
export function renewReservationTurnAuthority(epoch: string, deadlineMonotonicMs: number): boolean {
  if (!captured || captured.epoch !== epoch || authorityExpired() || !Number.isSafeInteger(deadlineMonotonicMs)
    || deadlineMonotonicMs <= monotonicNow() || deadlineMonotonicMs > monotonicNow() + 120000 || deadlineMonotonicMs < deadline) return false;
  armAuthority(deadlineMonotonicMs); return true;
}
export function revokeReservationTurnAuthority(): void { if (captured) { clearTimeout(expiryTimer); authority.abort(); } }

/** Run before provider imports or subprocesses. The message capability never remains in process.env. */
export function captureReservationTurnBootstrap(env: NodeJS.ProcessEnv, args: readonly string[], cwd = process.cwd()): void {
  const raw = env[RESERVATION_TURN_ENV], legacy = env.HAPPY_RESERVATION_BOOTSTRAP_V1;
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('HAPPY_RESERVATION_')) delete env[key];
  if (raw === undefined && legacy === undefined) return;
  let fd: number | undefined;
  try {
    if (legacy !== undefined || captured || !raw || !/^[0-9]{1,4}$/.test(raw) || Number(raw) < 3) throw new Error();
    fd = Number(raw);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BOOTSTRAP_BYTES || stat.mode & 0o077 || stat.uid !== process.getuid?.()) throw new Error();
    const buffer = Buffer.alloc(stat.size); let offset = 0;
    while (offset < buffer.length) { const count = readSync(fd, buffer, offset, buffer.length - offset, null); if (!count) throw new Error(); offset += count; }
    const value = schema.parse(JSON.parse(buffer.toString('utf8')));
    if (args[0] !== value.provider || value.deadlineMonotonicMs <= monotonicNow() || value.deadlineMonotonicMs > monotonicNow() + 120000 || value.messageAuthorization.split('.')[0] !== value.epoch
      || realpathSync(cwd) !== value.executionDirectory || realpathSync(value.baseDirectory) !== value.baseDirectory) throw new Error();
    captured = Object.freeze(value); armAuthority(value.deadlineMonotonicMs);
  } catch { throw new Error('RESERVATION_BOOTSTRAP_INVALID'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function assertReservationSessionCreationAllowed(): void {
  if (captured) throw new Error('RESERVATION_NEW_CONVERSATION_FORBIDDEN');
}
export function assertReservationProviderResume(provider: 'claude' | 'codex', nativeId: string | null | undefined): void {
  if (captured && (captured.provider !== provider || nativeId !== captured.nativeId || authorityExpired())) throw new Error('RESERVATION_NATIVE_RESUME_REQUIRED');
}
export function reservationBaseDirectory(): string | undefined { return captured?.baseDirectory; }
export function reservationSessionOptions(sessionId: string): { reservation?: { sessionId: string; authorization: string } } {
  if (!captured) return {};
  if (captured.sessionId !== sessionId || authorityExpired()) throw new Error('RESERVATION_SESSION_MISMATCH');
  return { reservation: { sessionId, authorization: captured.messageAuthorization } };
}

/** Fresh process metadata cannot relocate the saved chat or replace its provider conversation. */
export function assertReservationMetadata(metadata: { path: string; claudeSessionId?: string; codexThreadId?: string }): void {
  if (!captured) return;
  if (metadata.path !== captured.baseDirectory) throw new Error('RESERVATION_BASE_DIRECTORY_MISMATCH');
  assertReservationProviderResume(captured.provider, captured.provider === 'claude' ? metadata.claudeSessionId : metadata.codexThreadId);
}
