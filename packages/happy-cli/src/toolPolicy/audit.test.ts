import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createToolPolicyAuditLog, RECENT_LIMIT, type ToolPolicyAuditRecord } from './audit';

function entry(overrides: Partial<ToolPolicyAuditRecord> = {}): ToolPolicyAuditRecord {
    return {
        at: 1, tool: 'mcp__cua-driver__type_text', server: 'cua-driver', action: 'keyboard', targetCategory: 'terminal',
        targetId: 'com.apple.Terminal', decision: 'blocked', reasonCode: 'grade_exceeded', ruleId: 'builtin:grade_terminal',
        policyVersion: 'v', ...overrides,
    };
}

describe('tool policy audit', () => {
    it('writes owner-only JSONL with the session id and no argument values', () => {
        const dir = mkdtempSync(join(tmpdir(), 'policy-audit-'));
        const path = join(dir, 'logs', 'tool-policy.jsonl');
        const log = createToolPolicyAuditLog({ path, sessionId: () => 'session-1' });
        log.record(entry());
        expect(statSync(path).mode & 0o777).toBe(0o600);
        const line = JSON.parse(readFileSync(path, 'utf8').trim());
        expect(line).toMatchObject({ sessionId: 'session-1', reasonCode: 'grade_exceeded' });
        expect(Object.keys(line)).not.toContain('args');
    });

    it('rotates at the size limit and keeps three files', () => {
        const dir = mkdtempSync(join(tmpdir(), 'policy-audit-'));
        const path = join(dir, 'tool-policy.jsonl');
        const log = createToolPolicyAuditLog({ path, sessionId: () => null, maxBytes: 600 });
        for (let i = 0; i < 20; i++) log.record(entry({ at: i }));
        expect(readdirSync(dir).sort()).toEqual(['tool-policy.jsonl', 'tool-policy.jsonl.1', 'tool-policy.jsonl.2']);
        expect(statSync(path).size).toBeLessThanOrEqual(600);
    });

    it('publishes only the latest ask/blocked records for agentState', () => {
        const dir = mkdtempSync(join(tmpdir(), 'policy-audit-'));
        const published: ToolPolicyAuditRecord[][] = [];
        const log = createToolPolicyAuditLog({ path: join(dir, 'a.jsonl'), sessionId: () => null, publishRecent: (recent) => published.push(recent) });
        log.record(entry({ decision: 'allow', reasonCode: 'write_tool' }));
        expect(published).toHaveLength(0);
        for (let i = 0; i < RECENT_LIMIT + 5; i++) log.record(entry({ at: i }));
        const last = published[published.length - 1];
        expect(last).toHaveLength(RECENT_LIMIT);
        expect(last[0].at).toBe(5);
    });
});
