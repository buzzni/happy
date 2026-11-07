import { randomUUID } from 'node:crypto';

export type CodexAuthSource = 'cli-login' | 'custom-home' | 'multi-auth' | 'managed' | 'unknown';
export type CodexAuthCheck = 'authenticated' | 'unverified';
export class CodexAuthRecoveryError extends Error {
    constructor(readonly reason: 'authentication-required' | 'account-check-failed' | 'limit-reached' | 'resume-failed' | 'restart-failed') {
        super(reason);
    }
}

type RecoveryFailureReason = CodexAuthRecoveryError['reason'];

/** Turn notices for a blocked session. Desktop translates these exact texts (src/domain/runtimeEventMessages.ts). */
export const CODEX_AUTH_BLOCKED_NOTICES = {
    limitReached: 'Codex usage limit is still reached, so this message was not sent. Send it again after the limit resets, or switch this conversation to another AI.',
    signInRequired: 'Codex is not signed in on this machine, so this message was not sent. Sign in to Codex again, then send the message again.',
    reconnectFailed: 'Codex could not reconnect this conversation after a sign-in or usage limit error, so this message was not sent. Check the Codex connection, then send the message again.',
} as const;

/** A blocked turn names its reason; the generic process-exit notice would hide the recovery the user needs. */
export function describeCodexAuthRecoveryFailure(error: unknown): string | null {
    if (!(error instanceof CodexAuthRecoveryError)) return null;
    if (error.reason === 'limit-reached') return CODEX_AUTH_BLOCKED_NOTICES.limitReached;
    if (error.reason === 'authentication-required') return CODEX_AUTH_BLOCKED_NOTICES.signInRequired;
    return CODEX_AUTH_BLOCKED_NOTICES.reconnectFailed;
}

type RecoveryClient = {
    readonly authRecoverySource: CodexAuthSource;
    readonly authRecoveryBusy: boolean;
    readonly threadId: string | null;
    reconnectForAuth(): Promise<CodexAuthCheck>;
};
type RecoveryResult = {
    version: 1;
    runtimeId: string;
    generation: number;
    status: 'ready' | 'failed' | 'busy' | 'stale' | 'unsupported';
    account?: CodexAuthCheck;
    reason?: string;
};

/** Session-local transaction: no credential files, prompt replay, or daemon-wide mutations. */
export class CodexAuthRecovery {
    private readonly runtimeId = randomUUID();
    private generation = 0;
    private turnBusy = false;
    private blocked = false;
    private lastFailure: RecoveryFailureReason | null = null;
    private inFlight: Promise<RecoveryResult> | null = null;
    private operationId: string | null = null;
    private last: { operationId: string; result: RecoveryResult } | null = null;

    constructor(private readonly client: RecoveryClient, private readonly externallyBusy: () => boolean) {}

    status() {
        const source = this.client.authRecoverySource;
        return {
            version: 1 as const, runtimeId: this.runtimeId, generation: this.generation, source,
            state: this.inFlight ? 'recovering' as const : this.blocked ? 'failed' as const : 'idle' as const,
            canRecover: source !== 'managed' && source !== 'unknown' && !!this.client.threadId,
        };
    }

    async beginTurn(): Promise<void> {
        while (this.inFlight) await this.inFlight;
        this.turnBusy = true;
    }
    endTurn(): void { this.turnBusy = false; }
    assertReady(): void {
        if (this.blocked) throw new Error('Codex authentication recovery is required before continuing this conversation');
    }

    /**
     * A message sent into a session a failed recovery left blocked runs the same transaction once
     * before dispatch. Only that new message goes out, on the resumed thread; nothing is replayed.
     */
    async prepareTurn(): Promise<void> {
        if (!this.blocked) return;
        if (!this.status().canRecover || this.client.authRecoveryBusy) throw new CodexAuthRecoveryError(this.lastFailure ?? 'restart-failed');
        this.generation++;
        try {
            await this.client.reconnectForAuth();
            this.blocked = false;
            this.lastFailure = null;
        } catch (error) {
            this.lastFailure = error instanceof CodexAuthRecoveryError ? error.reason : 'restart-failed';
            throw new CodexAuthRecoveryError(this.lastFailure);
        }
    }

    recover(params: Record<string, unknown>): Promise<RecoveryResult> {
        const result = (status: RecoveryResult['status'], reason?: string): RecoveryResult => ({
            version: 1, runtimeId: this.runtimeId, generation: this.generation, status, ...(reason ? { reason } : {}),
        });
        if (!params || params.version !== 1 || params.runtimeId !== this.runtimeId
            || typeof params.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(params.operationId)) {
            return Promise.resolve(result('stale'));
        }
        if (this.last?.operationId === params.operationId) return Promise.resolve(this.last.result);
        if (this.inFlight) return this.operationId === params.operationId ? this.inFlight : Promise.resolve(result('busy'));
        if (params.generation !== this.generation) return Promise.resolve(result('stale'));
        if (!this.status().canRecover) return Promise.resolve(result('unsupported'));
        if (this.turnBusy || this.client.authRecoveryBusy || this.externallyBusy()) return Promise.resolve(result('busy'));

        const operationId = params.operationId;
        this.operationId = operationId;
        this.blocked = true;
        this.generation++;
        // Reserve synchronously; a queued message cannot enter between checking idle and restarting.
        this.inFlight = Promise.resolve().then(async () => {
            try {
                const account = await this.client.reconnectForAuth();
                this.blocked = false;
                this.lastFailure = null;
                return { ...result('ready'), account };
            } catch (error) {
                // Provider errors may contain credentials. Only our bounded codes cross the RPC.
                this.lastFailure = error instanceof CodexAuthRecoveryError ? error.reason : 'restart-failed';
                return result('failed', this.lastFailure);
            }
        }).then(outcome => {
            this.last = { operationId, result: outcome };
            return outcome;
        }).finally(() => { this.inFlight = null; this.operationId = null; });
        return this.inFlight;
    }
}
