import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOrgRequirementsStore, LKG_MAX_BYTES } from './store';
import type { OrgRequirementsDocument } from './resolve';

const doc = (companyId: string, revision = 1, extra: Record<string, unknown> = {}): OrgRequirementsDocument => ({
    schemaVersion: 1, companyId, revision, modelPolicyUpdatedAt: null, issuedAt: 1,
    items: { 'permissions.mode': { kind: 'ceiling', max: 'default' }, ...extra } as OrgRequirementsDocument['items'],
});

describe('organization requirements store', () => {
    let home: string;
    beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'org-req-store-')); });
    afterEach(() => { rmSync(home, { recursive: true, force: true }); });
    const store = (overrides: Partial<Parameters<typeof createOrgRequirementsStore>[0]> = {}) =>
        createOrgRequirementsStore({ happyHomeDir: home, serverUrl: 'https://s.example', accountKey: 'acct-1', ...overrides });

    it('keeps the last known good per organization, owner-only', () => {
        const s = store();
        expect(s.writeLkg(doc('c1', 3), 1000)).toBe('written');
        expect(s.readLkg('c1')).toEqual({ document: doc('c1', 3), receivedAt: 1000 });
        expect(s.readLkg('c2')).toBeNull();
        const dir = join(home, 'org-requirements');
        expect(statSync(dir).mode & 0o777).toBe(0o700);
        const files = readdirSync(dir);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/^[0-9a-f]{16}\.json$/);
        expect(statSync(join(dir, files[0])).mode & 0o777).toBe(0o600);
        // The file name says nothing about the organization or the account.
        expect(files[0]).not.toContain('c1');
    });

    it('separates servers and accounts sharing one home directory', () => {
        store().writeLkg(doc('c1', 1), 1);
        expect(store({ accountKey: 'acct-2' }).readLkg('c1')).toBeNull();
        expect(store({ serverUrl: 'https://other.example' }).readLkg('c1')).toBeNull();
    });

    it('replaces the file atomically and leaves no temporary file behind', () => {
        const s = store();
        s.writeLkg(doc('c1', 1), 1);
        s.writeLkg(doc('c1', 2), 2);
        expect(s.readLkg('c1')?.document.revision).toBe(2);
        expect(readdirSync(join(home, 'org-requirements')).filter((name) => name.includes('.tmp'))).toEqual([]);
    });

    it('refuses a document over 64KB and keeps the previous one', () => {
        const s = store();
        s.writeLkg(doc('c1', 1), 1);
        const rules = Array.from({ length: 200 }, (_, index) => ({ id: `r${index}`, tool: `mcp__${'x'.repeat(200)}__${index}`, target: 'y'.repeat(200), decision: 'ask', since: 1 }));
        const big = doc('c1', 2, { 'tools.rules': { kind: 'rules', rules } });
        expect(JSON.stringify(big).length).toBeGreaterThan(LKG_MAX_BYTES);
        expect(s.writeLkg(big, 2)).toBe('too_large');
        expect(s.readLkg('c1')?.document.revision).toBe(1);
    });

    it('treats a hand-edited or corrupt file as missing, and validates what it reads', () => {
        const s = store();
        s.writeLkg(doc('c1', 1), 1);
        const dir = join(home, 'org-requirements');
        const file = join(dir, readdirSync(dir)[0]);
        writeFileSync(file, '{not json');
        expect(s.readLkg('c1')).toBeNull();
        // A file that names another organization is not this organization's document.
        writeFileSync(file, JSON.stringify({ version: 1, receivedAt: 1, document: doc('c9', 1) }));
        expect(s.readLkg('c1')).toBeNull();
        // Items are judged as on the wire: an organization `allow` rule does not survive the round trip.
        writeFileSync(file, JSON.stringify({ version: 1, receivedAt: 1, document: doc('c1', 1, { 'tools.rules': { kind: 'rules', rules: [{ id: 'a', tool: 'mcp__a__b', decision: 'allow', since: 1 }] } }) }));
        expect(s.readLkg('c1')?.document.items['tools.rules']).toEqual({ kind: 'rules', rules: [] });
    });

    it('deletes an organization document on an explicit release', () => {
        const s = store();
        s.writeLkg(doc('c1'), 1);
        s.writeLkg(doc('c2'), 1);
        s.deleteLkg('c1');
        expect(s.readLkg('c1')).toBeNull();
        expect(s.readLkg('c2')).not.toBeNull();
    });

    it('maps scopes to organizations so a failed lookup can still choose a document', () => {
        const s = store();
        s.writeScope({ kind: 'project', id: 'p1' }, 'c1');
        s.writeScope({ kind: 'session', id: 's1' }, 'c2');
        expect(s.readScope({ kind: 'project', id: 'p1' })).toBe('c1');
        expect(s.readScope({ kind: 'session', id: 's1' })).toBe('c2');
        expect(s.readScope({ kind: 'session', id: 'p1' })).toBeNull();
        s.deleteScope({ kind: 'project', id: 'p1' });
        expect(s.readScope({ kind: 'project', id: 'p1' })).toBeNull();
        for (const name of readdirSync(join(home, 'org-requirements'))) {
            expect(readFileSync(join(home, 'org-requirements', name), 'utf8')).not.toContain('p1');
        }
    });

    it('prunes scope entries nobody used for 30 days', () => {
        const now = Date.UTC(2026, 9, 31);
        const s = store({ now: () => now });
        s.writeScope({ kind: 'session', id: 'old' }, 'c1');
        const dir = join(home, 'org-requirements');
        const old = readdirSync(dir)[0];
        const past = new Date(now - 31 * 24 * 60 * 60 * 1000);
        utimesSync(join(dir, old), past, past);
        store({ now: () => now }).writeScope({ kind: 'session', id: 'new' }, 'c1');
        expect(readdirSync(dir)).not.toContain(old);
        expect(readdirSync(dir)).toHaveLength(1);
    });

    it('tells the daemon what a session enforces, keyed by the session alone', () => {
        // The daemon owns the autonomous quality gate (R10.5) and holds neither the session's account nor its snapshot.
        store().writeSessionSummary('s1', { companyId: 'c1', autopilotDisabled: true });
        const daemon = store({ accountKey: 'daemon-account' });
        expect(daemon.readSessionSummary('s1')).toEqual({ companyId: 'c1', autopilotDisabled: true });
        expect(daemon.readSessionSummary('s2')).toBeNull();
        store().writeSessionSummary('s1', null);
        expect(daemon.readSessionSummary('s1')).toBeNull();
    });

    it('never throws when the directory cannot be written', () => {
        const blocked = join(home, 'blocked');
        writeFileSync(blocked, 'a file, not a directory');
        const s = createOrgRequirementsStore({ happyHomeDir: blocked, serverUrl: 'https://s.example', accountKey: 'a' });
        expect(s.writeLkg(doc('c1'), 1)).toBe('failed');
        expect(s.readLkg('c1')).toBeNull();
        expect(() => s.writeScope({ kind: 'session', id: 's' }, 'c1')).not.toThrow();
    });
});
