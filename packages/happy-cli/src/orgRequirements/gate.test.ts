import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgRequirementsAgentState } from '@slopus/happy-wire';
import { consumeOrgScopeHint, createOrgRequirementsGate, isOrgRequirementsEnabled, orgAccountKey, orgRequirementsMachineCapability, orgRequirementsMetadataUpdate, refusedTurnEnvelopes, ORG_REQUIREMENTS_ENV, ORG_SCOPE_HINT_ENV, type OrgRequirementsGate } from './gate';
import { MachineMetadataSchema } from '@/api/types';
import { createOrgRequirementsStore } from './store';
import type { OrgAgent } from './resolve';

const doc = (items: Record<string, unknown>, revision = 3) => ({ schemaVersion: 1, companyId: 'c1', revision, modelPolicyUpdatedAt: null, issuedAt: 1, items });
const CEILING_DEFAULT = { 'permissions.mode': { kind: 'ceiling', max: 'default' } };
const MODELS = { 'ai.models': { kind: 'allowedSet', values: ['claude:claude-sonnet-5-5', 'codex:gpt-6.1-sol'], default: 'claude:claude-sonnet-5-5', source: 'organization' } };

describe('organization requirements session gate', () => {
    let home: string;
    let clock: number;
    let published: Array<OrgRequirementsAgentState | null>;
    let refresh: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'org-req-gate-'));
        clock = Date.UTC(2026, 9, 31, 9);
        published = [];
        refresh = vi.fn(async () => {});
    });
    afterEach(() => { rmSync(home, { recursive: true, force: true }); });

    const make = (agent: OrgAgent = 'claude', overrides: { sessionId?: string | null } = {}): OrgRequirementsGate => createOrgRequirementsGate({
        agent,
        happyHomeDir: home,
        serverUrl: 'https://s',
        accountKey: 'a',
        sessionId: () => overrides.sessionId === undefined ? 's1' : overrides.sessionId,
        projectHint: 'p1',
        publish: (state) => published.push(state),
        refresh,
        now: () => clock,
    });
    const audit = () => {
        const path = join(home, 'logs', 'org-requirements.jsonl');
        return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
    };

    describe('without a document (pinned first: nothing changes)', () => {
        it('passes every mode, model and approval answer through untouched and publishes nothing', () => {
            const gate = make();
            gate.onRequirements({ kind: 'response', status: 'no-company', requirements: null });
            expect(gate.prepare('bypassPermissions')).toEqual({ permissionMode: 'bypassPermissions', clamped: false });
            expect(gate.checkTurn({ permissionMode: 'yolo', model: 'claude-opus-5', modelOrigin: 'explicit', fallbackModel: 'x' }))
                .toEqual({ kind: 'run', permissionMode: 'yolo', modeClamped: false, dropFallbackModel: false });
            expect(gate.clampPermissionResponse({ mode: 'bypassPermissions', allowTools: ['Bash', 'mcp__a__b'] })).toEqual({ mode: 'bypassPermissions', allowTools: ['Bash', 'mcp__a__b'] });
            expect(gate.bypassAllowed()).toBe(true);
            expect(gate.restrictsModels()).toBe(false);
            expect(gate.toolRules()).toBeNull();
            expect(gate.ceilingCaused({ edit: false })).toBe(false);
            expect(published).toEqual([]);
            expect(audit()).toEqual([]);
        });

        it('says nothing at all for a run with no Studio behind it', () => {
            const gate = make();
            gate.onRequirements({ kind: 'not-configured' });
            gate.checkTurn({ permissionMode: 'bypassPermissions', model: undefined, modelOrigin: 'none' });
            expect(published).toEqual([]);
            expect(refresh).not.toHaveBeenCalled();
        });
    });

    describe('permission mode ceiling', () => {
        it('clips the first mode, and says so once', () => {
            const gate = make();
            gate.onRequirements({ kind: 'response', status: 'ok', requirements: doc(CEILING_DEFAULT) });
            expect(gate.prepare('bypassPermissions')).toEqual({ permissionMode: 'default', clamped: true });
            expect(gate.bypassAllowed()).toBe(false);
            expect(published.at(-1)).toMatchObject({ state: 'ok', revision: 3, lastEnforcement: { item: 'permissions.mode', requested: 'bypassPermissions', applied: 'default', reason: 'requirement_mode_clamped', seq: 1 } });
            // An older Desktop resends bypass with every turn: clipped every turn, announced once.
            for (let i = 0; i < 3; i++) {
                expect(gate.checkTurn({ permissionMode: 'bypassPermissions', model: undefined, modelOrigin: 'none' })).toMatchObject({ permissionMode: 'default', modeClamped: true });
            }
            expect(published.filter((state) => state?.lastEnforcement).map((state) => state!.lastEnforcement!.seq)).toEqual([1]);
            expect(audit().filter((entry) => entry.reason === 'requirement_mode_clamped')).toHaveLength(1);
        });

        it('lowers a session that was already in bypass from the next turn after the ceiling arrives', () => {
            const gate = make();
            gate.onRequirements({ kind: 'response', status: 'ok', requirements: doc({}) });
            expect(gate.checkTurn({ permissionMode: 'bypassPermissions', model: undefined, modelOrigin: 'none' })).toMatchObject({ permissionMode: 'bypassPermissions' });
            gate.onRequirements({ kind: 'response', status: 'ok', requirements: doc({ 'permissions.mode': { kind: 'ceiling', max: 'acceptEdits' } }, 4) });
            expect(gate.checkTurn({ permissionMode: 'bypassPermissions', model: undefined, modelOrigin: 'none' })).toMatchObject({ permissionMode: 'acceptEdits', modeClamped: true });
        });

        it('maps a Codex mode to the highest Codex mode under the ceiling', () => {
            const gate = make('codex');
            gate.onRequirements({ kind: 'response', status: 'ok', requirements: doc({ 'permissions.mode': { kind: 'ceiling', max: 'acceptEdits' } }) });
            expect(gate.checkTurn({ permissionMode: 'yolo', model: undefined, modelOrigin: 'none' })).toMatchObject({ permissionMode: 'safe-yolo', modeClamped: true });
            expect(gate.approvalCeiling()).toBe('acceptEdits');
        });

        it('clips an approval answer: plan approval to bypass and allowTools naming a blocked tool', () => {
            const gate = make();
            gate.onRequirements({ kind: 'response', status: 'ok', requirements: doc({ ...CEILING_DEFAULT, 'tools.rules': { kind: 'rules', rules: [
                { id: 'no-mail', tool: 'mcp__gmail__*', decision: 'blocked', since: 3 },
                { id: 'notes-only', tool: 'mcp__cua-driver__*', target: 'com.apple.Notes', decision: 'blocked', since: 3 },
            ] } }) });
            expect(gate.clampPermissionResponse({ mode: 'bypassPermissions', allowTools: ['mcp__gmail__send_email', 'Bash(ls:*)', 'mcp__cua-driver__click'] }))
                .toEqual({ mode: 'default', allowTools: ['Bash(ls:*)', 'mcp__cua-driver__click'] });
            expect(published.at(-1)?.lastEnforcement).toMatchObject({ reason: 'requirement_tool_blocked', requested: 'mcp__gmail__send_email' });
            expect(gate.clampPermissionResponse({ mode: 'plan' })).toEqual({ mode: 'plan' });
        });
    });

    describe('unattended ceiling denial (R10.12)', () => {
        it('treats only what the requested mode would have run unasked as caused by the ceiling', () => {
            const gate = make();
            gate.onRequirements({ kind: 'response', status: 'ok', requirements: doc(CEILING_DEFAULT) });
            gate.checkTurn({ permissionMode: 'bypassPermissions', model: undefined, modelOrigin: 'none' });
            expect(gate.ceilingCaused({ edit: false })).toBe(true);
            gate.checkTurn({ permissionMode: 'acceptEdits', model: undefined, modelOrigin: 'none' });
            expect(gate.ceilingCaused({ edit: true })).toBe(true);
            expect(gate.ceilingCaused({ edit: false })).toBe(false);
            gate.checkTurn({ permissionMode: 'default', model: undefined, modelOrigin: 'none' });
            expect(gate.ceilingCaused({ edit: true })).toBe(false);
        });

        it('records each immediate denial for the audit and Desktop', () => {
            const gate = make();
            gate.onRequirements({ kind: 'response', status: 'ok', requirements: doc(CEILING_DEFAULT) });
            gate.recordCeilingDenial('Bash');
            gate.recordCeilingDenial('Bash');
            expect(audit().filter((entry) => entry.reason === 'requirement_ceiling')).toHaveLength(2);
            expect(published.at(-1)?.lastEnforcement).toMatchObject({ item: 'permissions.mode', requested: 'Bash', reason: 'requirement_ceiling' });
        });
    });

    describe('models', () => {
        it('refuses a turn on a model outside the set and lets the next turn on an allowed model run', () => {
            const gate = make();
            gate.onRequirements({ kind: 'response', status: 'ok', requirements: doc(MODELS) });
            const refused = gate.checkTurn({ permissionMode: 'default', model: 'claude-opus-5-5', modelOrigin: 'explicit' });
            expect(refused).toMatchObject({ kind: 'refuse', reason: 'requirement_model_denied' });
            expect(refused.kind === 'refuse' && refused.message).toContain('조직 정책');
            expect(gate.checkTurn({ permissionMode: 'default', model: 'claude-sonnet-5-5', modelOrigin: 'explicit' })).toMatchObject({ kind: 'run' });
            expect(audit().filter((entry) => entry.reason === 'requirement_model_denied')).toHaveLength(1);
        });

        it('runs an unchosen or resumed model on an allowed one, and drops a fallback outside the set', () => {
            const gate = make();
            gate.onRequirements({ kind: 'response', status: 'ok', requirements: doc(MODELS) });
            expect(gate.checkTurn({ permissionMode: 'default', model: undefined, modelOrigin: 'none', fallbackModel: 'claude-opus-5' }))
                .toMatchObject({ kind: 'run', substituteModel: 'claude-sonnet-5-5', dropFallbackModel: true });
            expect(gate.checkTurn({ permissionMode: 'default', model: 'claude-opus-5', modelOrigin: 'resume', fallbackModel: 'claude-sonnet-5-5' }))
                .toMatchObject({ kind: 'run', substituteModel: 'claude-sonnet-5-5', dropFallbackModel: false });
            expect(gate.restrictsModels()).toBe(true);
        });

        it('says it cannot read a model name', () => {
            const gate = make();
            gate.onRequirements({ kind: 'response', status: 'ok', requirements: doc(MODELS) });
            expect(gate.checkTurn({ permissionMode: 'default', model: ' ', modelOrigin: 'explicit' })).toMatchObject({ kind: 'refuse', reason: 'requirement_model_unknown' });
        });
    });

    describe('runtimes without a gate (R10.7)', () => {
        it('refuses every turn while a ceiling or tool rules apply, and judges models otherwise', () => {
            const gemini = make('gemini');
            gemini.onRequirements({ kind: 'response', status: 'ok', requirements: doc(CEILING_DEFAULT) });
            expect(gemini.checkTurn({ permissionMode: 'default', model: undefined, modelOrigin: 'none', enforcesCeilingAndTools: false }))
                .toMatchObject({ kind: 'refuse', reason: 'requirement_runtime_unsupported' });
            const grok = make('grok');
            grok.onRequirements({ kind: 'response', status: 'ok', requirements: doc({ 'ai.models': { kind: 'allowedSet', values: ['grok:*'], default: null, source: 'organization' } }) });
            expect(grok.checkTurn({ permissionMode: 'default', model: 'grok-5', modelOrigin: 'explicit', enforcesCeilingAndTools: false })).toMatchObject({ kind: 'run' });
        });
    });

    describe('freshness and state', () => {
        it('refreshes in the background when a turn starts more than five minutes after the last lookup', () => {
            const gate = make();
            gate.onRequirements({ kind: 'response', status: 'ok', requirements: doc(CEILING_DEFAULT) });
            gate.checkTurn({ permissionMode: 'default', model: undefined, modelOrigin: 'none' });
            expect(refresh).not.toHaveBeenCalled();
            clock += 5 * 60 * 1000;
            gate.checkTurn({ permissionMode: 'default', model: undefined, modelOrigin: 'none' });
            gate.checkTurn({ permissionMode: 'default', model: undefined, modelOrigin: 'none' });
            expect(refresh).toHaveBeenCalledTimes(1);
        });

        it('publishes stale after 24 hours without a lookup, and unknown when nothing was ever received', () => {
            const gate = make();
            gate.onRequirements({ kind: 'response', status: 'ok', requirements: doc(CEILING_DEFAULT) });
            clock += 24 * 60 * 60 * 1000 + 1;
            gate.checkTurn({ permissionMode: 'default', model: undefined, modelOrigin: 'none' });
            expect(published.at(-1)).toMatchObject({ state: 'stale', revision: 3 });
            published = [];
            const elsewhere = mkdtempSync(join(tmpdir(), 'org-req-gate-'));
            const isolated = createOrgRequirementsGate({ agent: 'claude', happyHomeDir: elsewhere, serverUrl: 'https://s', accountKey: 'a', sessionId: () => 's9', projectHint: null, publish: (state) => published.push(state), refresh, now: () => clock });
            isolated.onRequirements({ kind: 'failed' });
            expect(published).toEqual([{ state: 'unknown' }]);
            rmSync(elsewhere, { recursive: true, force: true });
        });

        it('tells the daemon whether this session switched autopilot off', () => {
            const gate = make();
            gate.onRequirements({ kind: 'response', status: 'ok', requirements: doc({ 'autopilot.enabled': { kind: 'fixed', value: false } }) });
            const daemonView = createOrgRequirementsStore({ happyHomeDir: home, serverUrl: 'https://s', accountKey: 'daemon' });
            expect(daemonView.readSessionSummary('s1')).toEqual({ companyId: 'c1', autopilotDisabled: true });
            gate.onRequirements({ kind: 'response', status: 'ok', requirements: doc({}, 4) });
            expect(daemonView.readSessionSummary('s1')).toBeNull();
        });
    });

    it('shows the clipped mode without recording an enforcement', () => {
        const gate = make();
        expect(gate.displayPermissionMode('bypassPermissions')).toBe('bypassPermissions');
        gate.onRequirements({ kind: 'response', status: 'ok', requirements: doc(CEILING_DEFAULT) });
        expect(gate.displayPermissionMode('bypassPermissions')).toBe('default');
        expect(audit().filter((entry) => entry.reason === 'requirement_mode_clamped')).toEqual([]);
    });

    it('keys the cache by account without keeping the key material', () => {
        const legacy = orgAccountKey({ encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) } });
        expect(legacy).toMatch(/^[0-9a-f]{64}$/);
        expect(orgAccountKey({ encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) } })).toBe(legacy);
        expect(orgAccountKey({ encryption: { type: 'dataKey', publicKey: new Uint8Array([1, 2, 3]) } })).not.toBe(legacy);
        expect(orgAccountKey({ token: 't' })).toMatch(/^[0-9a-f]{64}$/);
    });

    it('reads the daemon project hint once and drops a malformed one', () => {
        const env: NodeJS.ProcessEnv = { [ORG_SCOPE_HINT_ENV]: 'proj_1' };
        expect(consumeOrgScopeHint(env)).toBe('proj_1');
        expect(env).toEqual({});
        expect(consumeOrgScopeHint({ [ORG_SCOPE_HINT_ENV]: 'a b' })).toBeNull();
    });

    it('builds a refused turn every client reads as a failed turn with its reason', () => {
        const envelopes = refusedTurnEnvelopes('조직 정책', 'req-1');
        expect(envelopes.map((envelope) => envelope.ev)).toEqual([
            { t: 'turn-start', requestId: 'req-1' },
            { t: 'text', text: '조직 정책' },
            { t: 'turn-end', status: 'failed', requestId: 'req-1' },
        ]);
        expect(new Set(envelopes.map((envelope) => envelope.turn)).size).toBe(1);
        expect(envelopes.every((envelope) => envelope.role === 'agent')).toBe(true);
        expect(refusedTurnEnvelopes('x', null).map((envelope) => envelope.ev)).toEqual([{ t: 'turn-start' }, { t: 'text', text: 'x' }, { t: 'turn-end', status: 'failed' }]);
    });

    it('advertises what this runtime enforces, and nothing with the switch off (R24)', () => {
        const capability = orgRequirementsMachineCapability({});
        expect(capability).toEqual({ version: 1, enforced: ['models', 'permissionMode', 'tools', 'autopilot'] });
        expect(orgRequirementsMachineCapability({ [ORG_REQUIREMENTS_ENV]: 'off' })).toBeUndefined();
        const stored = { host: 'h', platform: 'darwin' } as Record<string, unknown>;
        expect(orgRequirementsMetadataUpdate(stored, capability)).toEqual({ host: 'h', platform: 'darwin', orgRequirements: capability });
        expect(orgRequirementsMetadataUpdate({ ...stored, orgRequirements: capability }, capability)).toBeUndefined();
        expect(orgRequirementsMetadataUpdate({ ...stored, orgRequirements: capability }, undefined)).toEqual(stored);
        expect(orgRequirementsMetadataUpdate(null, capability)).toBeUndefined();
        // The daemon parses its own metadata with this schema: the field must survive it.
        expect(MachineMetadataSchema.partial().parse({ orgRequirements: capability }).orgRequirements).toEqual(capability);
    });

    it('is switched off by HAPPY_ORG_REQUIREMENTS=off only', () => {
        expect(ORG_REQUIREMENTS_ENV).toBe('HAPPY_ORG_REQUIREMENTS');
        expect(isOrgRequirementsEnabled({})).toBe(true);
        expect(isOrgRequirementsEnabled({ HAPPY_ORG_REQUIREMENTS: ' OFF ' })).toBe(false);
        expect(isOrgRequirementsEnabled({ HAPPY_ORG_REQUIREMENTS: '0' })).toBe(true);
    });
});
