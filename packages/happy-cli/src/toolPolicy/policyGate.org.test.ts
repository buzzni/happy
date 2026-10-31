import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createToolPolicyAuditLog } from './audit';
import type { OrgToolRules } from './evaluate';
import { createPolicyGrantStore } from './grants';
import { createToolPolicyGate, type PolicyApprovalAnswer, type PolicyApprover } from './policyGate';
import { ABSENT_MACHINE_POLICY } from './rules';

/*
 * The gate end of organization tool rules (codexcli-org-requirements R10.4, R1a): rules are read on
 * every call, a person's conversation grant remembers the revision it was made under, and an
 * organization `ask` added later asks once more for exactly the calls it names.
 */

function setup(org: { current: OrgToolRules | null }, answer: PolicyApprovalAnswer = { approved: true, policyGrant: 'session' }) {
    const dir = mkdtempSync(join(tmpdir(), 'policy-org-'));
    const asked: Array<{ toolName: string; humanOnly: boolean; reasonCode: string }> = [];
    const orgAudit: Array<{ tool: string; reasonCode: string; ruleId: string }> = [];
    const approver: PolicyApprover = {
        requestPolicyApproval: async (request) => {
            asked.push({ toolName: request.toolName, humanOnly: request.policy.humanOnly, reasonCode: request.policy.reasonCode });
            return answer;
        },
    };
    const grants = createPolicyGrantStore();
    const gate = createToolPolicyGate({
        loadMachinePolicy: () => ABSENT_MACHINE_POLICY,
        resolver: { resolve: async () => ({ status: 'unresolved' }) },
        grants,
        audit: createToolPolicyAuditLog({ path: join(dir, 'audit.jsonl'), sessionId: () => 's1' }),
        approver: () => approver,
        unattended: () => false,
        platform: 'darwin',
        orgRules: () => org.current,
        orgAudit: (entry) => orgAudit.push(entry),
    });
    const call = (toolName: string, id = 'toolu') => gate.decide({ toolName, toolInput: {}, toolUseId: id }, new AbortController().signal);
    return { gate, grants, asked, orgAudit, call, auditFile: join(dir, 'audit.jsonl') };
}

describe('tool policy gate with organization rules', () => {
    it('denies an organization-blocked call without asking anyone, and names the rule', async () => {
        const org = { current: { companyId: 'c1', revision: 2, rules: [{ id: 'no-mail', tool: 'mcp__gmail__*', decision: 'blocked' as const, since: 2 }] } };
        const { call, asked, orgAudit, auditFile } = setup(org);
        const verdict = await call('mcp__gmail__get_message');
        expect(verdict).toMatchObject({ kind: 'deny', reasonCode: 'org_rule' });
        expect(asked).toEqual([]);
        expect(orgAudit).toEqual([{ tool: 'mcp__gmail__get_message', reasonCode: 'org_rule', ruleId: 'org:no-mail' }]);
        expect(readFileSync(auditFile, 'utf8')).toContain('"ruleId":"org:no-mail"');
    });

    it('asks a person for an organization ask, and a conversation grant made now answers it next time', async () => {
        const org = { current: { companyId: 'c1', revision: 3, rules: [{ id: 'ask-docs', tool: 'mcp__docs__*', decision: 'ask' as const, since: 3 }] } };
        const { call, asked, grants } = setup(org);
        expect(await call('mcp__docs__get_page', 'a')).toEqual({ kind: 'allow' });
        expect(asked).toEqual([{ toolName: 'mcp__docs__get_page', humanOnly: true, reasonCode: 'org_rule' }]);
        expect(grants.view().grantRevision?.('tool:mcp__docs__get_page')).toBe(3);
        expect(await call('mcp__docs__get_page', 'b')).toEqual({ kind: 'pass' });
        expect(asked).toHaveLength(1);
    });

    it('asks again when the rule is newer than the grant, then the renewed grant holds', async () => {
        const org: { current: OrgToolRules | null } = { current: null };
        const { call, asked, grants, orgAudit } = setup(org);
        // Granted while the organization had no rule for it (a machine-level write ask).
        expect(await call('mcp__gmail__send_email', 'a')).toEqual({ kind: 'allow' });
        expect(grants.view().grantRevision?.('tool:mcp__gmail__send_email')).toBeNull();
        org.current = { companyId: 'c1', revision: 5, rules: [{ id: 'ask-mail', tool: 'mcp__gmail__send_email', decision: 'ask', since: 5 }] };
        expect(await call('mcp__gmail__send_email', 'b')).toEqual({ kind: 'allow' });
        expect(asked.map((entry) => entry.reasonCode)).toEqual(['high_risk_write', 'org_rule_revision']);
        expect(orgAudit.map((entry) => entry.reasonCode)).toContain('org_rule_revision');
        expect(grants.view().grantRevision?.('tool:mcp__gmail__send_email')).toBe(5);
        expect(await call('mcp__gmail__send_email', 'c')).toEqual({ kind: 'pass' });
        expect(asked).toHaveLength(2);
    });

    it('records a document revision on grants even when that document has no tool rules', async () => {
        const org = { current: { companyId: 'c1', revision: 7, rules: [] } };
        const { call, grants } = setup(org);
        await call('mcp__gmail__send_email');
        expect(grants.view().grantRevision?.('tool:mcp__gmail__send_email')).toBe(7);
    });
});
