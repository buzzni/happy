/** A wake-up is an input, never authority to retry a command or restore a grant. */
import axios from 'axios';
import { z } from 'zod';
import { sessionEnvelopeSchema } from '@slopus/happy-wire';
import { AgentMessageSchema, FileEventMessageSchema } from '@/api/types';
import { readMessageAck } from '@/api/apiSession';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import type { ScopeRequest } from './sessionWriteScope';
import type { SessionEncryptionData, TrackedSession } from './types';

// sendSessionEvent/sendCodexMessage still write these legacy output variants.
const agentHistorySchema = AgentMessageSchema.extend({ content: AgentMessageSchema.shape.content.extend({
  type: z.enum(['output', 'event', 'codex']),
}) });

type Baseline = { sessionId: string; capturedAt: number; seq: number; encryption: SessionEncryptionData };
type Pending = { request: ScopeRequest; baseline: Baseline; pid: number };
type Batch = { candidates: Pending[]; deadline: number; attempts: number; nextAttemptAt: number; scannedSeq?: number; failures: number;
  delivery?: { requestId: string; localId: string; content: string } };
export function createSessionWriteScopeContinuation(options: {
  serverUrl: string;
  findSession(id: string): TrackedSession | undefined;
  list(id: string): ScopeRequest[];
  readToken(session: TrackedSession): Promise<string | null>;
  log(message: string): void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const baselines = new Map<string, Baseline>();
  const pending = new Map<string, Batch>();
  const ownDeliveries = new Map<string, string>();
  const deliveryKey = (sessionId: string, localId: string) => `${sessionId}:${localId}`;
  const controller = new AbortController();
  let flushing = false;
  const current = (candidate: Pending): TrackedSession | undefined => {
    if (controller.signal.aborted) return;
    const session = options.findSession(candidate.request.sessionId);
    const request = options.list(candidate.request.sessionId).find(r => r.id === candidate.request.id);
    if (!request?.grantActive || !request.profileApplied || request.kind !== 'grant'
      || !['applied', 'cleanup-unresolved'].includes(request.state)
      || !session || session.startedBy !== 'daemon' || session.happySessionId !== candidate.request.sessionId
      || session.pid !== candidate.pid || !session.childProcess
      || session.childProcess.exitCode !== null || session.childProcess.signalCode !== null
      || !session.encryption || session.encryption.encryptionVariant !== candidate.baseline.encryption.encryptionVariant
      || !Buffer.from(session.encryption.encryptionKey).equals(Buffer.from(candidate.baseline.encryption.encryptionKey))) return;
    return session;
  };
  const ready = (session: TrackedSession) => session.runtime && !session.runtime.thinking
    && !session.runtime.hasOpenToolCall && !session.runtime.pendingUserInput;
  return {
    capture(request: ScopeRequest) {
      // A folder approval grants access; it does not supersede a newer human instruction.
      if (controller.signal.aborted || request.kind !== 'grant') return;
      const session = options.findSession(request.sessionId), seq = session?.runtime?.lastProcessedSeq;
      if (session?.encryption && Number.isSafeInteger(seq) && seq! >= 0) {
        baselines.set(request.id, { sessionId: request.sessionId, capturedAt: now(), seq: seq!,
          encryption: { ...session.encryption, encryptionKey: Uint8Array.from(session.encryption.encryptionKey) } });
      }
    },
    applied(request: ScopeRequest) {
      const baseline = baselines.get(request.id), session = options.findSession(request.sessionId);
      if (!baseline) options.log('[write-scope] continuation baseline unavailable');
      if (!session) options.log('[write-scope] continuation target unavailable');
      if (!baseline || !session || controller.signal.aborted || !request.profileApplied || !request.grantActive || request.kind !== 'grant') return;
      const batch = pending.get(request.sessionId) ?? { candidates: [], deadline: now() + 300_000, attempts: 0, nextAttemptAt: 0, failures: 0 };
      // Only this confirmed scope replacement may advance an already queued candidate's PID.
      for (const candidate of batch.candidates) candidate.pid = session.pid;
      if (!batch.candidates.some(c => c.request.id === request.id)) batch.candidates.push({ request: { ...request }, baseline, pid: session.pid });
      pending.set(request.sessionId, batch);
    },
    async flush() {
      if (flushing || controller.signal.aborted) return;
      flushing = true;
      try {
        for (const [id, batch] of pending) {
          if (now() >= batch.deadline || batch.attempts >= 3) {
            options.log('[write-scope] continuation exhausted its deadline or delivery attempts');
            pending.delete(id); continue;
          }
          if (now() < batch.nextAttemptAt) continue;
          const records = options.list(id);
          // An unapproved request must not stall an already approved task for ten minutes.
          if (records.some(r => r.state === 'applying')) continue;
          batch.candidates = batch.candidates.filter(c => records.some(r => r.id === c.request.id && r.grantActive));
          const candidate = batch.delivery ? batch.candidates.find(c => c.request.id === batch.delivery!.requestId) : batch.candidates.at(-1);
          if (!candidate) { pending.delete(id); continue; }
          const session = current(candidate);
          if (!session) {
            // Missing initial runtime/target reports can be temporary; end/close explicitly discard.
            const raw = options.findSession(id);
            if (raw && (raw.pid !== candidate.pid || raw.childProcess?.exitCode !== null
              || raw.childProcess?.signalCode !== null)) pending.delete(id);
            continue;
          }
          if (!ready(session)) continue;
          try {
            const token = await options.readToken(session);
            if (!token || !current(candidate) || !ready(session)) continue;
            const headers = { Authorization: `Bearer ${token}`, 'X-Happy-Client': 'cli-daemon/session-write-scope' };
            let afterSeq = batch.scannedSeq ?? Math.min(...batch.candidates.map(c => c.baseline.seq));
            let complete = false, intervened = false, stored = false;
            for (let page = 0; page < 10 && !complete && !intervened && !stored; page++) {
              const response = await axios.get(`${options.serverUrl}/v3/sessions/${encodeURIComponent(id)}/messages`, {
                params: { after_seq: afterSeq, limit: 50 }, headers, timeout: 10_000,
                signal: controller.signal, maxContentLength: 4 * 1024 * 1024, maxRedirects: 0,
              });
              const data = response.data;
              if (!Array.isArray(data?.messages) || typeof data.hasMore !== 'boolean') throw new Error('Unknown history');
              for (const message of data.messages) {
                if (!Number.isSafeInteger(message.seq) || message.seq <= afterSeq
                  || message.content?.t !== 'encrypted' || typeof message.content.c !== 'string') throw new Error('Invalid history');
                afterSeq = message.seq;
                if (batch.delivery && message.localId === batch.delivery.localId && message.content.c === batch.delivery.content) { stored = true; break; }
                // Meta is client-authored. Ignore only ciphertext this live daemon actually sent
                // in this session, so A's wake-up cannot suppress a later approval of B.
                if (typeof message.localId === 'string' && ownDeliveries.get(deliveryKey(id, message.localId)) === message.content.c) {
                  batch.scannedSeq = afterSeq; continue;
                }
                const decoded = decrypt(candidate.baseline.encryption.encryptionKey, candidate.baseline.encryption.encryptionVariant,
                  decodeBase64(message.content.c)) as { role?: unknown; content?: unknown } | null;
                if (decoded?.role === 'user' || FileEventMessageSchema.safeParse(decoded).success) { intervened = true; break; }
                if (decoded?.role === 'session') {
                  // CLI projections, including already-consumed user text, are not actionable input.
                  const envelope = sessionEnvelopeSchema.safeParse(decoded.content);
                  if (envelope.success) { batch.scannedSeq = afterSeq; continue; }
                } else if (agentHistorySchema.safeParse(decoded).success) { batch.scannedSeq = afterSeq; continue; }
                throw new Error('Unknown message');
              }
              complete = data.hasMore === false;
              if (!complete && data.messages.length === 0) throw new Error('History made no progress');
            }
            if (intervened || stored) { options.log(`[write-scope] continuation ${stored ? 'already stored' : 'superseded by input'} at seq=${afterSeq}`); pending.delete(id); continue; }
            if (!complete) throw new Error('History budget exceeded');
            const fresh = current(candidate);
            if (!fresh || !ready(fresh) || options.list(id).some(r => r.state === 'applying')) continue;
            if (!batch.delivery) {
              const localId = `write-scope-applied-${candidate.request.id}`;
              const text = '[session-write-scope] Folder access was applied. Check session_write_scope action=list, '
                + 'then continue the previously authorized task if it remains pending. Prefer newer user instructions; '
                + 'do not repeat completed work. This is not installation success or permission for new work.';
              batch.delivery = { requestId: candidate.request.id, localId,
                content: encodeBase64(encrypt(fresh.encryption!.encryptionKey, fresh.encryption!.encryptionVariant, {
                  role: 'user', content: { type: 'text', text }, localKey: localId,
                  meta: { sentFrom: 'daemon', source: 'session-write-scope' },
                })) };
            }
            ownDeliveries.set(deliveryKey(id, batch.delivery.localId), batch.delivery.content);
            if (ownDeliveries.size > 512) ownDeliveries.delete(ownDeliveries.keys().next().value!);
            batch.attempts += 1;
            const result = await axios.post(`${options.serverUrl}/v3/sessions/${encodeURIComponent(id)}/messages`, {
              messages: [{ localId: batch.delivery.localId, content: batch.delivery.content }],
            }, { headers, timeout: 10_000, signal: controller.signal, maxContentLength: 1024 * 1024, maxRedirects: 0 });
            if (!readMessageAck(result.data?.messages, batch.delivery.localId).ok) throw new Error('Unconfirmed continuation');
            pending.delete(id);
          } catch (error) {
            const reason = error instanceof Error && ['Unknown history', 'Invalid history', 'Unknown message', 'History made no progress', 'History budget exceeded', 'Unconfirmed continuation'].includes(error.message) ? error.message : 'transport';
            batch.failures += 1;
            batch.nextAttemptAt = now() + Math.min(30_000, 1000 * 2 ** Math.min(batch.failures - 1, 5));
            options.log(`[write-scope] continuation pending (${reason}); only the same message may be retried`);
          }
        }
        for (const [key, baseline] of baselines) {
          const request = options.list(baseline.sessionId).find(r => r.id === key);
          // Terminal state may precede the final journal write in a concurrent poll.
          if (!pending.has(baseline.sessionId) && (now() - baseline.capturedAt > 20 * 60_000
            || !request || ['cancelled', 'project-local', 'expired', 'failed'].includes(request.state))) baselines.delete(key);
        }
      } finally { flushing = false; }
    },
    sessionEnded(id: string) { pending.delete(id); for (const [key, b] of baselines) if (b.sessionId === id) baselines.delete(key); },
    close() { controller.abort(); pending.clear(); baselines.clear(); ownDeliveries.clear(); },
  };
}
