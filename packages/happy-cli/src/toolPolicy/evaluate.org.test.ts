import { describe, expect, it } from 'vitest';
import { orgRequirementsV1CasesFixture as cases } from '@slopus/happy-wire';
import { evaluateToolCall, type OrgToolRules, type PolicyCallInput, type PolicyGrantView } from './evaluate';
import { ABSENT_MACHINE_POLICY, BUILTIN_TABLES, parseMachinePolicy, type MachinePolicy } from './rules';

/*
 * Organization tool rules (aplus-dev-studio-desktop specs/codexcli-org-requirements R1, R1a, Q10): they
 * tighten the builtin + machine verdict (steps 1–3) as the strictest of the two, and only then may a
 * person's session grant answer an `ask` — for an organization `ask`, only a grant made at or after the
 * rule's `since`.
 */

const READ_TOOL: PolicyCallInput = { toolName: 'mcp__docs__get_page', args: {}, platform: 'darwin' };
const TERMINAL_TYPE: PolicyCallInput = {
    toolName: 'mcp__cua-driver__type_text', args: { pid: 11, text: 'x' }, platform: 'darwin',
    target: { status: 'resolved', app: { pid: 11, bundleId: 'com.apple.Terminal', name: 'Terminal' } },
};
const machineAsk = (tool: string): MachinePolicy => parseMachinePolicy({ version: 1, rules: [{ id: 'm1', tool, decision: 'ask' }] });

function grantsWith(orgRevision: number | null | undefined): PolicyGrantView {
    return {
        hasGrant: () => orgRevision !== undefined,
        grantRevision: () => orgRevision,
        recentlyDenied: () => false,
    };
}

describe('session without organization rules', () => {
    // Pinned first: a session outside any organization must decide byte-for-byte as before.
    const inputs: PolicyCallInput[] = [
        READ_TOOL,
        { toolName: 'mcp__gmail__send_email', args: {}, platform: 'darwin' },
        TERMINAL_TYPE,
        { toolName: 'mcp__cua-driver__click', args: { pid: 13 }, platform: 'darwin', target: { status: 'resolved', app: { pid: 13, bundleId: 'com.apple.Notes', name: 'Notes' } } },
    ];
    const machines = [ABSENT_MACHINE_POLICY, machineAsk('mcp__*'), parseMachinePolicy({ version: 1, rules: [{ id: 'b', tool: 'mcp__docs__*', decision: 'blocked' }] })];
    const grantViews: PolicyGrantView[] = [{ hasGrant: () => false, recentlyDenied: () => false }, { hasGrant: () => true, recentlyDenied: () => false }, { hasGrant: () => false, recentlyDenied: () => true }];

    it('decides identically with no organization rules or an empty set', () => {
        for (const input of inputs) for (const machine of machines) for (const grants of grantViews) {
            const before = evaluateToolCall(input, machine, grants, BUILTIN_TABLES, 1);
            expect(evaluateToolCall(input, machine, grants, BUILTIN_TABLES, 1, null)).toEqual(before);
            expect(evaluateToolCall(input, machine, grants, BUILTIN_TABLES, 1, { companyId: 'c1', revision: 3, rules: [] })).toEqual(before);
        }
    });

    it('lets a grant answer an ask exactly as before, whatever revision it remembers', () => {
        for (const orgRevision of [null, 0, 7]) {
            expect(evaluateToolCall(READ_TOOL, machineAsk(READ_TOOL.toolName), grantsWith(orgRevision), BUILTIN_TABLES, 1, null)).toMatchObject({ decision: 'allow', reasonCode: 'session_grant' });
        }
    });
});

describe('organization rules (shared case table: toolRules)', () => {
    for (const entry of cases.toolRules.cases) {
        it(entry.name, () => {
            const input = entry.base === 'blocked' ? TERMINAL_TYPE : READ_TOOL;
            const machine = entry.base === 'ask' ? machineAsk(input.toolName) : ABSENT_MACHINE_POLICY;
            const since = 'orgSince' in entry && typeof entry.orgSince === 'number' ? entry.orgSince : 1;
            const org: OrgToolRules = {
                companyId: 'c1',
                revision: 9,
                rules: entry.org.map((decision, index) => ({ id: `o${index}`, tool: input.toolName, decision: decision as 'ask' | 'blocked', since })),
            };
            const verdict = evaluateToolCall(input, machine, grantsWith(entry.grant ? entry.grant.orgRevision : undefined), BUILTIN_TABLES, 1, org);
            expect(verdict.decision).toBe(entry.expect.decision);
            if ('humanOnly' in entry.expect) expect(verdict.humanOnly).toBe(entry.expect.humanOnly);
            if ('reason' in entry.expect) expect(verdict.reasonCode).toBe(entry.expect.reason);
        });
    }
});

describe('organization rule matching and audit ids', () => {
    const org = (rules: OrgToolRules['rules']): OrgToolRules => ({ companyId: 'c1', revision: 4, rules });

    it('names the organization rule in the verdict', () => {
        const verdict = evaluateToolCall(READ_TOOL, ABSENT_MACHINE_POLICY, grantsWith(undefined), BUILTIN_TABLES, 1, org([{ id: 'no-docs', tool: 'mcp__docs__*', decision: 'blocked', since: 4 }]));
        expect(verdict).toMatchObject({ decision: 'blocked', reasonCode: 'org_rule', ruleId: 'org:no-docs' });
        expect(verdict.message).toContain('조직');
    });

    it('matches a cua target and action like a machine rule', () => {
        const rules = org([{ id: 'notes-keys', tool: 'mcp__cua-driver__*', target: 'com.apple.Notes', action: 'keyboard', decision: 'blocked', since: 1 }]);
        const notes = { status: 'resolved' as const, app: { pid: 13, bundleId: 'com.apple.Notes', name: 'Notes' } };
        expect(evaluateToolCall({ toolName: 'mcp__cua-driver__type_text', args: { pid: 13 }, platform: 'darwin', target: notes }, ABSENT_MACHINE_POLICY, grantsWith(undefined), BUILTIN_TABLES, 1, rules).decision).toBe('blocked');
        expect(evaluateToolCall({ toolName: 'mcp__cua-driver__click', args: { pid: 13 }, platform: 'darwin', target: notes }, ABSENT_MACHINE_POLICY, grantsWith(undefined), BUILTIN_TABLES, 1, rules).ruleId).not.toBe('org:notes-keys');
    });

    it('asks again only for the rule that is newer than the grant', () => {
        const rules = org([
            { id: 'new', tool: 'mcp__docs__get_page', decision: 'ask', since: 4 },
            { id: 'old', tool: 'mcp__wiki__get_page', decision: 'ask', since: 2 },
        ]);
        const grant = grantsWith(3);
        expect(evaluateToolCall(READ_TOOL, ABSENT_MACHINE_POLICY, grant, BUILTIN_TABLES, 1, rules)).toMatchObject({ decision: 'ask', reasonCode: 'org_rule_revision' });
        expect(evaluateToolCall({ ...READ_TOOL, toolName: 'mcp__wiki__get_page' }, ABSENT_MACHINE_POLICY, grant, BUILTIN_TABLES, 1, rules)).toMatchObject({ decision: 'allow', reasonCode: 'session_grant' });
        // A tool no organization rule names keeps using its grant.
        expect(evaluateToolCall({ ...READ_TOOL, toolName: 'mcp__other__get_page' }, machineAsk('mcp__other__get_page'), grant, BUILTIN_TABLES, 1, rules)).toMatchObject({ decision: 'allow', reasonCode: 'session_grant' });
    });

    it('carries the newest since a satisfying grant must reach', () => {
        const verdict = evaluateToolCall(READ_TOOL, ABSENT_MACHINE_POLICY, grantsWith(undefined), BUILTIN_TABLES, 1, org([
            { id: 'a', tool: 'mcp__docs__*', decision: 'ask', since: 2 },
            { id: 'b', tool: 'mcp__docs__get_page', decision: 'ask', since: 5 },
        ]));
        expect(verdict).toMatchObject({ decision: 'ask', humanOnly: true, orgSince: 5, grantOffer: 'session' });
    });
});
