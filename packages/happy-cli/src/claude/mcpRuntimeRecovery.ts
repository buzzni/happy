import type { McpReconnectResult, McpRuntimeServerStatus } from '@slopus/happy-wire';
import type { McpServerStatus, Query } from '@anthropic-ai/claude-agent-sdk';
import { readExpectedConnectors } from '@/aplus/fetchAplusMcpServers';

type McpQueryControl = Pick<Query, 'mcpServerStatus' | 'reconnectMcpServer'>;

type McpRuntimeRecoveryOptions = {
    maxAttempts?: number;
    backoffMs?: number;
    cooldownMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    onStatus?: (status: McpRuntimeServerStatus) => void;
    connectorNames?: string[];
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function sanitizeMcpError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message
        .replace(/(Authorization["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^"',;\s}]+/gi, '$1[REDACTED]')
        .replace(/\bBearer\s+[^"',;\s}]+/gi, 'Bearer [REDACTED]')
        .slice(0, 500);
}

export class McpRuntimeRecovery {
    private readonly maxAttempts: number;
    private readonly backoffMs: number;
    private readonly cooldownMs: number;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly onStatus?: (status: McpRuntimeServerStatus) => void;
    private readonly connectorNames: Set<string>;
    private readonly inFlight = new Map<string, Promise<McpReconnectResult>>();
    private readonly cooldownUntil = new Map<string, number>();

    constructor(
        private readonly query: McpQueryControl,
        options: McpRuntimeRecoveryOptions = {},
    ) {
        this.maxAttempts = options.maxAttempts ?? 2;
        this.backoffMs = options.backoffMs ?? 1_000;
        this.cooldownMs = options.cooldownMs ?? 30_000;
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? defaultSleep;
        this.onStatus = options.onStatus;
        this.connectorNames = new Set(options.connectorNames ?? readExpectedConnectors());
    }

    async recoverFailedServers(): Promise<void> {
        let statuses: McpServerStatus[];
        try {
            statuses = await this.query.mcpServerStatus();
        } catch {
            return;
        }

        const recoveries: Promise<McpReconnectResult>[] = [];
        for (const status of statuses) {
            this.emit(status);
            if (status.status === 'connected') {
                this.cooldownUntil.delete(status.name);
            } else if (status.status === 'failed') {
                recoveries.push(this.recoverServer(status.name));
            }
        }
        await Promise.all(recoveries);
    }

    async reconnectServer(serverName: string): Promise<McpReconnectResult> {
        let statuses: McpServerStatus[];
        try {
            statuses = await this.query.mcpServerStatus();
        } catch (error) {
            return { serverName, status: 'failed', error: sanitizeMcpError(error) };
        }
        const target = statuses.find((status) => status.name === serverName);
        if (!target) {
            return { serverName, status: 'not_available' };
        }
        if (target.status === 'needs-auth') {
            return { serverName, status: 'failed', error: 'Authentication required' };
        }
        return this.recoverServer(serverName, true);
    }

    private recoverServer(serverName: string, bypassCooldown = false): Promise<McpReconnectResult> {
        const existing = this.inFlight.get(serverName);
        if (existing) {
            return existing;
        }

        const recovery = this.runRecovery(serverName, bypassCooldown).finally(() => {
            if (this.inFlight.get(serverName) === recovery) {
                this.inFlight.delete(serverName);
            }
        });
        this.inFlight.set(serverName, recovery);
        return recovery;
    }

    private async runRecovery(serverName: string, bypassCooldown: boolean): Promise<McpReconnectResult> {
        const cooldownUntil = this.cooldownUntil.get(serverName);
        if (!bypassCooldown && cooldownUntil && this.now() < cooldownUntil) {
            return { serverName, status: 'failed', error: 'MCP reconnect cooldown is active' };
        }
        this.cooldownUntil.delete(serverName);

        let lastError: string | undefined;
        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
            if (attempt > 1 && this.backoffMs > 0) {
                await this.sleep(this.backoffMs);
            }
            this.emit({ name: serverName, status: 'pending' });

            try {
                await this.query.reconnectMcpServer(serverName);
            } catch (error) {
                lastError = sanitizeMcpError(error);
                continue;
            }

            try {
                const current = (await this.query.mcpServerStatus()).find((status) => status.name === serverName);
                if (current) {
                    this.emit(current);
                    if (current.status === 'connected' || current.status === 'needs-auth') {
                        this.cooldownUntil.delete(serverName);
                        return current.status === 'connected'
                            ? { serverName, status: 'success' }
                            : { serverName, status: 'failed', error: 'Authentication required' };
                    }
                    lastError = current.error ? sanitizeMcpError(current.error) : lastError;
                }
            } catch (error) {
                lastError = sanitizeMcpError(error);
            }
        }

        this.cooldownUntil.set(serverName, this.now() + this.cooldownMs);
        this.emit({ name: serverName, status: 'failed', error: lastError });
        return { serverName, status: 'failed', error: lastError };
    }

    private emit(status: Pick<McpServerStatus, 'name' | 'status' | 'error'>): void {
        let mappedStatus: McpRuntimeServerStatus['status'] = status.status === 'pending'
            ? 'reconnecting'
            : status.status === 'disabled'
                ? 'failed'
                : status.status;
        if (this.connectorNames.has(status.name)) {
            if (mappedStatus === 'failed') mappedStatus = 'connector-runtime-failed';
            if (mappedStatus === 'needs-auth') mappedStatus = 'connector-needs-auth';
        }
        this.onStatus?.({
            name: status.name,
            status: mappedStatus,
            error: status.error ? sanitizeMcpError(status.error) : undefined,
            checkedAt: this.now(),
        });
    }
}
