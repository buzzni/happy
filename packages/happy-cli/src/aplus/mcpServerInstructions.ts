/**
 * Saycode MCP 서버가 initialize 응답의 `instructions` 로 보내는 안내(공통·조직 스킬 카탈로그)를 읽는다.
 *
 * Claude Code 는 MCP 서버의 instructions 를 시스템 프롬프트에 넣지만 Codex 는 넣지 않는다(0.170.0 실측).
 * 카탈로그는 이 경로로만 오므로, Codex 대화의 모델은 조직 스킬이 있는지조차 모른 채 일한다.
 * Codex 세션은 이 내용을 developer instructions 에 직접 싣는다. 도구 설명에 싣는 방법은 Codex 가
 * MCP 도구를 필요할 때만 꺼내 보여 주므로 처음부터 보이지 않는다(실측).
 *
 * 실패해도 세션을 막지 않는다: 그 서버만 빠지고 빈 문자열이 된다.
 */

import { logger } from '@/ui/logger';
import type { AplusMcpServersMap } from './fetchAplusMcpServers';

/** 스킬 카탈로그를 보내는 Saycode 소유 서버. 외부 커넥터의 안내는 읽지 않는다. */
const INSTRUCTION_SERVERS = ['aplus-common', 'aplus-company'] as const;

const TIMEOUT_MS = 3000;
/** 서버 하나의 상한. 카탈로그는 보통 수 KB 다. */
const MAX_SERVER_CHARS = 20_000;

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export function formatMcpServerInstructions(entries: Array<{ name: string; instructions: string }>): string {
    if (entries.length === 0) return '';
    const sections = entries.map(({ name, instructions }) => {
        const body = instructions.length > MAX_SERVER_CHARS
            ? `${instructions.slice(0, MAX_SERVER_CHARS)}\n[truncated]`
            : instructions;
        return `## ${name}\n${body}`;
    });
    return [
        '# MCP Server Instructions',
        '',
        'The following MCP servers have provided instructions for how to use their tools and resources:',
        '',
        sections.join('\n\n'),
    ].join('\n');
}

async function fetchInstructions(fetchImpl: FetchImpl, url: string, headers: Record<string, string>): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetchImpl(url, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-06-18',
                    capabilities: {},
                    clientInfo: { name: 'happy-codex-instructions', version: '1' },
                },
            }),
            signal: controller.signal,
        });
        if (!response.ok) return '';
        const payload = await response.json() as { result?: { instructions?: unknown } };
        const instructions = payload.result?.instructions;
        return typeof instructions === 'string' ? instructions.trim() : '';
    } finally {
        clearTimeout(timer);
    }
}

export function createMcpServerInstructionsReader(options: { fetchImpl?: FetchImpl } = {}) {
    const fetchImpl: FetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    // 서버 이름별 마지막 설정과 그 결과. 주소나 자격이 바뀔 때만 다시 묻는다(값은 메모리에만 둔다).
    const cache = new Map<string, { key: string; instructions: Promise<string> }>();

    return {
        async read(servers: AplusMcpServersMap): Promise<string> {
            const entries = await Promise.all(INSTRUCTION_SERVERS.map(async (name): Promise<{ name: string; instructions: string } | null> => {
                const server = servers[name];
                if (!server) return null;
                const headers = server.headers ?? {};
                const key = JSON.stringify([server.url, headers]);
                let cached = cache.get(name);
                if (cached?.key !== key) {
                    cached = {
                        key,
                        instructions: fetchInstructions(fetchImpl, server.url, headers).catch((error) => {
                            logger.debug(`[mcp-instructions] ${name} unavailable: ${error instanceof Error ? error.message : String(error)}`);
                            return '';
                        }),
                    };
                    cache.set(name, cached);
                }
                const instructions = await cached.instructions;
                return instructions ? { name, instructions } : null;
            }));
            return formatMcpServerInstructions(entries.filter((entry): entry is { name: string; instructions: string } => entry !== null));
        },
    };
}
