/**
 * Refreshes A+ MCP configuration at Codex turn boundaries.
 *
 * Codex app-server accepts MCP configuration when a thread starts or resumes.
 * Connector membership changes therefore resume the same idle thread before the
 * next turn. Authorization-only changes are applied periodically so short-lived
 * connector capability tokens stay valid without restarting every MCP server on
 * every message.
 */
import type {
    AplusMcpServersFetchResult,
    AplusMcpServersMap,
} from '@/aplus/fetchAplusMcpServers';
import type { McpServersMap } from '@/aplus/mergeAplusMcpServers';
import { sanitizeMcpError } from '@/claude/mcpRuntimeRecovery';
import { logger } from '@/ui/logger';

const DEFAULT_CREDENTIAL_REFRESH_MS = 12 * 60 * 60 * 1_000;

type ResumeThread = (opts: {
    threadId: string;
    mcpServers: McpServersMap;
}) => Promise<{ threadId: string; model: string }>;

type CodexMcpConfigSynchronizerOptions = {
    baseServers: McpServersMap;
    initialAplusServers: AplusMcpServersMap;
    fetchAplusServers: () => Promise<AplusMcpServersFetchResult>;
    bridgeAplusServers: (servers: AplusMcpServersMap) => McpServersMap;
    credentialRefreshMs?: number;
    now?: () => number;
};

export type CodexMcpSyncResult = {
    threadId: string | null;
    mcpServers: McpServersMap;
};

function topologyKey(servers: AplusMcpServersMap): string {
    return JSON.stringify(Object.entries(servers)
        .map(([name, server]) => [name, server.type, server.url])
        .sort(([left], [right]) => String(left).localeCompare(String(right))));
}

export class CodexMcpConfigSynchronizer {
    private currentAplusServers: AplusMcpServersMap;
    private currentMcpServers: McpServersMap;
    private lastAppliedAt: number;
    private readonly credentialRefreshMs: number;
    private readonly now: () => number;

    constructor(private readonly options: CodexMcpConfigSynchronizerOptions) {
        this.currentAplusServers = options.initialAplusServers;
        this.currentMcpServers = this.buildMcpServers(options.initialAplusServers);
        this.credentialRefreshMs = options.credentialRefreshMs ?? DEFAULT_CREDENTIAL_REFRESH_MS;
        this.now = options.now ?? Date.now;
        this.lastAppliedAt = this.now();
    }

    get mcpServers(): McpServersMap {
        return this.currentMcpServers;
    }

    async sync(input: {
        threadId?: string | null;
        resumeThread?: ResumeThread;
    }): Promise<CodexMcpSyncResult> {
        let result: AplusMcpServersFetchResult;
        try {
            result = await this.options.fetchAplusServers();
        } catch (error) {
            logger.debug(`[codex] MCP config refresh failed: ${sanitizeMcpError(error)}`);
            return { threadId: input.threadId ?? null, mcpServers: this.currentMcpServers };
        }
        if (!result.ok) {
            logger.debug(`[codex] MCP config refresh skipped: ${result.error}`);
            return { threadId: input.threadId ?? null, mcpServers: this.currentMcpServers };
        }

        const nextMcpServers = this.buildMcpServers(result.servers);
        if (!input.threadId || !input.resumeThread) {
            this.apply(result.servers, nextMcpServers);
            return { threadId: input.threadId ?? null, mcpServers: this.currentMcpServers };
        }

        const topologyChanged = topologyKey(this.currentAplusServers) !== topologyKey(result.servers);
        const credentialsStale = this.now() - this.lastAppliedAt >= this.credentialRefreshMs;
        if (!topologyChanged && !credentialsStale) {
            return { threadId: input.threadId, mcpServers: this.currentMcpServers };
        }

        try {
            const resumed = await input.resumeThread({
                threadId: input.threadId,
                mcpServers: nextMcpServers,
            });
            this.apply(result.servers, nextMcpServers);
            return { threadId: resumed.threadId, mcpServers: this.currentMcpServers };
        } catch (error) {
            logger.debug(`[codex] MCP config apply failed: ${sanitizeMcpError(error)}`);
            return { threadId: input.threadId, mcpServers: this.currentMcpServers };
        }
    }

    private buildMcpServers(aplusServers: AplusMcpServersMap): McpServersMap {
        return {
            ...this.options.baseServers,
            ...this.options.bridgeAplusServers(aplusServers),
        };
    }

    private apply(aplusServers: AplusMcpServersMap, mcpServers: McpServersMap): void {
        this.currentAplusServers = aplusServers;
        this.currentMcpServers = mcpServers;
        this.lastAppliedAt = this.now();
    }
}
