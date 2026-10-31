import { describe, expect, it } from 'vitest';
import { orgRequirementsV1CasesFixture as cases } from '@slopus/happy-wire';
import {
    clampPermissionMode,
    judgeModel,
    normalizeModelSelection,
    parseOrgRequirements,
    permissionModeRank,
    type OrgAgent,
    type OrgRequirementsDocument,
} from './resolve';

describe('parseOrgRequirements (shared case table: parse)', () => {
    for (const entry of cases.parse.cases) {
        it(entry.name, () => {
            const previous = 'previous' in entry ? entry.previous as unknown as OrgRequirementsDocument : undefined;
            if ('rejected' in entry.expect && entry.expect.rejected) {
                expect(() => parseOrgRequirements(entry.document, previous)).toThrow();
                return;
            }
            const expected = entry.expect as { items: string[]; issues: Array<{ key: string; reason: string }>; values?: Record<string, unknown> };
            const parsed = parseOrgRequirements(entry.document, previous);
            expect(Object.keys(parsed.document.items)).toEqual(expected.items);
            expect(parsed.issues).toEqual(expected.issues);
            for (const [key, value] of Object.entries(expected.values ?? {})) expect(parsed.document.items[key]).toEqual(value);
        });
    }

    it('reads items through own properties only', () => {
        const items = Object.create({ 'permissions.mode': { kind: 'ceiling', max: 'default' } }) as Record<string, unknown>;
        const parsed = parseOrgRequirements({ schemaVersion: 1, companyId: 'c1', revision: 1, modelPolicyUpdatedAt: null, issuedAt: 1, items });
        expect(parsed.document.items).toEqual({});
    });
});

describe('permission mode ranks and clamping (shared case table)', () => {
    for (const entry of cases.permissionModeRank.cases) {
        it(`${entry.agent} ${entry.mode} ranks ${entry.rank}`, () => {
            expect(permissionModeRank(entry.agent as OrgAgent, entry.mode)).toBe(entry.rank);
        });
    }
    for (const entry of cases.permissionModeClamp.cases) {
        it(`${entry.agent} ${entry.mode} under ${entry.ceiling} runs ${entry.expect}`, () => {
            expect(clampPermissionMode(entry.agent as OrgAgent, entry.mode, entry.ceiling)).toEqual({ mode: entry.expect, clamped: entry.clamped });
        });
    }
});

describe('normalizeModelSelection (shared case table: modelNormalization)', () => {
    for (const entry of cases.modelNormalization.cases) {
        it(entry.name, () => {
            expect(normalizeModelSelection(entry.agent as OrgAgent, entry.model)).toBe(entry.expect);
        });
    }
});

describe('judgeModel (shared case table: modelJudgment)', () => {
    for (const entry of cases.modelJudgment.cases) {
        it(entry.name, () => {
            const allowed = entry.allowed ? { kind: 'allowedSet' as const, values: entry.allowed.values, default: entry.allowed.default, source: 'organization' as const } : null;
            const verdict = judgeModel({ agent: entry.agent as OrgAgent, model: entry.model, origin: entry.origin as 'explicit' | 'resume' | 'none', allowed });
            expect(verdict).toMatchObject(entry.expect);
        });
    }
});
