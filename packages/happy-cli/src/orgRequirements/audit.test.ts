import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOrgRequirementsAuditLog } from './audit';

describe('organization requirements audit', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'org-req-audit-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
    const lines = (path: string) => readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

    it('appends owner-only JSONL with the session id and no conversation content', () => {
        const path = join(dir, 'logs', 'org-requirements.jsonl');
        const log = createOrgRequirementsAuditLog({ path, sessionId: () => 's1' });
        log.record({ at: 1, item: 'ai.models', requested: 'claude:claude-opus-5-5', applied: null, reason: 'requirement_model_denied', revision: 4, companyId: 'c1' });
        expect(lines(path)).toEqual([{ at: 1, item: 'ai.models', requested: 'claude:claude-opus-5-5', applied: null, reason: 'requirement_model_denied', revision: 4, companyId: 'c1', sessionId: 's1' }]);
        expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    it('records the same clip once per session, so a client that resends bypass every turn is not logged every turn', () => {
        const path = join(dir, 'org-requirements.jsonl');
        const log = createOrgRequirementsAuditLog({ path, sessionId: () => 's1' });
        const clip = { at: 1, item: 'permissions.mode', requested: 'bypassPermissions', applied: 'default', reason: 'requirement_mode_clamped' as const, revision: 2, companyId: 'c1' };
        expect(log.record(clip, { once: true })).toBe(true);
        expect(log.record({ ...clip, at: 2 }, { once: true })).toBe(false);
        expect(log.record({ ...clip, applied: 'acceptEdits' }, { once: true })).toBe(true);
        // A refusal is always recorded: each refused turn is a separate thing that did not run.
        log.record({ ...clip, reason: 'requirement_model_denied' });
        log.record({ ...clip, reason: 'requirement_model_denied' });
        expect(lines(path)).toHaveLength(4);
    });

    it('rotates at the size limit and keeps three files', () => {
        const path = join(dir, 'org-requirements.jsonl');
        const log = createOrgRequirementsAuditLog({ path, sessionId: () => null, maxBytes: 300 });
        for (let i = 0; i < 20; i++) log.record({ at: i, item: 'tools.rules', requested: null, applied: null, reason: 'org_rule_revision', revision: i, companyId: 'c1' });
        expect(existsSync(`${path}.1`)).toBe(true);
        expect(existsSync(`${path}.2`)).toBe(true);
        expect(existsSync(`${path}.3`)).toBe(false);
    });

    it('never throws when the log cannot be written', () => {
        const log = createOrgRequirementsAuditLog({ path: join(dir, 'missing', '\0bad'), sessionId: () => null });
        expect(() => log.record({ at: 1, item: 'state', requested: null, applied: 'stale', reason: 'state', revision: 1, companyId: 'c1' })).not.toThrow();
    });
});
