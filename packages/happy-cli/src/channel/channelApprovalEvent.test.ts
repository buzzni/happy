import { describe, expect, it } from 'vitest';
import { sessionEnvelopeSchema } from '@slopus/happy-wire';

import {
    buildChannelApprovalObservation,
    channelApprovalEvent,
    channelApprovalWithdrawnEvent,
} from './channelApprovalEvent';
import type { ChannelPermissionBinding } from './channelPermissionBinding';

const NOW = 1_700_000_000_000;

const binding = (overrides: Partial<ChannelPermissionBinding> = {}): ChannelPermissionBinding => ({
    permissionId: 'perm-1',
    turnId: 'turn-a',
    channelRequestId: 'req-1',
    runtimeId: 'runtime-1',
    answerable: true,
    ...overrides,
});

describe('buildChannelApprovalObservation', () => {
    it('carries the four identifiers and a kind, and nothing else', () => {
        // Exact equality is the point: a field added upstream shows up here as a failure rather
        // than as an extra fact on the wire.
        expect(buildChannelApprovalObservation(binding())).toEqual({
            permissionId: 'perm-1',
            turnId: 'turn-a',
            channelRequestId: 'req-1',
            runtimeId: 'runtime-1',
            kind: 'generic',
        });
    });

    it('publishes a non-binary prompt as desktop-only rather than dropping it', () => {
        // The bug this closes: an externally-started turn that hit `AskUserQuestion` or
        // `ExitPlanMode` produced no event at all, so the messenger was told nothing and the turn
        // appeared to stall. R8 requires the approval-wait state to be visible.
        expect(buildChannelApprovalObservation(binding({ answerable: false }))).toEqual({
            permissionId: 'perm-1',
            turnId: 'turn-a',
            channelRequestId: 'req-1',
            runtimeId: 'runtime-1',
            kind: 'desktop-only',
        });
    });

    it('says nothing about the tool beyond the kind', () => {
        const answerable = buildChannelApprovalObservation(binding());
        const guidance = buildChannelApprovalObservation(binding({ answerable: false }));
        // The two differ in exactly one field. No name, no arguments, no risk class.
        expect(Object.keys(answerable ?? {}).sort()).toEqual([
            'channelRequestId', 'kind', 'permissionId', 'runtimeId', 'turnId',
        ]);
        expect({ ...answerable, kind: null }).toEqual({ ...guidance, kind: null });
    });

    it('publishes nothing for a prompt no external request opened, whatever its kind', () => {
        // An in-app prompt belongs to the Desktop user. Publishing it would invite an answer — or
        // a hand-off instruction — aimed at someone who is not looking at it.
        for (const answerable of [true, false]) {
            expect(buildChannelApprovalObservation(binding({ channelRequestId: null, answerable })))
                .toBeNull();
            expect(buildChannelApprovalObservation(binding({ channelRequestId: '   ', answerable })))
                .toBeNull();
        }
    });

    it('publishes nothing without a binding or with an incomplete one', () => {
        expect(buildChannelApprovalObservation(undefined)).toBeNull();
        expect(buildChannelApprovalObservation(binding({ turnId: '' }))).toBeNull();
        expect(buildChannelApprovalObservation(binding({ runtimeId: '' }))).toBeNull();
        expect(buildChannelApprovalObservation(binding({ permissionId: '' }))).toBeNull();
    });
});

describe('channel permission wire events', () => {
    const answerable = buildChannelApprovalObservation(binding())!;
    const guidance = buildChannelApprovalObservation(binding({ answerable: false }))!;

    it('emits exactly the agreed raised shape for both kinds', () => {
        expect(channelApprovalEvent(answerable, NOW)).toEqual({
            t: 'channel-permission',
            permissionId: 'perm-1',
            turnId: 'turn-a',
            channelRequestId: 'req-1',
            runtimeId: 'runtime-1',
            kind: 'generic',
            createdAt: NOW,
        });
        expect(channelApprovalEvent(guidance, NOW)).toMatchObject({ kind: 'desktop-only' });
    });

    it('does not carry the kind on a withdrawal', () => {
        // The withdrawal retracts a prompt the consumer already has, matched by `permissionId`.
        // Re-stating the kind would be a second place for the two to disagree.
        const event = channelApprovalWithdrawnEvent(guidance, 'answered', NOW) as Record<string, unknown>;
        expect(event).toEqual({
            t: 'channel-permission-withdrawn',
            permissionId: 'perm-1',
            turnId: 'turn-a',
            channelRequestId: 'req-1',
            runtimeId: 'runtime-1',
            reason: 'answered',
            createdAt: NOW,
        });
        expect(Object.keys(event)).not.toContain('kind');
    });

    it('accepts every event under the agent role', () => {
        for (const ev of [
            channelApprovalEvent(answerable, NOW),
            channelApprovalEvent(guidance, NOW),
            channelApprovalWithdrawnEvent(guidance, 'aborted', NOW),
        ]) {
            const parsed = sessionEnvelopeSchema.safeParse({ id: 'e', time: 1, role: 'agent', ev });
            expect(parsed.success, JSON.stringify(ev)).toBe(true);
        }
    });

    it('refuses every event under the user role, because only the agent knows a prompt was raised', () => {
        for (const ev of [
            channelApprovalEvent(answerable, NOW),
            channelApprovalEvent(guidance, NOW),
            channelApprovalWithdrawnEvent(guidance, 'reset', NOW),
        ]) {
            const parsed = sessionEnvelopeSchema.safeParse({ id: 'e', time: 1, role: 'user', ev });
            expect(parsed.success, JSON.stringify(ev)).toBe(false);
        }
    });

    it('refuses a raised event that smuggles a field outside the contract', () => {
        for (const extra of [
            { arguments: { command: 'ls' } },
            { toolName: 'Bash' },
            { risk: { dangerous: true } },
            { input: 'anything' },
        ]) {
            const parsed = sessionEnvelopeSchema.safeParse({
                id: 'e', time: 1, role: 'agent',
                ev: { ...channelApprovalEvent(guidance, NOW), ...extra },
            });
            // `.strict()` is what keeps the externally visible facts reviewable in one place.
            expect(parsed.success, JSON.stringify(extra)).toBe(false);
        }
    });

    it('refuses an unrecognised kind, rather than reading it as generic', () => {
        const parsed = sessionEnvelopeSchema.safeParse({
            id: 'e', time: 1, role: 'agent',
            ev: { ...channelApprovalEvent(answerable, NOW), kind: 'buttons-v2' },
        });
        expect(parsed.success).toBe(false);
    });

    it('refuses an unrecognised withdrawal reason', () => {
        const parsed = sessionEnvelopeSchema.safeParse({
            id: 'e', time: 1, role: 'agent',
            ev: { ...channelApprovalWithdrawnEvent(guidance, 'answered', NOW), reason: 'expired' },
        });
        expect(parsed.success).toBe(false);
    });
});
