/**
 * Which terms of its own identity a machine may supply for itself.
 *
 * Every refusal here is a marker that would otherwise have been written with a
 * value nobody authorised — and the marker is what every later readiness
 * answer, receipt and fencing decision is made in the terms of.
 */
import { describe, expect, it } from 'vitest';

import { composeManagedMarker } from '@/managed/managedMarkerComposer';

const INPUT = {
    saycode_workspace: 'ws-1',
    saycode_project: 'proj-1',
    saycode_runtime: 'rt-1',
    saycode_operation: 'op-1',
    saycode_config_digest: 'digest-1',
    saycode_isolation_backend: 'privileged-launch-supervisor',
    saycode_provider_uid: '10601',
    saycode_provider_gid: '10601',
    saycode_executor_uid: '10602',
    saycode_executor_gid: '10600',
    saycode_cgroup_root: '/sys/fs/cgroup/saycode',
    saycode_verifier_key: 'kid-1',
    saycode_verifier_public_key: 'cHVibGljLWtleQ==',
    saycode_state_dir: '/var/lib/saycode/state',
    saycode_workspace_dir: '/workspace',
    saycode_volume: 'vol_1',
    // The two ceilings the parent approved for this runtime's tool use.
    saycode_tool_grant_ttl_ms: '600000',
    saycode_tool_call_timeout_ms: '120000',
    // How long a checkpoint waits for writes in flight before it seals.
    saycode_checkpoint_drain_budget_ms: '15000',
    // The tenant axis the checkpoint's sealing is bound to.
    saycode_tenant: 'company:acme-1',
    // 체크포인트 일정. 부모가 승인하고 runtime 이 지어내지 않는다.
    saycode_checkpoint_period_ms: '900000',
    saycode_checkpoint_on_turn_boundary: 'true',
};

const INSTANCE = { providerMachineId: 'fly_m1', providerInstanceId: 'inst_1' };

function compose(over: {
    metadata?: Record<string, string | undefined>;
    instance?: { providerMachineId: string | null; providerInstanceId: string | null };
    happyMachineId?: string | null;
} = {}) {
    return composeManagedMarker({
        metadata: over.metadata ?? INPUT,
        instance: over.instance ?? INSTANCE,
        happyMachineId: over.happyMachineId === undefined ? 'machine-1' : over.happyMachineId,
    });
}

describe('composing the marker from the parent boot input', () => {
    it('takes each axis from whoever is entitled to answer it', () => {
        const outcome = compose();
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.record).toEqual({
            runtimeId: 'rt-1',
            workspaceId: 'ws-1',
            projectId: 'proj-1',
            keyId: 'kid-1',
            // Only the server can mint this, so it comes from the grant.
            happyMachineId: 'machine-1',
            provisioningOperationId: 'op-1',
            configDigest: 'digest-1',
            // Only this machine knows which instance is running.
            providerMachineId: 'fly_m1',
            providerInstanceId: 'inst_1',
            providerVolumeId: 'vol_1',
            stateDir: '/var/lib/saycode/state',
            toolPolicy: { grantTtlMs: 600_000, callTimeoutMs: 120_000 },
            checkpoint: { drainBudgetMs: 15_000 },
            tenant: 'company:acme-1',
            checkpointSchedule: { periodMs: 900_000, onTurnBoundary: true },
            workspaceDir: '/workspace',
            verifierPublicKey: 'cHVibGljLWtleQ==',
            isolation: {
                backend: 'privileged-launch-supervisor',
                provider: { uid: 10601, gid: 10601 },
                executor: { uid: 10602, gid: 10600 },
                cgroupRoot: '/sys/fs/cgroup/saycode',
            },
        });
    });

    it('separates an ordinary machine from a managed one missing an axis', () => {
        // Nothing at all is BYOS. Something-but-not-everything is a managed
        // machine that must not boot, and filling the gap in is how a receipt
        // store ends up somewhere the agent can write.
        expect(compose({ metadata: {} })).toEqual({ ok: false, reason: 'not-managed' });
        expect(compose({ metadata: { saycode_workspace: 'ws-1' } }))
            .toEqual({ ok: false, reason: 'metadata-incomplete' });
    });

    it.each(Object.keys(INPUT))('refuses when %s is missing', (key) => {
        expect(compose({ metadata: { ...INPUT, [key]: undefined } }))
            .toEqual({ ok: false, reason: 'metadata-incomplete' });
    });

    it.each([
        ['a uid that is not a number', { saycode_executor_uid: 'root' }],
        ['a uid that is root', { saycode_executor_uid: '0' }],
        ['a negative uid', { saycode_executor_uid: '-5' }],
        ['a uid with a decimal point', { saycode_executor_uid: '10602.5' }],
    ])('refuses %s', (_name, over) => {
        expect(compose({ metadata: { ...INPUT, ...over } }))
            .toEqual({ ok: false, reason: 'metadata-incomplete' });
    });

    it('refuses one uid wearing both roles', () => {
        // The same rule the marker reader applies, applied before the file
        // exists — otherwise the boot writes a marker that can never activate.
        expect(compose({ metadata: { ...INPUT, saycode_executor_uid: '10601' } }))
            .toEqual({ ok: false, reason: 'uid-not-separated' });
    });

    it('refuses when the machine cannot say which instance it is', () => {
        expect(compose({ instance: { providerMachineId: null, providerInstanceId: 'inst_1' } }))
            .toEqual({ ok: false, reason: 'instance-unidentified' });
        expect(compose({ instance: { providerMachineId: 'fly_m1', providerInstanceId: '  ' } }))
            .toEqual({ ok: false, reason: 'instance-unidentified' });
    });

    it('refuses without the address the server issued', () => {
        // A runtime that named its own Happy machine id would publish readiness
        // for a machine nobody is listening on — or for somebody else's.
        expect(compose({ happyMachineId: null }))
            .toEqual({ ok: false, reason: 'happy-address-missing' });
    });

    it('does not read an axis out of a neighbouring one', () => {
        // Every value is taken by its own key. A composer that fell back to
        // another field would silently bind this runtime to another's scope.
        const outcome = compose({
            metadata: { ...INPUT, saycode_project: 'a-different-project' },
        });
        expect(outcome.ok).toBe(true);
        if (outcome.ok) expect(outcome.record.projectId).toBe('a-different-project');
    });
});

describe('the tool ceilings the parent approved', () => {
    /*
     * Neither has a default, and that is the point: a runtime that invented a
     * ceiling would be running under a policy nobody approved. The values
     * differ by workspace and plan, so they arrive with the rest of the boot
     * input rather than being baked into the image.
     */
    it('carries both, as numbers', () => {
        const composed = composeManagedMarker({
            metadata: INPUT, instance: INSTANCE, happyMachineId: 'machine-1',
        });
        expect(composed.ok).toBe(true);
        if (!composed.ok) return;
        expect(composed.record.toolPolicy).toEqual({ grantTtlMs: 600_000, callTimeoutMs: 120_000 });
    });

    it.each([
        ['no grant ttl', 'saycode_tool_grant_ttl_ms', undefined],
        ['no call timeout', 'saycode_tool_call_timeout_ms', undefined],
        ['a grant ttl of zero', 'saycode_tool_grant_ttl_ms', '0'],
        ['a negative call timeout', 'saycode_tool_call_timeout_ms', '-1'],
        ['a grant ttl that is not a number', 'saycode_tool_grant_ttl_ms', 'soon'],
        ['a fractional call timeout', 'saycode_tool_call_timeout_ms', '1.5'],
        /*
         * The checkpoint's drain budget is the same kind of axis as the two
         * above: execution control the parent decides per workspace and plan,
         * not an image constant. A checkpoint that sealed after a budget nobody
         * approved would either cut writes still in flight or hold the runtime
         * for a window nobody chose.
         */
        /*
         * The tenant axis is **sealing material**, not a label: the checkpoint
         * archive binds it into the AEAD's additional data, so an archive
         * sealed under one tenant does not open under another. A runtime that
         * invented it could neither checkpoint nor restore.
         */
        ['no tenant', 'saycode_tenant', undefined],
        ['a blank tenant', 'saycode_tenant', '   '],
        /*
         * 일정도 정책이다. 없으면 활성화하지 않는다 — 여기서 기본값을 만들면
         * 아무도 승인하지 않은 주기로 볼륨을 계속 봉인하게 되고, 반대로 조용히
         * "안 찍음" 으로 두면 사용자는 저장되고 있다고 믿는 동안 아무것도
         * 저장되지 않는다.
         */
        ['no checkpoint period', 'saycode_checkpoint_period_ms', undefined],
        ['a checkpoint period of zero', 'saycode_checkpoint_period_ms', '0'],
        ['no turn-boundary decision', 'saycode_checkpoint_on_turn_boundary', undefined],
        ['a turn-boundary decision that is not a boolean', 'saycode_checkpoint_on_turn_boundary', 'yes'],
        ['no drain budget', 'saycode_checkpoint_drain_budget_ms', undefined],
        ['a drain budget of zero', 'saycode_checkpoint_drain_budget_ms', '0'],
        ['a fractional drain budget', 'saycode_checkpoint_drain_budget_ms', '1.5'],
    ])('refuses %s', (_name, key, value) => {
        const metadata: Record<string, string | undefined> = { ...INPUT };
        if (value === undefined) delete metadata[key];
        else metadata[key] = value;
        expect(composeManagedMarker({
            metadata, instance: INSTANCE, happyMachineId: 'machine-1',
        })).toEqual({ ok: false, reason: 'metadata-incomplete' });
    });
});

describe('the checkpoint schedule the parent approved', () => {
    it('carries the optional backoff only when the parent set one', () => {
        const withBackoff = composeManagedMarker({
            metadata: { ...INPUT, saycode_checkpoint_failure_backoff_ms: '60000' },
            instance: INSTANCE,
            happyMachineId: 'machine-1',
        });
        expect(withBackoff.ok && withBackoff.record.checkpointSchedule)
            .toEqual({ periodMs: 900_000, onTurnBoundary: true, failureBackoffMs: 60_000 });
        // 없으면 **없는 채로** 간다. 여기서 숫자를 만들면 그 숫자는 아무도
        // 승인한 적이 없고, 스케줄러의 문서화된 동작을 조용히 덮는다.
        const without = compose();
        expect(without.ok && 'failureBackoffMs' in without.record.checkpointSchedule).toBe(false);
    });

    it('refuses a backoff that is present and unusable', () => {
        expect(composeManagedMarker({
            metadata: { ...INPUT, saycode_checkpoint_failure_backoff_ms: 'later' },
            instance: INSTANCE,
            happyMachineId: 'machine-1',
        })).toEqual({ ok: false, reason: 'metadata-incomplete' });
    });

    it('reads a false turn-boundary as a decision, not as absence', () => {
        const composed = composeManagedMarker({
            metadata: { ...INPUT, saycode_checkpoint_on_turn_boundary: 'false' },
            instance: INSTANCE,
            happyMachineId: 'machine-1',
        });
        expect(composed.ok && composed.record.checkpointSchedule.onTurnBoundary).toBe(false);
    });
});
