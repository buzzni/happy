import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOrgRequirementsAuditLog } from './audit';
import { createOrgRequirementsSnapshot, ORG_REFRESH_AFTER_MS, ORG_STALE_AFTER_MS, type OrgRequirementsFetchOutcome } from './snapshot';
import { createOrgRequirementsStore, type OrgScopeKey } from './store';

const HOUR = 60 * 60 * 1000;
const doc = (companyId: string, revision: number, items: Record<string, unknown> = { 'permissions.mode': { kind: 'ceiling', max: 'default' } }) =>
    ({ schemaVersion: 1, companyId, revision, modelPolicyUpdatedAt: null, issuedAt: 1, items });
const ok = (requirements: unknown): OrgRequirementsFetchOutcome => ({ kind: 'response', status: 'ok', requirements });

describe('organization requirements snapshot', () => {
    let home: string;
    let clock: number;
    let scopes: OrgScopeKey[];
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'org-req-snap-'));
        clock = Date.UTC(2026, 9, 31, 9);
        scopes = [{ kind: 'session', id: 's1' }, { kind: 'project', id: 'p1' }];
    });
    afterEach(() => { rmSync(home, { recursive: true, force: true }); });
    const auditPath = () => join(home, 'logs', 'org-requirements.jsonl');
    const audited = () => existsSync(auditPath()) ? readFileSync(auditPath(), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
    const make = (overrides: { scopes?: OrgScopeKey[] } = {}) => createOrgRequirementsSnapshot({
        store: createOrgRequirementsStore({ happyHomeDir: home, serverUrl: 'https://s', accountKey: 'a', now: () => clock }),
        audit: createOrgRequirementsAuditLog({ path: auditPath(), sessionId: () => 's1' }),
        scopes: () => overrides.scopes ?? scopes,
        now: () => clock,
    });

    it('is outside any organization until something says otherwise', () => {
        const snapshot = make();
        expect(snapshot.current()).toBeNull();
        expect(snapshot.publicState()).toBeNull();
        snapshot.ingest({ kind: 'not-configured' });
        expect(snapshot.publicState()).toBeNull();
        snapshot.ingest({ kind: 'response', status: 'no-company', requirements: null });
        expect(snapshot.current()).toBeNull();
        expect(snapshot.publicState()).toBeNull();
        expect(audited()).toEqual([]);
    });

    it('takes an ok document, keeps it as last known good and maps the scopes to its organization', () => {
        const snapshot = make();
        snapshot.ingest(ok(doc('c1', 3)));
        expect(snapshot.current()?.revision).toBe(3);
        expect(snapshot.publicState()).toEqual({ state: 'ok', revision: 3 });
        // A later session in the same project that cannot reach Studio finds it.
        const later = make({ scopes: [{ kind: 'session', id: 's2' }, { kind: 'project', id: 'p1' }] });
        later.ingest({ kind: 'failed' });
        expect(later.current()?.revision).toBe(3);
        expect(later.publicState()).toEqual({ state: 'ok', revision: 3 });
    });

    it('keeps the document in use when a later lookup fails or cannot resolve the organization', () => {
        const snapshot = make();
        snapshot.ingest(ok(doc('c1', 3)));
        for (const outcome of [{ kind: 'failed' }, { kind: 'response', status: 'unavailable', requirements: null }, { kind: 'response', status: 'unresolved', requirements: null }, { kind: 'response', status: undefined, requirements: undefined }] as OrgRequirementsFetchOutcome[]) {
            snapshot.ingest(outcome);
            expect(snapshot.current()?.revision).toBe(3);
        }
    });

    it('releases only on an ok response with no items, and forgets that organization last known good', () => {
        const snapshot = make();
        snapshot.ingest(ok(doc('c1', 3)));
        snapshot.ingest(ok(doc('c1', 4, {})));
        expect(snapshot.current()).toBeNull();
        expect(snapshot.publicState()).toBeNull();
        const later = make({ scopes: [{ kind: 'project', id: 'p1' }] });
        later.ingest({ kind: 'failed' });
        expect(later.current()).toBeNull();
    });

    it('drops this scope from its organization on no-company without touching that organization document', () => {
        const first = make();
        first.ingest(ok(doc('c1', 3)));
        const moved = make();
        moved.ingest({ kind: 'response', status: 'no-company', requirements: null });
        expect(moved.current()).toBeNull();
        moved.ingest({ kind: 'failed' });
        expect(moved.current()).toBeNull();
        // Another project of c1 still has c1's document.
        const other = make({ scopes: [{ kind: 'project', id: 'p2' }] });
        other.ingest(ok(doc('c1', 5)));
        expect(other.current()?.revision).toBe(5);
    });

    it('starts without requirements and says unknown when nothing was ever received', () => {
        const snapshot = make();
        snapshot.ingest({ kind: 'failed' });
        expect(snapshot.current()).toBeNull();
        expect(snapshot.publicState()).toEqual({ state: 'unknown' });
        expect(audited().map((entry) => [entry.item, entry.applied])).toEqual([['state', 'unknown']]);
        snapshot.ingest({ kind: 'failed' });
        expect(audited()).toHaveLength(1);
    });

    it('marks the snapshot stale after 24 hours without a successful lookup, and keeps enforcing it', () => {
        const snapshot = make();
        snapshot.ingest(ok(doc('c1', 3)));
        clock += ORG_STALE_AFTER_MS - 1;
        snapshot.ingest({ kind: 'failed' });
        expect(snapshot.publicState()).toEqual({ state: 'ok', revision: 3 });
        clock += 2;
        expect(snapshot.publicState()).toEqual({ state: 'stale', revision: 3 });
        expect(snapshot.current()?.revision).toBe(3);
        snapshot.ingest(ok(doc('c1', 3)));
        expect(snapshot.publicState()).toEqual({ state: 'ok', revision: 3 });
    });

    it('measures staleness from when the last known good was received, across processes', () => {
        make().ingest(ok(doc('c1', 3)));
        clock += 25 * HOUR;
        const later = make();
        later.ingest({ kind: 'failed' });
        expect(later.publicState()).toEqual({ state: 'stale', revision: 3 });
    });

    it('rejects an unknown schemaVersion as a failed lookup and keeps the previous document', () => {
        const snapshot = make();
        snapshot.ingest(ok(doc('c1', 3)));
        snapshot.ingest(ok({ ...doc('c1', 9), schemaVersion: 2 }));
        expect(snapshot.current()?.revision).toBe(3);
        expect(audited().some((entry) => entry.reason === 'document_rejected')).toBe(true);
    });

    it('keeps a broken known item from the previous document and audits what it dropped', () => {
        const snapshot = make();
        snapshot.ingest(ok(doc('c1', 3, { 'permissions.mode': { kind: 'ceiling', max: 'acceptEdits' } })));
        snapshot.ingest(ok(doc('c1', 4, { 'permissions.mode': { kind: 'ceiling', max: 'everything' }, 'network.egress': { kind: 'fixed', value: false } })));
        expect(snapshot.current()?.items['permissions.mode']).toEqual({ kind: 'ceiling', max: 'acceptEdits' });
        expect(audited().filter((entry) => entry.reason === 'document_issue').map((entry) => entry.item)).toEqual(['permissions.mode', 'network.egress']);
    });

    it('keeps a broken item from the stored last known good on the first answer of a new process (R3)', () => {
        make().ingest(ok(doc('c1', 3, { 'permissions.mode': { kind: 'ceiling', max: 'acceptEdits' } })));
        const later = make();
        later.ingest(ok(doc('c1', 4, { 'permissions.mode': { kind: 'ceiling', max: 'readonly' } })));
        expect(later.current()?.items['permissions.mode']).toEqual({ kind: 'ceiling', max: 'acceptEdits' });
        // And what it stores still has it.
        const fallback = make({ scopes: [{ kind: 'project', id: 'p1' }] });
        fallback.ingest({ kind: 'failed' });
        expect(fallback.current()?.items['permissions.mode']).toEqual({ kind: 'ceiling', max: 'acceptEdits' });
    });

    it('does not rewrite the stored files for an unchanged answer on every turn', () => {
        const store = createOrgRequirementsStore({ happyHomeDir: home, serverUrl: 'https://s', accountKey: 'a', now: () => clock });
        const writes = { lkg: 0, scope: 0 };
        const counted = { ...store, writeLkg: (...args: Parameters<typeof store.writeLkg>) => { writes.lkg++; return store.writeLkg(...args); }, writeScope: (...args: Parameters<typeof store.writeScope>) => { writes.scope++; store.writeScope(...args); } };
        const snapshot = createOrgRequirementsSnapshot({ store: counted, audit: createOrgRequirementsAuditLog({ path: auditPath(), sessionId: () => 's1' }), scopes: () => scopes, now: () => clock });
        for (let i = 0; i < 5; i++) snapshot.ingest(ok(doc('c1', 3)));
        expect(writes).toEqual({ lkg: 1, scope: 2 });
        snapshot.ingest(ok(doc('c1', 4)));
        expect(writes.lkg).toBe(2);
        clock += HOUR;
        snapshot.ingest(ok(doc('c1', 4)));
        expect(writes.lkg).toBe(3);
    });

    it('asks for a refresh at most every five minutes, counting any lookup', () => {
        const snapshot = make();
        expect(snapshot.shouldRefresh()).toBe(false); // nothing configured yet
        snapshot.ingest(ok(doc('c1', 3)));
        expect(snapshot.shouldRefresh()).toBe(false);
        clock += ORG_REFRESH_AFTER_MS;
        expect(snapshot.shouldRefresh()).toBe(true);
        snapshot.ingest({ kind: 'failed' });
        expect(snapshot.shouldRefresh()).toBe(false);
    });

    it('tells listeners when what it enforces changes', () => {
        const snapshot = make();
        const seen: Array<number | null> = [];
        snapshot.onChange(() => seen.push(snapshot.current()?.revision ?? null));
        snapshot.ingest(ok(doc('c1', 3)));
        snapshot.ingest(ok(doc('c1', 3)));
        snapshot.ingest(ok(doc('c1', 4)));
        snapshot.ingest(ok(doc('c1', 4, {})));
        expect(seen).toEqual([3, 4, null]);
    });
});
