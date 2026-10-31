import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOrgRequirementsGate, type OrgRequirementsGate } from '@/orgRequirements/gate';
import type { TurnAttendance } from '@/api/turnAttendance';
import { createClaudeOrgRequirements, orgTitleModel, stripModelSelectionEnv } from './claudeOrgRequirements';
import type { EnhancedMode } from './loop';

const doc = (items: Record<string, unknown>) => ({ schemaVersion: 1, companyId: 'c1', revision: 2, modelPolicyUpdatedAt: null, issuedAt: 1, items });

describe('Claude runner adapter of the organization gate', () => {
    let home: string;
    let gate: OrgRequirementsGate;
    let attendance: TurnAttendance;
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'claude-org-'));
        attendance = 'attended';
        gate = createOrgRequirementsGate({ agent: 'claude', happyHomeDir: home, serverUrl: 'https://s', accountKey: 'a', sessionId: () => 's1', projectHint: null, publish: () => {}, refresh: async () => {} });
    });
    afterEach(() => { rmSync(home, { recursive: true, force: true }); });
    const adapter = () => createClaudeOrgRequirements(gate, {
        normalizeModel: (model) => (model === 'claude-sonnet-5-5' ? 'sonnet-runtime' : model),
        attendance: () => attendance,
        initialPermissionMode: () => 'bypassPermissions',
    });
    const mode = (overrides: Partial<EnhancedMode> = {}): EnhancedMode => ({ permissionMode: 'bypassPermissions', model: 'opus', effort: 'high', orgModel: { requested: null, origin: 'none' }, ...overrides });

    it('returns the batch mode itself while no document applies', () => {
        const input = mode();
        expect(adapter().checkTurn(input)).toEqual({ kind: 'run', mode: input, modeClamped: false });
        expect(adapter().localLaunchArgs(['--dangerously-skip-permissions'])).toEqual({ args: ['--dangerously-skip-permissions'], allowBypass: true });
        expect(adapter().declinesForCeiling({ edit: false })).toBe(false);
    });

    it('clips the mode and runs an unchosen model on the allowed one, through the runtime normalization, with its default effort', () => {
        gate.onRequirements({ kind: 'response', status: 'ok', requirements: doc({
            'permissions.mode': { kind: 'ceiling', max: 'default' },
            'ai.models': { kind: 'allowedSet', values: ['claude:claude-sonnet-5-5'], default: null, source: 'organization' },
        }) });
        const verdict = adapter().checkTurn(mode({ fallbackModel: 'claude-opus-5' }));
        expect(verdict).toEqual({ kind: 'run', modeClamped: true, mode: { permissionMode: 'default', model: 'sonnet-runtime', effort: undefined, fallbackModel: undefined, orgModel: { requested: null, origin: 'none' } } });
    });

    it('adds the blanket organization blocks to the turn disallowedTools, in the forms Claude Code reads', () => {
        gate.onRequirements({ kind: 'response', status: 'ok', requirements: doc({ 'tools.rules': { kind: 'rules', rules: [
            { id: 'no-mail', tool: 'mcp__gmail__*', decision: 'blocked', since: 3 },
            { id: 'no-delete', tool: 'mcp__github__delete_repo', decision: 'blocked', since: 3 },
            // A glob Claude Code has no rule form for stays with the tool policy hook.
            { id: 'no-mcp-delete', tool: 'mcp__*__delete*', decision: 'blocked', since: 3 },
            { id: 'notes-only', tool: 'mcp__cua-driver__*', target: 'com.apple.Notes', decision: 'blocked', since: 3 },
        ] } }) });
        const verdict = adapter().checkTurn(mode({ disallowedTools: ['WebFetch', 'mcp__gmail'] }));
        expect(verdict).toMatchObject({ kind: 'run', modeClamped: false, mode: { disallowedTools: ['WebFetch', 'mcp__gmail', 'mcp__github__delete_repo'] } });
        // Nothing to add: the batch's own mode, unchanged.
        const input = mode({ disallowedTools: ['mcp__gmail', 'mcp__github__delete_repo'] });
        expect(adapter().checkTurn(input)).toEqual({ kind: 'run', mode: input, modeClamped: false });
    });

    it('refuses a batch whose explicit model is outside the set', () => {
        gate.onRequirements({ kind: 'response', status: 'ok', requirements: doc({ 'ai.models': { kind: 'allowedSet', values: ['claude:claude-sonnet-5-5'], default: null, source: 'organization' } }) });
        expect(adapter().checkTurn(mode({ orgModel: { requested: 'claude-opus-5-5', origin: 'explicit' } }))).toMatchObject({ kind: 'refuse' });
    });

    it('declines at once only an unattended prompt the ceiling raised', () => {
        gate.onRequirements({ kind: 'response', status: 'ok', requirements: doc({ 'permissions.mode': { kind: 'ceiling', max: 'default' } }) });
        const claude = adapter();
        claude.checkTurn(mode());
        expect(claude.declinesForCeiling({ edit: false })).toBe(false);
        attendance = 'channel';
        expect(claude.declinesForCeiling({ edit: false })).toBe(false);
        attendance = 'unattended';
        expect(claude.declinesForCeiling({ edit: false })).toBe(true);
        claude.checkTurn(mode({ permissionMode: 'default' }));
        expect(claude.declinesForCeiling({ edit: true })).toBe(false);
    });

    it('titles a new chat with the model its checked turn runs while the organization restricts models', () => {
        // No document: the model the message asked for, as before.
        expect(orgTitleModel(gate, 'opus', 'claude-opus-5-5')).toBe('opus');
        expect(orgTitleModel(null, undefined, 'claude-opus-5-5')).toBe('claude-opus-5-5');
        gate.onRequirements({ kind: 'response', status: 'ok', requirements: doc({ 'ai.models': { kind: 'allowedSet', values: ['claude:claude-sonnet-5-5'], default: null, source: 'organization' } }) });
        // Default (`opus` seed) or a refused explicit pick: never the queued model, only the launched, checked one.
        expect(orgTitleModel(gate, 'opus', 'sonnet-runtime')).toBe('sonnet-runtime');
        expect(orgTitleModel(gate, 'claude-opus-5-5', 'sonnet-runtime')).toBe('sonnet-runtime');
    });

    it('removes the variables that pick a model, except on a Z.AI runtime whose tier mapping the daemon set (R10.8)', () => {
        const env: Record<string, string | undefined> = { ANTHROPIC_MODEL: 'x', ANTHROPIC_DEFAULT_OPUS_MODEL: 'y', ANTHROPIC_SMALL_FAST_MODEL: 'z', CLAUDE_CODE_SUBAGENT_MODEL: 'w', PATH: '/bin' };
        const extra: Record<string, string> = { ANTHROPIC_DEFAULT_SONNET_MODEL: 's', KEEP: '1' };
        expect(stripModelSelectionEnv(env, extra).sort()).toEqual(['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']);
        expect(env).toEqual({ PATH: '/bin' });
        expect(extra).toEqual({ KEEP: '1' });
        const zai: Record<string, string | undefined> = { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_MODEL: 'glm-5.3-flash', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3' };
        expect(stripModelSelectionEnv(zai, undefined)).toEqual([]);
        expect(zai).toMatchObject({ ANTHROPIC_MODEL: 'glm-5.3-flash', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3' });
        // Only the daemon's own tier mapping stays on Z.AI: a value it did not set, or a variable it never sets, goes.
        const zaiOverridden: Record<string, string | undefined> = { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7', CLAUDE_CODE_SUBAGENT_MODEL: 'glm-5.3' };
        const zaiExtra: Record<string, string> = { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3' };
        expect(stripModelSelectionEnv(zaiOverridden, zaiExtra).sort()).toEqual(['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']);
        expect(zaiOverridden).toEqual({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7' });
        expect(zaiExtra).toEqual({});
    });

    it('launches the terminal without bypass and with the clipped mode under a ceiling', () => {
        gate.onRequirements({ kind: 'response', status: 'ok', requirements: doc({ 'permissions.mode': { kind: 'ceiling', max: 'acceptEdits' } }) });
        expect(adapter().localLaunchArgs(['--resume', 'x', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions']))
            .toEqual({ args: ['--resume', 'x', '--permission-mode', 'acceptEdits'], allowBypass: false });
        expect(adapter().localLaunchArgs(undefined)).toEqual({ args: ['--permission-mode', 'acceptEdits'], allowBypass: false });
    });
});
