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
import type { McpRuntimeServerStatus } from '@slopus/happy-wire';

const DEFAULT_CREDENTIAL_REFRESH_MS = 12 * 60 * 60 * 1_000;

type ResumeThread = (opts: {
    threadId: string;
    mcpServers: McpServersMap;
}) => Promise<{ threadId: string; model: string }>;

type CodexMcpConfigSynchronizerOptions = {
    baseServers: McpServersMap;
    initialAplusServers: AplusMcpServersMap;
    /** 대화를 열 때 있던 조직 등록 MCP. 이 세션 동안 제거하지 않는다 — Claude 경로와 같은 계약. */
    floorServerNames?: string[];
    fetchAplusServers: () => Promise<AplusMcpServersFetchResult>;
    bridgeAplusServers: (servers: AplusMcpServersMap) => McpServersMap;
    credentialRefreshMs?: number;
    now?: () => number;
    onStatus?: (status: McpRuntimeServerStatus) => void;
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
    private readonly floorServers: AplusMcpServersMap;
    private currentMcpServers: McpServersMap;
    private lastAppliedAt: number;
    private readonly credentialRefreshMs: number;
    private readonly now: () => number;

    constructor(private readonly options: CodexMcpConfigSynchronizerOptions) {
        this.currentAplusServers = options.initialAplusServers;
        this.floorServers = Object.fromEntries(
            (options.floorServerNames ?? [])
                .filter((name) => options.initialAplusServers[name])
                .map((name) => [name, options.initialAplusServers[name]]),
        );
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
            if (result.reason === 'connector-config-missing') {
                for (const provider of result.missing) {
                    this.options.onStatus?.({
                        name: provider,
                        status: 'connector-config-missing',
                        error: sanitizeMcpError(result.error),
                        checkedAt: this.now(),
                    });
                }
            } else if (result.reason === 'mcp-config-missing') {
                for (const { name, reason } of result.missing) {
                    this.options.onStatus?.({
                        name,
                        status: reason === 'connector-config-missing'
                            ? 'connector-config-missing'
                            : 'mcp-config-missing',
                        error: sanitizeMcpError(result.error),
                        checkedAt: this.now(),
                    });
                }
            } else if (result.reason !== 'not-configured' && result.reason !== 'missing-machine-id') {
                this.options.onStatus?.({
                    name: 'aplus-config',
                    status: 'config-fetch-failed',
                    error: sanitizeMcpError(result.error),
                    checkedAt: this.now(),
                });
            }
            return { threadId: input.threadId ?? null, mcpServers: this.currentMcpServers };
        }

        const aplusServers = this.withFloor(result.servers);
        const nextMcpServers = this.buildMcpServers(aplusServers);
        if (!input.threadId || !input.resumeThread) {
            this.apply(aplusServers, nextMcpServers);
            return { threadId: input.threadId ?? null, mcpServers: this.currentMcpServers };
        }

        const topologyChanged = topologyKey(this.currentAplusServers) !== topologyKey(aplusServers);
        const credentialsStale = this.now() - this.lastAppliedAt >= this.credentialRefreshMs;
        if (!topologyChanged && !credentialsStale) {
            return { threadId: input.threadId, mcpServers: this.currentMcpServers };
        }

        try {
            const resumed = await input.resumeThread({
                threadId: input.threadId,
                mcpServers: nextMcpServers,
            });
            this.apply(aplusServers, nextMcpServers);
            return { threadId: resumed.threadId, mcpServers: this.currentMcpServers };
        } catch (error) {
            logger.debug(`[codex] MCP config apply failed: ${sanitizeMcpError(error)}`);
            return { threadId: input.threadId, mcpServers: this.currentMcpServers };
        }
    }

    /** 바닥선은 조기 반환이 아니라 합집합으로 지킨다 — 다른 서버의 갱신은 계속 흘러야 한다. */
    private withFloor(servers: AplusMcpServersMap): AplusMcpServersMap {
        const out = { ...servers };
        for (const [name, entry] of Object.entries(this.floorServers)) {
            if (!out[name]) out[name] = entry;
        }
        return out;
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
