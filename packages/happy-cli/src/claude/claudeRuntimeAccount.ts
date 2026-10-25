import { randomBytes } from 'node:crypto';
import { readSetupTokenResumeSelection, isMachineSetupTokenBinding, SETUP_TOKEN_BINDING_ENV } from '@/daemon/sessionEnv';

/** Encrypted session-stream display data only; never a credential or selection command. */
export type ClaudeRuntimeAccount = {
    type: 'runtime-account'; version: 1 | 2; personalFallbackSupported?: true; personalFallbackGeneration?: number; sessionId: string; provider: 'claude';
    epoch: string; seq: number; observedAt: number;
} & ({ kind: 'unknown' } | { kind: 'personal'; companyId: string; machineId: string; accountRef: string; label: string } | {
    kind: 'organization'; companyId: string; machineId: string;
    managedAccountId: string; credentialGeneration: number;
});

export class ClaudeRuntimeAccountPublisher {
    private readonly epoch = `${String(Date.now()).padStart(13, '0')}-${randomBytes(8).toString('hex')}`;
    private current: ClaudeRuntimeAccount | null = null;
    private timer: ReturnType<typeof setInterval> | undefined;
    constructor(private readonly sessionId: () => string, private readonly emit: (frame: ClaudeRuntimeAccount) => void) {}
    /** Called with the binding captured by the provider that actually started, never a future choice. */
    update(rawBinding: string | undefined, fallback?: { companyId: string; machineId: string; generation: number; personal: { accountRef: string; label: string } | null }) {
        let identity: Pick<ClaudeRuntimeAccount, 'kind'> & Record<string, unknown> = { kind: 'unknown' };
        try {
            const binding = readSetupTokenResumeSelection(rawBinding === undefined ? undefined : { [SETUP_TOKEN_BINDING_ENV]: rawBinding })?.binding;
            if (binding && (!isMachineSetupTokenBinding(binding) || binding.execution.sessionId === this.sessionId())) identity = { kind: 'organization', companyId: binding.companyId, machineId: binding.machineId,
                managedAccountId: binding.managedAccountId, credentialGeneration: binding.credentialGeneration };
        } catch { /* An invalid or absent proof stays unknown. No ambient login or secret is read. */ }
        if (fallback?.personal) identity = { kind: 'personal', companyId: fallback.companyId, machineId: fallback.machineId, ...fallback.personal };
        this.current = { type: 'runtime-account', version: fallback ? 2 : 1, ...(fallback ? { personalFallbackSupported: true as const, personalFallbackGeneration: fallback.generation } : {}), sessionId: this.sessionId(), provider: 'claude',
            epoch: this.epoch, seq: (this.current?.seq ?? 0) + 1, observedAt: Date.now(), ...identity } as ClaudeRuntimeAccount;
        this.resend();
        this.timer ??= setInterval(() => this.resend(), 10_000);
        this.timer.unref?.();
    }
    /** Repeat the whole state for late viewers and lost volatile frames; ordering is unchanged. */
    resend() { if (this.current) this.emit({ ...this.current, observedAt: Date.now() }); }
    dispose() { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.current = null; }
}
