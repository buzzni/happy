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
    | { kind: 'ready'; decision: Exclude<TerminalOpenDecision, { kind: 'refused' }>; cwdDecision: CwdDecision;
        /** Install the PTY, listeners and ACK synchronously while temporary ownership is held. */
        submit(operation: () => void): Promise<void>; cancel(): Promise<void> };

export async function prepareTerminalOpen(input: TerminalOpenAdmissionInput): Promise<TerminalOpenPreparation> {
    const preview = inspectTerminalOpen(input.opened, { machineId: input.machineId, strict: input.strict, now: input.now?.() });
    if (preview.kind === 'refused') return preview;
    if (!!input.reserveLegacyDispatch !== !!input.admitSubprocess) {
        return { kind: 'refused', code: 'WORKSPACE_ADMISSION_UNAVAILABLE', error: 'Host process reservation is unavailable' };
    }
    const reservations: Array<Extract<LegacyDispatchReservation, { acquired: true }>> = [];
    let prepared = false;
    const finish = async () => {
        for (const reservation of [...reservations].reverse()) {
            try { await reservation.finish(); }
            catch { logger.debug('[terminal-open] Workspace handoff unconfirmed; ownership remains reserved'); }
        }
    };
    try {
    if (input.reserveLegacyDispatch) {
        const params = preview.params as { cwd?: unknown } | null;
        const requested = typeof params?.cwd === 'string' ? params.cwd : undefined;
        const validation = requested ? input.cwd.validate(requested, input.cwd.allowedRoot) : null;
        const candidate = requested && validation?.valid ? validation.resolvedPath ?? requested : input.cwd.homedir;
        const admitted = await input.reserveLegacyDispatch([candidate]);
        if (!admitted.acquired) return { kind: 'refused', code: 'WORKSPACE_UNAVAILABLE', error: admitted.reason };
        reservations.push(admitted);
    }
    const decision = decideTerminalOpen(input.opened, { machineId: input.machineId, strict: input.strict,
        nonceGuard: input.nonceGuard, now: input.now?.() });
    if (decision.kind === 'refused') return decision;
    const params = decision.params as { cwd?: unknown } | null;
    const cwdDecision = decideTerminalCwd({ ...input.cwd, requested: typeof params?.cwd === 'string' ? params.cwd : undefined });
    if (input.reserveLegacyDispatch) {
        const actual = await input.reserveLegacyDispatch([cwdDecision.cwd]);
        if (!actual.acquired) return { kind: 'refused', code: 'WORKSPACE_UNAVAILABLE', error: actual.reason };
        reservations.push(actual);
    }
    let phase: 'prepared' | 'submitted' | 'cancelled' = 'prepared';
    prepared = true;
    return { kind: 'ready', decision, cwdDecision,
        async cancel() {
            if (phase !== 'prepared') return;
            phase = 'cancelled';
            await finish();
        },
        async submit(operation) {
            if (phase !== 'prepared') throw new Error('TERMINAL_OPEN_ALREADY_SETTLED');
            // Folder approval may change while workspace reservations are awaited. Check in
            // the same synchronous turn as PTY creation; the intentional home fallback stays valid.
            if (typeof params?.cwd === 'string' && params.cwd && !cwdDecision.fallback) {
                const current = input.cwd.validate(cwdDecision.cwd, input.cwd.allowedRoot);
                if (!current.valid || (current.resolvedPath ?? cwdDecision.cwd) !== cwdDecision.cwd) {
                    throw new Error('TERMINAL_DIRECTORY_APPROVAL_CHANGED');
                }
            }
            phase = 'submitted';
            try { operation(); }
            finally {
                // Until durable retention succeeds, the temporary owners still block auto.
                // A tracking failure cannot overwrite a real process result or release its scope.
                let retained = true;
                try { await input.admitSubprocess?.([cwdDecision.cwd]); }
                catch {
                    retained = false;
                    logger.debug('[terminal-open] Submitted writer retention unconfirmed; temporary ownership retained');
                }
                if (retained) await finish();
            }
        },
    };
    } catch {
        return { kind: 'refused', code: 'WORKSPACE_UNAVAILABLE', error: 'Workspace approval is unconfirmed' };
    } finally {
        if (!prepared) await finish();
    }
}
