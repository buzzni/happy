import type { RpcNonceGuard } from '@/api/rpc/rpcNonceGuard';
import type { LegacyDispatchReservation } from '@/utils/workspaceTurnAdmission';
import { logger } from '@/ui/logger';
import { decideTerminalCwd, type CwdDecision, type DecideTerminalCwdInput } from './decideTerminalCwd';
import { decideTerminalOpen, inspectTerminalOpen, type TerminalOpenDecision } from './terminalBindingSession';

export interface TerminalOpenAdmissionInput {
    opened: unknown;
    machineId: string;
    strict: boolean;
    nonceGuard: RpcNonceGuard;
    now?: () => number;
    cwd: Omit<DecideTerminalCwdInput, 'requested'>;
    reserveLegacyDispatch?: (roots: readonly string[]) => Promise<LegacyDispatchReservation>;
    admitSubprocess?: (roots: readonly string[]) => Promise<void>;
}

export type TerminalOpenPreparation = Extract<TerminalOpenDecision, { kind: 'refused' }>
    | { kind: 'ready'; decision: Exclude<TerminalOpenDecision, { kind: 'refused' }>; cwdDecision: CwdDecision };

export async function prepareTerminalOpen(input: TerminalOpenAdmissionInput): Promise<TerminalOpenPreparation> {
    const preview = inspectTerminalOpen(input.opened, { machineId: input.machineId, strict: input.strict, now: input.now?.() });
    if (preview.kind === 'refused') return preview;
    if (!!input.reserveLegacyDispatch !== !!input.admitSubprocess) {
        return { kind: 'refused', code: 'WORKSPACE_ADMISSION_UNAVAILABLE', error: 'Host process reservation is unavailable' };
    }
    let reservation: Extract<LegacyDispatchReservation, { acquired: true }> | undefined;
    try {
    if (input.reserveLegacyDispatch) {
        const params = preview.params as { cwd?: unknown } | null;
        const requested = typeof params?.cwd === 'string' ? params.cwd : undefined;
        const validation = requested ? input.cwd.validate(requested, input.cwd.allowedRoot) : null;
        const candidate = requested && validation?.valid ? validation.resolvedPath ?? requested : input.cwd.homedir;
        const admitted = await input.reserveLegacyDispatch([candidate]);
        if (!admitted.acquired) return { kind: 'refused', code: 'WORKSPACE_UNAVAILABLE', error: admitted.reason };
        reservation = admitted;
    }
    const decision = decideTerminalOpen(input.opened, { machineId: input.machineId, strict: input.strict,
        nonceGuard: input.nonceGuard, now: input.now?.() });
    if (decision.kind === 'refused') return decision;
    const params = decision.params as { cwd?: unknown } | null;
    const cwdDecision = decideTerminalCwd({ ...input.cwd, requested: typeof params?.cwd === 'string' ? params.cwd : undefined });
    await input.admitSubprocess?.([cwdDecision.cwd]);
    return { kind: 'ready', decision, cwdDecision };
    } catch {
        return { kind: 'refused', code: 'WORKSPACE_UNAVAILABLE', error: 'Workspace approval is unconfirmed' };
    } finally {
        try { await reservation?.finish(); }
        catch { logger.debug('[terminal-open] Workspace handoff unconfirmed; ownership remains reserved'); }
    }
}
