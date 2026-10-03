import { createHash, randomUUID, verify, type KeyObject } from 'node:crypto';
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
export function decisionBytes(value: ScopeDecision): Buffer {
  return Buffer.from(JSON.stringify([value.version, value.requestId, value.digest, value.incarnation,
    value.accountId, value.machineId, value.sessionId, value.action]));
}
type Entry = { request: ScopeRequest; inspected: WriteRoot };
type Dependencies = {
  changed?: (requests: ScopeRequest[]) => Promise<void>;
  publicKey: KeyObject; machineId: string; accountId: string; incarnation: string; now?: () => number;
  resolveSession: (id: string) => Promise<{ projectRoot: string; generation: string } | null>;
  canonicalize: (path: string) => Promise<WriteRoot>;
  apply: (request: ScopeRequest, roots: readonly WriteRoot[]) => Promise<{
    profileApplied: boolean; cleanup: 'unresolved' | 'confirmed';
  }>;
};

/** In-memory, daemon-owned authority. Restart expires requests and never restores grants. */
export class SessionWriteScopeBroker {
  private readonly entries = new Map<string, Entry>();
  private readonly grants = new Map<string, Map<string, WriteRoot>>();
  private readonly busy = new Set<string>();
  private readonly now: () => number;
  constructor(private readonly deps: Dependencies) { this.now = deps.now ?? Date.now; }
  private expire(): void {
    for (const { request } of this.entries.values()) {
      if (request.state === 'pending' && request.expiresAt <= this.now()) request.state = 'expired';
    }
  }
  list(sessionId: string): ScopeRequest[] {
    this.expire();
    return [...this.entries.values()].filter(entry => entry.request.sessionId === sessionId)
      .map(entry => ({ ...entry.request, grantActive: entry.request.kind === 'grant' && this.grants.get(sessionId)?.has(entry.request.root) === true }));
  }
  async request(sessionId: string, path: string, description: string, kind: 'grant' | 'revoke' = 'grant'): Promise<ScopeRequest> {
    if (!description || description.length > 240 || /[\x00-\x1f\x7f]/.test(description)
      || /(?:secret|token|password|api[_ -]?key|cookie|authorization)\s*[:=]|Bearer\s|-----BEGIN|https?:\/\/\S+[?@]/i.test(description)) {
      throw new Error('SECRET_FREE_DESCRIPTION_REQUIRED');
    }
    this.expire();
    const session = await this.deps.resolveSession(sessionId);
    if (!session) throw new Error('SESSION_SCOPE_UNSUPPORTED');
    const inspected = await this.deps.canonicalize(path);
    if (kind === 'revoke' && !this.grants.get(sessionId)?.has(inspected.root)) throw new Error('GRANT_NOT_ACTIVE');
    const duplicate = this.list(sessionId).find(request => request.state === 'pending'
      && request.root === inspected.root && request.kind === kind);
    if (duplicate) return duplicate;
    if (this.entries.size >= 128) throw new Error('REQUEST_LIMIT_REACHED');
    if (kind === 'grant' && (this.grants.get(sessionId)?.size ?? 0) >= 8) throw new Error('GRANT_LIMIT_REACHED');
    const descriptor = { version: 1 as const, id: randomUUID(), incarnation: this.deps.incarnation,
      accountId: this.deps.accountId, machineId: this.deps.machineId, sessionId, ...session,
      requestedPath: path, root: inspected.root, description, kind, createdAt: this.now(), expiresAt: this.now() + 600000 };
    const digest = createHash('sha256').update(JSON.stringify([descriptor, inspected.identity, inspected.floor])).digest('hex');
    const request: ScopeRequest = { ...descriptor, digest, state: 'pending' };
    this.entries.set(request.id, { request, inspected });
    await this.persist();
    return { ...request };
  }
  private persist(): Promise<void> {
    return this.deps.changed?.([...this.entries.values()].map(entry => ({ ...entry.request }))) ?? Promise.resolve();
  }
  async cancel(sessionId: string, id: string): Promise<ScopeRequest> {
    this.expire();
    const request = this.entries.get(id)?.request;
    if (!request || request.sessionId !== sessionId || request.state !== 'pending') throw new Error('REQUEST_NOT_PENDING');
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
    if (!entry || entry.request.state !== 'pending') throw new Error('REQUEST_NOT_PENDING');
    const { request, inspected } = entry;
    if (decision.digest !== request.digest || decision.incarnation !== request.incarnation
      || decision.accountId !== request.accountId || decision.machineId !== request.machineId
      || decision.sessionId !== request.sessionId) throw new Error('APPROVAL_BINDING_MISMATCH');
    if (decision.action !== 'allow') {
      request.state = decision.action === 'project' ? 'project-local' : 'cancelled'; await this.persist(); return { ...request };
    }
    if (this.busy.has(request.sessionId)) throw new Error('SESSION_SCOPE_BUSY');
    request.state = 'applying'; this.busy.add(request.sessionId);
    try {
      await this.persist();
      const session = await this.deps.resolveSession(request.sessionId);
      const current = await this.deps.canonicalize(request.requestedPath);
      if (!session || session.generation !== request.generation || session.projectRoot !== request.projectRoot
        || current.root !== inspected.root || current.identity !== inspected.identity
        || JSON.stringify(current.floor) !== JSON.stringify(inspected.floor)) throw new Error('WRITE_SCOPE_CHANGED');
      if (request.expiresAt <= this.now()) throw new Error('REQUEST_EXPIRED');
      const roots = new Map(this.grants.get(request.sessionId));
      for (const root of roots.values()) {
        const checked = await this.deps.canonicalize(root.root);
        if (checked.root !== root.root || checked.identity !== root.identity
          || JSON.stringify(checked.floor) !== JSON.stringify(root.floor)) throw new Error('WRITE_SCOPE_CHANGED');
      }
      if (request.expiresAt <= this.now()) throw new Error('REQUEST_EXPIRED');
      if (request.kind === 'revoke') roots.delete(request.root); else roots.set(request.root, inspected);
      // Remove the future grant before a revoke attempt; failure must not restore it.
      if (request.kind === 'revoke') this.grants.set(request.sessionId, roots);
      const result = await this.deps.apply({ ...request }, [...roots.values()]);
      request.profileApplied = result.profileApplied; request.cleanup = result.cleanup;
      if (result.profileApplied) this.grants.set(request.sessionId, roots);
      request.state = result.cleanup === 'unresolved' ? 'cleanup-unresolved'
        : result.profileApplied ? 'applied' : 'failed';
    } catch { request.state = 'failed'; request.error = 'SCOPE_APPLICATION_FAILED'; }
    finally { this.busy.delete(request.sessionId); }
    await this.persist();
    return { ...request, grantActive: request.kind === 'grant' && this.grants.get(request.sessionId)?.has(request.root) === true };
  }
  sessionEnded(sessionId: string): void { this.grants.delete(sessionId); }
}
