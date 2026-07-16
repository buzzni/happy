import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { McpRuntimeServerStatus } from '@slopus/happy-wire';
import type { AplusMcpServersFetchResult, AplusMcpServersMap } from '@/aplus/fetchAplusMcpServers';
import { deepEqual } from '@/utils/deterministicJson';
import { sanitizeMcpError } from './mcpRuntimeRecovery';

type McpConfigControl = Pick<Query, 'setMcpServers'>;

export type McpConfigSource = {
    baseServers: Record<string, any>;
    initialAplusServers: AplusMcpServersMap;
    fetchAplusServers: () => Promise<AplusMcpServersFetchResult>;
    onApplied?: (servers: Record<string, any>, aplusServers: AplusMcpServersMap) => void;
};

type McpConfigSynchronizerOptions = McpConfigSource & {
    now?: () => number;
    onStatus?: (status: McpRuntimeServerStatus) => void;
};

export class McpConfigSynchronizer {
    private currentAplusServers: AplusMcpServersMap;
    private readonly now: () => number;

    constructor(
        private readonly query: McpConfigControl,
        private readonly options: McpConfigSynchronizerOptions,
    ) {
        this.currentAplusServers = options.initialAplusServers;
        this.now = options.now ?? Date.now;
    }

    async sync(): Promise<void> {
        const result = await this.options.fetchAplusServers();
        if (!result.ok) {
            if (result.reason === 'not-configured' || result.reason === 'missing-machine-id') {
                return;
            }
            this.emitConfigFailure(result.error);
            return;
        }
        if (deepEqual(this.currentAplusServers, result.servers)) {
            return;
        }

        const servers = { ...this.options.baseServers, ...result.servers };
        try {
            const applied = await this.query.setMcpServers(servers);
            this.currentAplusServers = result.servers;
            this.options.onApplied?.(servers, result.servers);
            for (const [name, error] of Object.entries(applied.errors)) {
                this.options.onStatus?.({
                    name,
                    status: 'failed',
                    error: sanitizeMcpError(error),
                    checkedAt: this.now(),
                });
            }
        } catch (error) {
            this.emitConfigFailure(sanitizeMcpError(error));
        }
    }

    private emitConfigFailure(error: string): void {
        this.options.onStatus?.({
            name: 'aplus-config',
            status: 'config-fetch-failed',
            error: sanitizeMcpError(error),
            checkedAt: this.now(),
        });
    }
}
