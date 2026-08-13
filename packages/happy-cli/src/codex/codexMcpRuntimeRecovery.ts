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
};

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
    private readonly cooldownUntil = new Map<string, number>();

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
        if (initial.status === 'ready') {
            this.cooldownUntil.delete(input.threadId);
            return { status: 'ready', affectedServers: [] };
        }
        if (initial.status === 'needs-auth') {
            return initial;
        }
        if ((this.cooldownUntil.get(input.threadId) ?? 0) > this.now()) {
            return initial;
        }

        const initiallyAffected = initial.affectedServers;
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
                this.cooldownUntil.delete(input.threadId);
                return { status: 'recovered', affectedServers: initiallyAffected };
            }
            if (latest.status === 'needs-auth') {
                return latest;
            }
        }

        this.cooldownUntil.set(input.threadId, this.now() + this.cooldownMs);
        return latest;
    }

    private async inspect(input: RecoveryInput): Promise<RuntimeInspection> {
        const expected = [...new Set(input.expectedServerNames)].sort();
        if (expected.length === 0) return { status: 'ready', affectedServers: [] };

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
            return startup?.failureReason === 'reauthenticationRequired'
                || inventory?.authStatus === 'notLoggedIn';
        });
        if (needsAuth.length > 0) {
            return { status: 'needs-auth', affectedServers: needsAuth };
        }

        const failed = expected.filter((name) => {
            const startup = startupByName.get(name);
            if (startup?.status === 'failed' || startup?.status === 'cancelled') return true;
            if (startup?.status === 'starting') return false;
            if (inventoryByName && !inventoryByName.has(name)) return true;
            return false;
        });
        return failed.length > 0
            ? { status: 'failed', affectedServers: failed }
            : { status: 'ready', affectedServers: [] };
    }
}
