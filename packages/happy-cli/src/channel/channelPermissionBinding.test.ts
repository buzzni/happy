import { describe, expect, it } from 'vitest';

import {
    externalAnswerCarriesPersistentGrant,
    isExternallyAnswerableTool,
    verifyChannelPermissionClaim,
    type ChannelPermissionBinding,
} from './channelPermissionBinding';

function binding(overrides: Partial<ChannelPermissionBinding> = {}): ChannelPermissionBinding {
    return {
        permissionId: 'toolu_01',
        turnId: 'turn-a',
        channelRequestId: 'req-1',
        runtimeId: 'runtime-1',
        answerable: true,
        ...overrides,
    };
}

const CLAIM = {
    permissionId: 'toolu_01',
    turnId: 'turn-a',
    channelRequestId: 'req-1',
    runtimeId: 'runtime-1',
};

describe('verifyChannelPermissionClaim', () => {
    it('accepts an answer that reproduces every identifier', () => {
        expect(verifyChannelPermissionClaim(binding(), CLAIM)).toEqual({ ok: true });
    });

    it('refuses an answer aimed at a prompt the Desktop user raised', () => {
        // The prompt has no external request behind it, so no messenger answer may reach it. This
        // is the case the agent state alone cannot distinguish: its record is only
        // `{ tool, arguments, createdAt }`.
        const inApp = binding({ channelRequestId: null });
        expect(verifyChannelPermissionClaim(inApp, CLAIM))
            .toEqual({ ok: false, code: 'not-channel-owned' });
    });

    it('refuses when the prompt belongs to a different turn', () => {
        expect(verifyChannelPermissionClaim(binding({ turnId: 'turn-b' }), CLAIM))
            .toEqual({ ok: false, code: 'turn-mismatch' });
    });

    it('refuses an answer carrying another request id', () => {
        expect(verifyChannelPermissionClaim(binding({ channelRequestId: 'req-2' }), CLAIM))
            .toEqual({ ok: false, code: 'request-mismatch' });
    });

    it('refuses an answer aimed at a previous CLI process', () => {
        expect(verifyChannelPermissionClaim(binding({ runtimeId: 'runtime-0' }), CLAIM))
            .toEqual({ ok: false, code: 'runtime-mismatch' });
    });

    it('refuses an identifier that is empty or whitespace on either side', () => {
        for (const field of ['permissionId', 'turnId', 'channelRequestId', 'runtimeId'] as const) {
            expect(verifyChannelPermissionClaim(binding(), { ...CLAIM, [field]: '' }).ok).toBe(false);
            expect(verifyChannelPermissionClaim(binding(), { ...CLAIM, [field]: '   ' }).ok).toBe(false);
        }
        expect(verifyChannelPermissionClaim(binding({ turnId: '' }), CLAIM).ok).toBe(false);
        expect(verifyChannelPermissionClaim(binding({ runtimeId: '  ' }), CLAIM).ok).toBe(false);
    });

    it('refuses an unknown permission id without distinguishing it from a mismatched one', () => {
        expect(verifyChannelPermissionClaim(undefined, CLAIM))
            .toEqual({ ok: false, code: 'unknown-permission' });
        expect(verifyChannelPermissionClaim(binding({ permissionId: 'toolu_99' }), CLAIM))
            .toEqual({ ok: false, code: 'unknown-permission' });
    });
});

describe('isExternallyAnswerableTool', () => {
    it('declines prompts that are not a yes/no, including scope escalation', () => {
        for (const tool of [
            'ExitPlanMode', 'exit_plan_mode',
            'AskUserQuestion', 'ask_user_question', 'RequestUserInput', '사용자에게질문',
            // Approving this widens the agent's filesystem scope — a privilege escalation, not
            // consent for one action (Desktop classifies it as `project-scope`).
            'ProjectFilesystemScope', 'project_filesystem_scope',
        ]) {
            expect(isExternallyAnswerableTool(tool)).toBe(false);
        }
    });

    it('declines the same tools under provider name decorations', () => {
        // A literal-alias list lets every one of these through.
        for (const tool of [
            'functions.AskUserQuestion',
            'mcp__somewhere__AskUserQuestion',
            'AskUserQuestion call',
            'exit-plan-mode',
            'Project Filesystem Scope',
        ]) {
            expect(isExternallyAnswerableTool(tool)).toBe(false);
        }
    });

    it('fails closed on a name it cannot read', () => {
        for (const value of [undefined, null, '', '   ', 42, {}]) {
            expect(isExternallyAnswerableTool(value)).toBe(false);
        }
    });

    it('allows an ordinary tool prompt', () => {
        expect(isExternallyAnswerableTool('Bash')).toBe(true);
        expect(isExternallyAnswerableTool('Write')).toBe(true);
    });
});

describe('externalAnswerCarriesPersistentGrant', () => {
    it('rejects every field that outlives the single request', () => {
        expect(externalAnswerCarriesPersistentGrant({ mode: 'default' })).toBe(true);
        expect(externalAnswerCarriesPersistentGrant({ mode: 'bypassPermissions' })).toBe(true);
        expect(externalAnswerCarriesPersistentGrant({ allowTools: ['Bash'] })).toBe(true);
        expect(externalAnswerCarriesPersistentGrant({ updatedInput: { command: 'rm -rf /' } })).toBe(true);
        // The base handler's own persistent-allow vector, distinct from allowTools.
        expect(externalAnswerCarriesPersistentGrant({ decision: 'approved_for_session' })).toBe(true);
    });

    it('fails closed on a malformed RPC body rather than reading it as "no grant"', () => {
        // The TS shape describes a well-behaved caller; this runs on whatever arrived.
        expect(externalAnswerCarriesPersistentGrant({ allowTools: 'Bash' as unknown })).toBe(true);
        expect(externalAnswerCarriesPersistentGrant({ allowTools: null as unknown })).toBe(true);
        expect(externalAnswerCarriesPersistentGrant({ allowTools: {} as unknown })).toBe(true);
        expect(externalAnswerCarriesPersistentGrant({ decision: 'approved_for_project' })).toBe(true);
        expect(externalAnswerCarriesPersistentGrant({ decision: 42 as unknown })).toBe(true);
        expect(externalAnswerCarriesPersistentGrant({ mode: null as unknown })).toBe(true);
    });

    it('accepts a bare yes/no', () => {
        expect(externalAnswerCarriesPersistentGrant({})).toBe(false);
        expect(externalAnswerCarriesPersistentGrant({ decision: 'approved' })).toBe(false);
        expect(externalAnswerCarriesPersistentGrant({ decision: 'denied' })).toBe(false);
        expect(externalAnswerCarriesPersistentGrant({ allowTools: [] })).toBe(false);
    });
});

describe('a prompt published as guidance is never answerable', () => {
    it('refuses a claim that reproduces every identifier, because the prompt is not a yes/no', () => {
        // R8/R9 publish the wait so the messenger can point at Desktop. Publishing it must not
        // make it answerable — and the refusal comes before any identifier is compared, so a
        // caller that guessed the handle learns nothing about the turn or the request.
        expect(verifyChannelPermissionClaim(binding({ answerable: false }), CLAIM))
            .toEqual({ ok: false, code: 'not-externally-answerable' });
    });

    it('still prefers the weaker refusals, so a probe learns the same thing from each', () => {
        expect(verifyChannelPermissionClaim(binding({ answerable: false, permissionId: 'other' }), CLAIM))
            .toEqual({ ok: false, code: 'unknown-permission' });
        expect(verifyChannelPermissionClaim(
            binding({ answerable: false, channelRequestId: null }), CLAIM,
        )).toEqual({ ok: false, code: 'not-channel-owned' });
    });

    it('leaves an answerable prompt unaffected', () => {
        expect(verifyChannelPermissionClaim(binding({ answerable: true }), CLAIM)).toEqual({ ok: true });
    });
});
