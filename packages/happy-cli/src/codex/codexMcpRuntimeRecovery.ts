import type { McpRuntimeServerStatus } from '@slopus/happy-wire';

export type CodexMcpStartupStatus = {
    threadId?: string | null;
    name: string;
    status: string;
    error?: string | null;
    failureReason?: string | null;
};

export type CodexMcpServerInventory = {
    name: string;
    authStatus: string;
    tools: Record<string, unknown>;
};

type CodexMcpRuntimeClient = {
    getMcpStartupStatuses: () => CodexMcpStartupStatus[];
    listMcpServerStatus: (opts: { threadId: string }) => Promise<{
        data: CodexMcpServerInventory[];
        nextCursor?: string | null;
    }>;
    resumeThread: (opts: {
        threadId: string;
        mcpServers: Record<string, unknown>;
        developerInstructions?: string;
    }) => Promise<{ threadId: string; model: string }>;
};

export type CodexMcpRecoveryResult = {
    status: 'ready' | 'recovered' | 'needs-auth' | 'failed';
    affectedServers: string[];
    serverStatuses?: Array<{
        name: string;
        status: 'recovered' | 'needs-auth' | 'failed';
    }>;
};

export function buildCodexMcpRecoveryMetadataStatuses(input: {
    recovery: CodexMcpRecoveryResult;
    connectorNames: readonly string[];
    checkedAt: number;
}): McpRuntimeServerStatus[] {
    const connectorNames = new Set(input.connectorNames);
    const serverStatuses = input.recovery.serverStatuses
        ?? input.recovery.affectedServers.map((name) => ({
            name,
            status: input.recovery.status,
        }));

    return serverStatuses.map(({ name, status }) => {
        const runtimeStatus = status === 'recovered'
            ? 'connected' as const
            : status === 'needs-auth'
                ? (connectorNames.has(name) ? 'connector-needs-auth' as const : 'needs-auth' as const)
                : (connectorNames.has(name) ? 'connector-runtime-failed' as const : 'failed' as const);
        return {
            name,
            status: runtimeStatus,
            ...(status === 'needs-auth'
                ? { error: 'MCP authentication is required' }
                : status === 'failed'
                    ? { error: 'MCP runtime initialization failed' }
                    : {}),
            checkedAt: input.checkedAt,
        };
    });
}

type RecoveryOptions = {
    maxAttempts?: number;
    backoffMs?: number;
    cooldownMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
};

type RecoveryInput = {
    threadId: string;
    mcpServers: Record<string, unknown>;
    expectedServerNames: string[];
    developerInstructions?: string;
};

type RuntimeInspection = {
    status: 'ready' | 'needs-auth' | 'failed';
    affectedServers: string[];
    needsAuthServers: string[];
    failedServers: string[];
};

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_BACKOFF_MS = 250;
const DEFAULT_COOLDOWN_MS = 30_000;

export class CodexMcpRuntimeRecovery {
    private readonly maxAttempts: number;
    private readonly backoffMs: number;
    private readonly cooldownMs: number;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly inFlight = new Map<string, Promise<CodexMcpRecoveryResult>>();
    private readonly cooldowns = new Map<string, { failureSignature: string; until: number }>();
    private readonly unhealthyServers = new Map<string, string[]>();

    constructor(
        private readonly client: CodexMcpRuntimeClient,
        options: RecoveryOptions = {},
    ) {
        this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
        this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
        this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    }

    recoverBeforeTurn(input: RecoveryInput): Promise<CodexMcpRecoveryResult> {
        const existing = this.inFlight.get(input.threadId);
        if (existing) return existing;

        const recovery = this.recover(input).finally(() => {
            this.inFlight.delete(input.threadId);
        });
        this.inFlight.set(input.threadId, recovery);
        return recovery;
    }

    private async recover(input: RecoveryInput): Promise<CodexMcpRecoveryResult> {
        const initial = await this.inspect(input);
        const expected = new Set(input.expectedServerNames);
        const initiallyUnhealthy = new Set(initial.affectedServers);
        const previouslyRecovered = (this.unhealthyServers.get(input.threadId) ?? [])
            .filter((name) => expected.has(name) && !initiallyUnhealthy.has(name));
        if (initial.status === 'ready') {
            this.cooldowns.delete(input.threadId);
            this.unhealthyServers.delete(input.threadId);
            if (previouslyRecovered.length > 0) {
                return { status: 'recovered', affectedServers: previouslyRecovered };
            }
            return { status: 'ready', affectedServers: [] };
        }
        if (initial.failedServers.length === 0) {
            this.cooldowns.delete(input.threadId);
            this.unhealthyServers.set(input.threadId, initial.affectedServers);
            return this.toResult(initial, previouslyRecovered);
        }
        const failureSignature = JSON.stringify(initial.failedServers);
        const cooldown = this.cooldowns.get(input.threadId);
        if (cooldown?.failureSignature === failureSignature && cooldown.until > this.now()) {
            this.unhealthyServers.set(input.threadId, initial.affectedServers);
            return this.toResult(initial, previouslyRecovered);
        }

        const initiallyAffected = initial.affectedServers;
        const recoveredSinceInitial = (stillAffected: string[]): string[] => {
            const stillUnhealthy = new Set(stillAffected);
            return [
                ...previouslyRecovered,
                ...initiallyAffected.filter((name) => !stillUnhealthy.has(name)),
            ].sort();
        };
        let latest = initial;
        for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
            let resumed = false;
            try {
                await this.client.resumeThread({
                    threadId: input.threadId,
                    mcpServers: input.mcpServers,
                    developerInstructions: input.developerInstructions,
                });
                resumed = true;
            } catch {
                // Retry below after the same bounded backoff as a status failure.
            }
            if (this.backoffMs > 0) {
                await this.sleep(this.backoffMs * (attempt + 1));
            }
            if (!resumed) continue;
            latest = await this.inspect(input);
            if (latest.status === 'ready') {
                this.cooldowns.delete(input.threadId);
                this.unhealthyServers.delete(input.threadId);
                return {
                    status: 'recovered',
                    affectedServers: recoveredSinceInitial([]),
                };
            }
            if (latest.failedServers.length === 0) {
                this.cooldowns.delete(input.threadId);
                this.unhealthyServers.set(input.threadId, latest.affectedServers);
                return this.toResult(latest, recoveredSinceInitial(latest.affectedServers));
            }
        }

        this.cooldowns.set(input.threadId, {
            failureSignature: JSON.stringify(latest.failedServers),
            until: this.now() + this.cooldownMs,
        });
        this.unhealthyServers.set(input.threadId, latest.affectedServers);
        return this.toResult(latest, recoveredSinceInitial(latest.affectedServers));
    }

    private toResult(
        inspection: RuntimeInspection,
        recoveredServers: string[] = [],
    ): CodexMcpRecoveryResult {
        const serverStatuses = [
            ...recoveredServers.map((name) => ({ name, status: 'recovered' as const })),
            ...inspection.failedServers.map((name) => ({ name, status: 'failed' as const })),
            ...inspection.needsAuthServers.map((name) => ({ name, status: 'needs-auth' as const })),
        ].sort((a, b) => a.name.localeCompare(b.name));
        if (serverStatuses.length === 0) {
            return { status: 'ready', affectedServers: [] };
        }

        const status = inspection.failedServers.length > 0
            ? 'failed' as const
            : inspection.needsAuthServers.length > 0
                ? 'needs-auth' as const
                : 'recovered' as const;
        const result: CodexMcpRecoveryResult = {
            status,
            affectedServers: serverStatuses.map((entry) => entry.name),
        };
        if (new Set(serverStatuses.map((entry) => entry.status)).size > 1) {
            result.serverStatuses = serverStatuses;
        }
        return result;
    }

    private async inspect(input: RecoveryInput): Promise<RuntimeInspection> {
        const expected = [...new Set(input.expectedServerNames)].sort();
        if (expected.length === 0) {
            return {
                status: 'ready',
                affectedServers: [],
                needsAuthServers: [],
                failedServers: [],
            };
        }

        const startupByName = new Map(
            this.client.getMcpStartupStatuses()
                .filter((entry) => !entry.threadId || entry.threadId === input.threadId)
                .map((entry) => [entry.name, entry]),
        );
        let inventoryByName: Map<string, CodexMcpServerInventory> | null = null;
        try {
            const inventory = await this.client.listMcpServerStatus({ threadId: input.threadId });
            inventoryByName = new Map(inventory.data.map((entry) => [entry.name, entry]));
        } catch {
            // Startup notifications remain useful on older app-server versions.
        }

        const needsAuth = expected.filter((name) => {
            const startup = startupByName.get(name);
            const inventory = inventoryByName?.get(name);
            if (inventory?.authStatus === 'notLoggedIn') return true;
            if (inventory && inventory.authStatus !== 'unknown') return false;
            return startup?.failureReason === 'reauthenticationRequired';
        });
        const needsAuthNames = new Set(needsAuth);

        const failed = expected.filter((name) => {
            if (needsAuthNames.has(name)) return false;
            const startup = startupByName.get(name);
            if (startup?.status === 'failed' || startup?.status === 'cancelled') return true;
            if (startup?.status === 'starting') return false;
            if (inventoryByName && !inventoryByName.has(name)) return true;
            return false;
        });
        const affectedServers = [...failed, ...needsAuth].sort();
        return {
            status: failed.length > 0 ? 'failed' : needsAuth.length > 0 ? 'needs-auth' : 'ready',
            affectedServers,
            needsAuthServers: needsAuth,
            failedServers: failed,
        };
    }
}
