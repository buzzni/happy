import { createHash, randomUUID, verify, type KeyObject } from 'node:crypto';
import { logger } from '@/ui/logger';
import { scopeErrorCode } from './sessionWriteScopeErrors';
import type { WriteRoot } from './sessionWriteScopePaths';

export type ScopeState = 'pending' | 'applying' | 'applied' | 'failed' | 'cancelled' | 'project-local' | 'expired' | 'cleanup-unresolved';
export type ScopeDecision = {
  version: 1; requestId: string; digest: string; incarnation: string; accountId: string;
  machineId: string; sessionId: string; action: 'allow' | 'project' | 'cancel';
};
export type ScopeRequest = {
  version: 1; id: string; digest: string; incarnation: string; accountId: string; machineId: string;
  sessionId: string; generation: string; projectRoot: string; root: string; requestedPath: string;
  description: string; kind: 'grant' | 'revoke'; createdAt: number; expiresAt: number;
  state: ScopeState; grantActive?: boolean; profileApplied?: boolean; cleanup?: 'unresolved' | 'confirmed'; error?: string;
};
/** Prune ordinary status history only; uncertainty and authority are never aged out. */
export function retainScopeHistory(requests: readonly ScopeRequest[]): ScopeRequest[] {
  const protectedRecord = (request: ScopeRequest) => request.grantActive === true || request.cleanup === 'unresolved'
    || ['pending', 'applying', 'applied', 'cleanup-unresolved'].includes(request.state);
  const safety = requests.filter(protectedRecord);
  const available = Math.max(0, Math.min(128, 512 - safety.length));
  const ordinary = requests.filter(request => !protectedRecord(request)).sort((a, b) => a.createdAt - b.createdAt);
  const retained = new Set([...safety, ...(available ? ordinary.slice(-available) : [])]);
  return requests.filter(request => retained.has(request));
}
export function decisionBytes(value: ScopeDecision): Buffer {
  return Buffer.from(JSON.stringify([value.version, value.requestId, value.digest, value.incarnation,
    value.accountId, value.machineId, value.sessionId, value.action]));
}
type Entry = { request: ScopeRequest; inspected: WriteRoot };
type Dependencies = {
  readiness?: (request: ScopeRequest) => string | undefined;
  changed?: (requests: ScopeRequest[]) => Promise<void>;
  publicKey: KeyObject; machineId: string; accountId: string; incarnation: string; now?: () => number;
  resolveSession: (id: string) => Promise<{ projectRoot: string; generation: string } | null>;
  canonicalize: (path: string) => Promise<WriteRoot>;
  apply: (request: ScopeRequest, roots: readonly WriteRoot[]) => Promise<{
    profileApplied: boolean; cleanup: 'unresolved' | 'confirmed'; error?: string;
  }>;
};

/** In-memory, daemon-owned authority. Restart expires requests and never restores grants. */
export class SessionWriteScopeBroker {
  private persistTail: Promise<void> = Promise.resolve();
  private requestTail: Promise<unknown> = Promise.resolve();
  private readonly entries = new Map<string, Entry>();
  private readonly grants = new Map<string, Map<string, WriteRoot>>();
  private readonly accepted = new Map<string, number>();
  private readonly retries = new Map<string, number>();
  private readonly waiting = new Set<string>();
  private readonly busy = new Set<string>();
  private readonly now: () => number;
  constructor(private readonly deps: Dependencies) { this.now = deps.now ?? Date.now; }
  private expire(): void {
    for (const { request } of this.entries.values()) {
      if (request.state === 'pending' && request.expiresAt <= this.now()) request.state = 'expired';
    }
    const retained = new Set(retainScopeHistory([...this.entries.values()]
      .map(entry => ({ ...entry.request, grantActive: this.grantActive(entry.request) }))).map(request => request.id));
    for (const id of this.entries.keys()) if (!retained.has(id)) {
      this.entries.delete(id); this.accepted.delete(id); this.retries.delete(id); this.waiting.delete(id);
    }
  }
  private grantActive(request: ScopeRequest): boolean {
    return request.kind === 'grant' && request.profileApplied === true
      && this.grants.get(request.sessionId)?.has(request.root) === true;
  }
  list(sessionId: string): ScopeRequest[] {
    this.expire();
    return [...this.entries.values()].filter(entry => entry.request.sessionId === sessionId)
      .map(entry => ({ ...entry.request, grantActive: this.grantActive(entry.request) }));
  }
  request(sessionId: string, path: string, description: string, kind: 'grant' | 'revoke' = 'grant'): Promise<ScopeRequest> {
    // Staged requests are neither visible nor approvable until durable admission succeeds.
    const operation = this.requestTail.catch(() => {}).then(() => this.createRequest(sessionId, path, description, kind));
    this.requestTail = operation;
    return operation;
  }
  private async createRequest(sessionId: string, path: string, description: string, kind: 'grant' | 'revoke'): Promise<ScopeRequest> {
    if (!description || description.length > 240 || /[\x00-\x1f\x7f]/.test(description)
      || /(?:secret|token|password|api[_ -]?key|cookie|authorization)\s*[:=]|Bearer\s|-----BEGIN|https?:\/\/\S+[?@]/i.test(description)) {
      throw new Error('SECRET_FREE_DESCRIPTION_REQUIRED');
    }
    this.expire();
    const session = await this.deps.resolveSession(sessionId);
    if (!session) throw new Error('SESSION_SCOPE_UNSUPPORTED');
    // Revocation removes a saved grant; it never approves the current filesystem target.
    const granted = kind === 'revoke' ? this.grants.get(sessionId)?.get(path) : undefined;
    if (kind === 'revoke' && !granted) throw new Error('GRANT_NOT_ACTIVE');
    const inspected = granted ?? await this.deps.canonicalize(path);
    const duplicate = this.list(sessionId).find(request => (request.state === 'pending' || this.waiting.has(request.id))
      && request.root === inspected.root && request.kind === kind);
    if (duplicate) return duplicate;
    if ([...this.entries.values()].filter(entry => ['pending', 'applying'].includes(entry.request.state)).length >= 128) throw new Error('REQUEST_LIMIT_REACHED');
    if (kind === 'grant' && (this.grants.get(sessionId)?.size ?? 0) >= 8) throw new Error('GRANT_LIMIT_REACHED');
    const descriptor = { version: 1 as const, id: randomUUID(), incarnation: this.deps.incarnation,
      accountId: this.deps.accountId, machineId: this.deps.machineId, sessionId, ...session,
      requestedPath: path, root: inspected.root, description, kind, createdAt: this.now(), expiresAt: this.now() + 600000 };
    const digest = createHash('sha256').update(JSON.stringify([descriptor, inspected.identity, inspected.floor])).digest('hex');
    const request: ScopeRequest = { ...descriptor, digest, state: 'pending' };
    await this.persist(request);
    this.entries.set(request.id, { request, inspected });
    return { ...request };
  }
  private persist(staged?: ScopeRequest): Promise<void> {
    // Snapshot at our turn, after earlier admission has published its durable entry.
    const operation = this.persistTail.catch(() => {}).then(async () => {
      const requests: ScopeRequest[] = [...this.entries.values()].map(entry => ({ ...entry.request, grantActive: this.grantActive(entry.request) }));
      if (staged) requests.push({ ...staged });
      await this.deps.changed?.(requests);
    });
    this.persistTail = operation;
    return operation;
  }
  async cancel(sessionId: string, id: string): Promise<ScopeRequest> {
    this.expire();
    const request = this.entries.get(id)?.request;
    if (!request || request.sessionId !== sessionId || (request.state !== 'pending' && !this.waiting.has(id))) throw new Error('REQUEST_NOT_PENDING');
    this.waiting.delete(id); delete request.error;
    request.state = 'cancelled'; await this.persist(); return { ...request };
  }
  /** Called only with host-signed decisions; loopback bearer is transport authentication only. */
  async decide(envelope: { decision: ScopeDecision; signature: string }): Promise<ScopeRequest> {
    this.expire();
    const { decision } = envelope;
    if (!decision || decision.version !== 1 || !['allow', 'project', 'cancel'].includes(decision.action)
      || typeof envelope.signature !== 'string' || envelope.signature.length > 128
      || !verify(null, decisionBytes(decision), this.deps.publicKey, Buffer.from(envelope.signature, 'base64url'))) {
      throw new Error('INVALID_APPROVAL');
    }
    const entry = this.entries.get(decision.requestId);
    if (!entry) throw new Error('REQUEST_NOT_PENDING');
    const { request, inspected } = entry;
    if (decision.digest !== request.digest || decision.incarnation !== request.incarnation
      || decision.accountId !== request.accountId || decision.machineId !== request.machineId
      || decision.sessionId !== request.sessionId) throw new Error('APPROVAL_BINDING_MISMATCH');
    if (this.deps.readiness && this.accepted.has(request.id)) {
      if (decision.action === 'allow') return { ...request, grantActive: this.grantActive(request) };
      if (decision.action === 'cancel' && this.waiting.has(request.id)) return this.cancel(request.sessionId, request.id);
    }
    if (request.state !== 'pending') throw new Error('REQUEST_NOT_PENDING');
    if (decision.action !== 'allow') {
      request.state = decision.action === 'project' ? 'project-local' : 'cancelled'; await this.persist(); return { ...request };
    }
    if (this.deps.readiness) {
      request.state = 'applying'; request.error = 'SCOPE_WAITING_TURN';
      try { await this.persist(); }
      catch (error) { request.state = 'failed'; request.error = 'SCOPE_JOURNAL_FAILED'; throw new Error('SCOPE_JOURNAL_FAILED'); }
      this.accepted.set(request.id, this.now() + 600000); this.waiting.add(request.id);
      return { ...request, grantActive: this.grantActive(request) };
    }
    if (this.busy.has(request.sessionId)) throw new Error('SESSION_SCOPE_BUSY');
    return this.applyRequest(request, inspected, request.expiresAt);
  }
  /** Only this live broker owns accepted approvals; disk history never schedules work. */
  async flush(): Promise<void> {
    const operations: Promise<unknown>[] = [];
    for (const id of this.waiting) {
      const entry = this.entries.get(id);
      if (!entry || this.busy.has(entry.request.sessionId)) continue;
      const { request, inspected } = entry;
      const deadline = this.accepted.get(id)!;
      try {
        if (deadline <= this.now()) {
          this.waiting.delete(id); request.state = 'expired'; request.error = 'REQUEST_EXPIRED';
          operations.push(this.persist()); continue;
        }
        const reason = this.deps.readiness?.({ ...request });
        if (reason) {
          if (request.error !== reason) { request.error = reason; operations.push(this.persist()); }
          continue;
        }
        this.waiting.delete(id);
        operations.push(this.applyRequest(request, inspected, deadline));
      } catch (error) {
        this.waiting.delete(id); request.state = 'failed'; request.error = scopeErrorCode(error);
        operations.push(this.persist());
      }
    }
    await Promise.all(operations);
  }
  private async applyRequest(request: ScopeRequest, inspected: WriteRoot, deadline: number): Promise<ScopeRequest> {
    delete request.error;
    let withdrawn = false; let phaseError = 'SCOPE_JOURNAL_FAILED';
    request.state = 'applying'; this.busy.add(request.sessionId);
    try {
      await this.persist();
      phaseError = 'SCOPE_APPLICATION_FAILED';
      const session = await this.deps.resolveSession(request.sessionId);
      if (!session || session.generation !== request.generation || session.projectRoot !== request.projectRoot) throw new Error('WRITE_SCOPE_CHANGED');
      if (request.kind === 'grant') {
        const current = await this.deps.canonicalize(request.requestedPath);
        if (current.root !== inspected.root || current.identity !== inspected.identity
          || JSON.stringify(current.floor) !== JSON.stringify(inspected.floor)) throw new Error('WRITE_SCOPE_CHANGED');
      }
      if (deadline <= this.now()) throw new Error('REQUEST_EXPIRED');
      const roots = new Map(this.grants.get(request.sessionId));
      if (request.kind === 'grant' && !roots.has(request.root) && roots.size >= 8) throw new Error('GRANT_LIMIT_REACHED');
      if (request.kind === 'revoke') {
        if (roots.get(request.root) !== inspected) throw new Error('GRANT_NOT_ACTIVE');
        roots.delete(request.root);
        // A failed replacement must not restore a withdrawn future grant.
        this.grants.set(request.sessionId, roots); withdrawn = true;
      }
      for (const root of roots.values()) {
        const checked = await this.deps.canonicalize(root.root);
        if (checked.root !== root.root || checked.identity !== root.identity
          || JSON.stringify(checked.floor) !== JSON.stringify(root.floor)) throw new Error('WRITE_SCOPE_CHANGED');
      }
      if (deadline <= this.now()) throw new Error('REQUEST_EXPIRED');
      if (request.kind === 'grant') roots.set(request.root, inspected);
      const result = await this.deps.apply({ ...request, expiresAt: deadline }, [...roots.values()]);
      if (result.error) request.error = scopeErrorCode(result.error);
      request.profileApplied = result.profileApplied; request.cleanup = result.cleanup;
      if (result.profileApplied) this.grants.set(request.sessionId, roots);
      request.state = result.cleanup === 'unresolved' ? 'cleanup-unresolved'
        : result.profileApplied ? 'applied' : 'failed';
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const retries = this.retries.get(request.id) ?? 0;
      if (!withdrawn && this.accepted.has(request.id) && ['SESSION_SCOPE_BUSY', 'SCOPE_DRAIN_RETRY_SAFE'].includes(code)
        && retries < 3 && deadline > this.now()) {
        this.retries.set(request.id, retries + 1); this.waiting.add(request.id);
        request.error = 'SCOPE_WAITING_TURN';
      } else { request.state = withdrawn ? 'cleanup-unresolved' : 'failed';
        if (withdrawn) request.cleanup = 'unresolved';
        request.error = retries >= 3 ? 'SCOPE_BUSY_RETRY_EXHAUSTED' : scopeErrorCode(error, phaseError); }
    }
    finally { this.busy.delete(request.sessionId); }
    logger.debug(`[write-scope] request=${request.id} state=${request.state} code=${request.error ?? 'NONE'}`);
    try { await this.persist(); }
    catch { request.error = 'SCOPE_JOURNAL_FAILED'; throw new Error('SCOPE_JOURNAL_FAILED'); }
    return { ...request, grantActive: this.grantActive(request) };
  }
  sessionEnded(sessionId: string): void { this.grants.delete(sessionId); }
}
