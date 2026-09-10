import { describe, it, expect } from 'vitest';
import {
    resolvePreviewBindingPolicy,
    decideMintBinding,
    decideRelayBinding,
    interpretLeaseAck,
    describeLeaseFailure,
    isBindingEnforcementEchoed,
    LEASE_UNSUPPORTED_CODE,
} from '@/modules/preview/previewRuntimeBinding';

const BIND = { projectId: 'proj-1', studioUserId: 'studio-1', leaseId: 'lease-1' };

describe('resolvePreviewBindingPolicy', () => {
    it('defaults to off so an unconfigured deployment keeps working', () => {
        expect(resolvePreviewBindingPolicy({})).toEqual({
            mode: 'off',
            legacyMachineIds: new Set(),
        });
    });

    it('reads required mode and the legacy machine allowlist from server env', () => {
        const policy = resolvePreviewBindingPolicy({
            PREVIEW_RUNTIME_BINDING_POLICY: 'required',
            PREVIEW_BINDING_LEGACY_MACHINE_IDS: 'machine-a, machine-b',
        });
        expect(policy.mode).toBe('required');
        expect([...policy.legacyMachineIds]).toEqual(['machine-a', 'machine-b']);
    });

    it('treats an unrecognised policy value as off rather than guessing', () => {
        expect(resolvePreviewBindingPolicy({ PREVIEW_RUNTIME_BINDING_POLICY: 'yes' }).mode).toBe('off');
    });
});

describe('decideMintBinding', () => {
    const required = resolvePreviewBindingPolicy({ PREVIEW_RUNTIME_BINDING_POLICY: 'required' });

    it('requires a binding for every machine once the rollout policy is on', () => {
        expect(decideMintBinding(required, 'machine-x')).toEqual({ kind: 'bind-required' });
    });

    it('closes the legacy bearer bypass: the same machine cannot mint unbound', () => {
        // A company happy token is accepted by /v1/preview-token for every
        // machine the company owns. If that path could still mint an unbound
        // token, binding the trusted path alone would change nothing.
        expect(decideMintBinding(required, 'shared-company-machine').kind).toBe('bind-required');
    });

    it('allows unbound mint only for machines the server operator listed', () => {
        const policy = resolvePreviewBindingPolicy({
            PREVIEW_RUNTIME_BINDING_POLICY: 'required',
            PREVIEW_BINDING_LEGACY_MACHINE_IDS: 'personal-1',
        });
        expect(decideMintBinding(policy, 'personal-1')).toEqual({ kind: 'bind-optional' });
        expect(decideMintBinding(policy, 'personal-2')).toEqual({ kind: 'bind-required' });
    });

    it('allows unbound mint while the policy is off', () => {
        expect(decideMintBinding(resolvePreviewBindingPolicy({}), 'machine-x')).toEqual({
            kind: 'bind-optional',
        });
    });
});

describe('decideRelayBinding', () => {
    const required = resolvePreviewBindingPolicy({ PREVIEW_RUNTIME_BINDING_POLICY: 'required' });
    const off = resolvePreviewBindingPolicy({});

    it('enforces the claim when the token carries one', () => {
        expect(decideRelayBinding(off, 'machine-x', { bind: BIND })).toEqual({
            kind: 'enforce',
            bind: BIND,
        });
    });

    it('enforces a bound token even on a machine listed as legacy', () => {
        // The allowlist says "this machine may mint unbound", never "ignore a
        // binding that was already minted".
        const policy = resolvePreviewBindingPolicy({
            PREVIEW_RUNTIME_BINDING_POLICY: 'required',
            PREVIEW_BINDING_LEGACY_MACHINE_IDS: 'personal-1',
        });
        expect(decideRelayBinding(policy, 'personal-1', { bind: BIND }).kind).toBe('enforce');
    });

    it('rejects an unbound token once the policy is required', () => {
        const decision = decideRelayBinding(required, 'machine-x', {});
        expect(decision).toMatchObject({ kind: 'reject', status: 401, code: 'binding-missing' });
    });

    it('lets an unbound token through on an allowlisted legacy machine', () => {
        const policy = resolvePreviewBindingPolicy({
            PREVIEW_RUNTIME_BINDING_POLICY: 'required',
            PREVIEW_BINDING_LEGACY_MACHINE_IDS: 'personal-1',
        });
        expect(decideRelayBinding(policy, 'personal-1', {})).toEqual({
            kind: 'allow-unbound',
            reason: 'legacy-machine',
        });
    });

    it('lets an unbound token through while the policy is off', () => {
        expect(decideRelayBinding(off, 'machine-x', {})).toEqual({
            kind: 'allow-unbound',
            reason: 'policy-off',
        });
    });
});

describe('interpretLeaseAck', () => {
    it('reads a successful lease', () => {
        expect(interpretLeaseAck({ type: 'success', leaseId: 'lease-1', evidenceKind: 'process' }))
            .toEqual({ type: 'success', leaseId: 'lease-1', evidenceKind: 'process' });
    });

    it('reads a typed daemon error', () => {
        expect(interpretLeaseAck({ type: 'error', code: 'NO_LISTENER', message: 'nothing on 3000' }))
            .toEqual({ type: 'error', code: 'NO_LISTENER', message: 'nothing on 3000' });
    });

    it('reports an unreadable ack as unsupported rather than as a lease', () => {
        // An old daemon has no handler for the event at all; anything that is
        // not the documented envelope must not be read as agreement.
        expect(interpretLeaseAck(undefined)).toEqual({
            type: 'error',
            code: LEASE_UNSUPPORTED_CODE,
            message: expect.stringContaining('happy-cli'),
        });
        expect(interpretLeaseAck({ ok: true })).toMatchObject({ code: LEASE_UNSUPPORTED_CODE });
        expect(interpretLeaseAck({ type: 'success' })).toMatchObject({ code: LEASE_UNSUPPORTED_CODE });
    });
});

describe('describeLeaseFailure', () => {
    it('maps an unsupported daemon to 409 with update guidance, never a downgrade', () => {
        const failure = describeLeaseFailure({
            type: 'error',
            code: LEASE_UNSUPPORTED_CODE,
            message: 'no ack',
        });
        expect(failure.status).toBe(409);
        expect(failure.body.code).toBe(LEASE_UNSUPPORTED_CODE);
        expect(failure.body.error).toContain('happy-cli');
    });

    it('maps a missing listener to 409 and a project/port mismatch to 403', () => {
        expect(describeLeaseFailure({ type: 'error', code: 'NO_LISTENER', message: '' }).status).toBe(409);
        expect(describeLeaseFailure({ type: 'error', code: 'PORT_PROJECT_MISMATCH', message: '' }).status).toBe(403);
    });

    it('maps every "not this project\'s runtime" refusal to 403', () => {
        for (const code of ['PORT_PROJECT_MISMATCH', 'PROJECT_OWNERSHIP_MISMATCH', 'WORKSPACE_UNVERIFIED']) {
            const failure = describeLeaseFailure({ type: 'error', code, message: '' });
            expect(failure.status).toBe(403);
            expect(failure.body.code).toBe(code);
        }
    });

    it('maps an unknown daemon code to 502 and keeps the code observable', () => {
        const failure = describeLeaseFailure({ type: 'error', code: 'WEIRD', message: 'x' });
        expect(failure.status).toBe(502);
        expect(failure.body.code).toBe('WEIRD');
    });
});

describe('isBindingEnforcementEchoed', () => {
    it('is true only when the daemon positively confirms it enforced the lease', () => {
        expect(isBindingEnforcementEchoed({ bindingEnforced: true })).toBe(true);
    });

    it('is false for a daemon that ignored the binding fields', () => {
        // An old daemon relays happily and returns a normal success envelope.
        // Absence of the echo is the only signal that the lease was not checked.
        expect(isBindingEnforcementEchoed({})).toBe(false);
        expect(isBindingEnforcementEchoed({ bindingEnforced: 'true' })).toBe(false);
        expect(isBindingEnforcementEchoed(undefined)).toBe(false);
    });
});
