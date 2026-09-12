/**
 * Claude 턴 단위 사용량 보정.
 *
 * Anthropic 직결 경로에서는 assistant 메시지마다 `usage` 에 실제 토큰이 실려 그대로 계량한다.
 * Z.AI 호환 엔드포인트(`ANTHROPIC_BASE_URL`) 경로에서는 assistant 메시지의 usage 가
 * `{input_tokens: 0, output_tokens: 0}` 으로 오고, 실제 토큰은 턴 종료 `result` 메시지의
 * `usage`/`modelUsage` 에만 있다(2026-09-05 prod 체험 머신 실측). 그대로 두면 체험 예산이
 * 실제 사용으로 줄지 않는다. 한 턴의 assistant usage 합이 0 일 때만 result usage 로 한 번
 * 보정 이벤트를 만든다 — 토큰이 이미 잡힌 턴은 이중 계산하지 않는다.
 */
export type ClaudeUsageLike = {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
};

export type ClaudeTurnUsageFallback = {
    usage: ClaudeUsageLike;
    model: string | null;
};

type ModelUsageMap = Record<string, { inputTokens?: number; outputTokens?: number } | undefined>;

function totalOf(usage: ClaudeUsageLike | undefined | null): number {
    if (!usage) return 0;
    return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
        + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

function busiestModel(modelUsage: ModelUsageMap | undefined | null): string | null {
    if (!modelUsage) return null;
    let best: { model: string; tokens: number } | null = null;
    for (const [model, entry] of Object.entries(modelUsage)) {
        const tokens = (entry?.inputTokens ?? 0) + (entry?.outputTokens ?? 0);
        if (!model.trim()) continue;
        if (!best || tokens > best.tokens) best = { model, tokens };
    }
    return best?.model ?? null;
}

export class ClaudeTurnUsageTracker {
    private turnTokens = 0;
    private lastAssistantModel: string | null = null;

    noteAssistant(input: { usage: ClaudeUsageLike; model?: string | null }): void {
        this.turnTokens += totalOf(input.usage);
        const model = input.model?.trim();
        if (model) this.lastAssistantModel = model;
    }

    /** 턴이 끝났다. 보정이 필요하면 result 기준 usage 를 돌려주고 상태를 비운다. */
    resolveResult(result: { usage?: ClaudeUsageLike | null; modelUsage?: ModelUsageMap | null }): ClaudeTurnUsageFallback | null {
        const assistantTokens = this.turnTokens;
        const model = busiestModel(result.modelUsage) ?? this.lastAssistantModel;
        this.turnTokens = 0;
        this.lastAssistantModel = null;
        if (assistantTokens > 0) return null;
        if (!result.usage || totalOf(result.usage) === 0) return null;
        return { usage: result.usage, model };
    }
}
