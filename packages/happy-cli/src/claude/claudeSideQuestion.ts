/**
 * `/btw` 곁질문 (Desktop specs/desktop-btw-side-question).
 *
 * 실행 중인 Claude SDK query 에 Claude Code 내장 `side_question` 제어 요청을 보낸다.
 * Claude 는 지금 대화의 cache-safe 포크로 한 번만 답하고(도구 거부, maxTurns 1),
 * transcript 에 쓰지 않는다 — 진행 중인 턴도 그대로 돈다. 2.1.285(SDK 번들)·2.1.291 실측.
 *
 * 응답에는 토큰이 없다. 대신 Claude 의 세션 누적(`get_usage` → session.model_usage)에
 * 곁질문 사용량이 들어가므로 요청 전후 차이로 잰다. 본 턴과 겹친 구간이면 그 사이
 * 관측된 본 턴 assistant 사용량을 빼고 'estimated' 로 표시한다 (이미 따로 계량됨).
 */
import type { ClaudeUsageLike } from '@/usage/claudeTurnUsage';

export const SIDE_QUESTION_MAX_CHARS = 8000;
export const SIDE_QUESTION_TIMEOUT_MS = 100_000;
/** 답을 받은 뒤의 사용량 읽기는 답 시간과 별개로 짧게 기다린다 — 답 직후 시간이 다 돼 계량이 빠지지 않게. */
const USAGE_READ_TIMEOUT_MS = 10_000;
/**
 * 본 대화가 이만큼 안에 움직였으면 Claude 의 턴 뒤 보조 호출(추천 질문 생성 등)이 같은 누적에
 * 섞였을 수 있어 'estimated' 로 표시한다.
 */
const RECENT_MAIN_ACTIVITY_MS = 15_000;

/** 실행 중인 query 에서 곁질문에 필요한 두 가지. */
export type ClaudeSideQuestionChannel = {
    request: (request: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown>;
    isTurnInProgress: () => boolean;
};

export type SideQuestionError = 'not-running' | 'busy' | 'timeout' | 'failed' | 'empty-question' | 'too-long';

export type SideQuestionOutcome =
    | {
        ok: true;
        answer: string;
        /** Claude 가 만든 안내문(도구를 부르려 했음·API 오류 등)이지 모델의 답이 아니다. */
        synthetic: boolean;
        usage: ClaudeUsageLike | null;
        usageQuality: 'exact' | 'estimated' | null;
        model: string | null;
    }
    | {
        ok: false;
        error: SideQuestionError;
        detail?: string;
        /** 실패·시간 초과여도 Claude 가 이미 쓴 사용량. 0 이면 싣지 않는다. */
        usage?: ClaudeUsageLike;
        usageQuality?: 'exact' | 'estimated';
        model?: string | null;
    };

type ModelUsageEntry = {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
};

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function readModelUsage(response: unknown): Record<string, ModelUsageEntry> | null {
    const session = (response as { session?: { model_usage?: unknown } } | null)?.session;
    const modelUsage = session?.model_usage;
    return modelUsage && typeof modelUsage === 'object' ? modelUsage as Record<string, ModelUsageEntry> : null;
}

/** 두 누적 사이의 증가분. 증가가 가장 큰 모델을 함께 돌려준다. */
export function modelUsageDelta(
    before: Record<string, ModelUsageEntry>,
    after: Record<string, ModelUsageEntry>,
): { usage: ClaudeUsageLike; model: string | null } {
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    let model: string | null = null;
    let busiest = 0;
    for (const [name, entry] of Object.entries(after)) {
        const prior = before[name] ?? {};
        const delta = {
            input_tokens: Math.max(0, num(entry?.inputTokens) - num(prior.inputTokens)),
            output_tokens: Math.max(0, num(entry?.outputTokens) - num(prior.outputTokens)),
            cache_creation_input_tokens: Math.max(0, num(entry?.cacheCreationInputTokens) - num(prior.cacheCreationInputTokens)),
            cache_read_input_tokens: Math.max(0, num(entry?.cacheReadInputTokens) - num(prior.cacheReadInputTokens)),
        };
        const total = delta.input_tokens + delta.output_tokens + delta.cache_creation_input_tokens + delta.cache_read_input_tokens;
        usage.input_tokens += delta.input_tokens;
        usage.output_tokens += delta.output_tokens;
        usage.cache_creation_input_tokens += delta.cache_creation_input_tokens;
        usage.cache_read_input_tokens += delta.cache_read_input_tokens;
        if (total > busiest && name.trim()) { busiest = total; model = name; }
    }
    return { usage, model };
}

function subtractUsage(from: ClaudeUsageLike, observed: Iterable<ClaudeUsageLike>): ClaudeUsageLike {
    const result = { ...from, cache_creation_input_tokens: from.cache_creation_input_tokens ?? 0, cache_read_input_tokens: from.cache_read_input_tokens ?? 0 };
    for (const usage of observed) {
        result.input_tokens = Math.max(0, result.input_tokens - num(usage.input_tokens));
        result.output_tokens = Math.max(0, result.output_tokens - num(usage.output_tokens));
        result.cache_creation_input_tokens = Math.max(0, result.cache_creation_input_tokens - num(usage.cache_creation_input_tokens));
        result.cache_read_input_tokens = Math.max(0, result.cache_read_input_tokens - num(usage.cache_read_input_tokens));
    }
    return result;
}

function usageTotal(usage: ClaudeUsageLike): number {
    return num(usage.input_tokens) + num(usage.output_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens);
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class ClaudeSideQuestionBridge {
    private channel: ClaudeSideQuestionChannel | null = null;
    private inFlight = false;
    /** 측정 구간 동안 본 턴 assistant 메시지별 마지막 usage (스트리밍 조각은 같은 id 로 온다). */
    private observedMain: Map<string, ClaudeUsageLike> | null = null;
    private lastMainActivityAt = Number.NEGATIVE_INFINITY;

    constructor(private readonly now: () => number = Date.now) {}

    provide(channel: ClaudeSideQuestionChannel): void {
        this.channel = channel;
    }

    clear(): void {
        this.channel = null;
    }

    /** 원격 런처의 onMessage 가 본 턴 메시지마다 부른다. 측정 중이 아니면 아무것도 하지 않는다. */
    noteMainMessage(message: unknown): void {
        this.lastMainActivityAt = this.now();
        if (!this.observedMain) return;
        const body = message as { type?: unknown; uuid?: unknown; message?: { id?: unknown; usage?: unknown } };
        if (body?.type !== 'assistant' || !body.message?.usage || typeof body.message.usage !== 'object') return;
        const key = typeof body.message.id === 'string' ? body.message.id : typeof body.uuid === 'string' ? body.uuid : null;
        if (key) this.observedMain.set(key, body.message.usage as ClaudeUsageLike);
    }

    async ask(rawQuestion: string, options: { timeoutMs?: number } = {}): Promise<SideQuestionOutcome> {
        const question = rawQuestion.trim();
        if (!question) return { ok: false, error: 'empty-question' };
        if (question.length > SIDE_QUESTION_MAX_CHARS) return { ok: false, error: 'too-long' };
        const channel = this.channel;
        if (!channel) return { ok: false, error: 'not-running' };
        if (this.inFlight) return { ok: false, error: 'busy' };
        this.inFlight = true;
        const signal = AbortSignal.timeout(options.timeoutMs ?? SIDE_QUESTION_TIMEOUT_MS);
        const observed = new Map<string, ClaudeUsageLike>();
        this.observedMain = observed;
        try {
            const before = await this.readUsage(channel, signal);
            let overlapped = channel.isTurnInProgress() || this.now() - this.lastMainActivityAt < RECENT_MAIN_ACTIVITY_MS;
            // 답의 성패와 사용량은 따로다 — 실패·시간 초과여도 Claude 가 이미 쓴 토큰은 잰다.
            const measure = async (forceEstimated = false) => {
                overlapped ||= channel.isTurnInProgress();
                const after = before ? await this.readUsage(channel, AbortSignal.timeout(USAGE_READ_TIMEOUT_MS)) : null;
                overlapped ||= observed.size > 0;
                if (!before || !after) return null;
                const delta = modelUsageDelta(before, after);
                return {
                    usage: overlapped ? subtractUsage(delta.usage, observed.values()) : delta.usage,
                    usageQuality: overlapped || forceEstimated ? 'estimated' as const : 'exact' as const,
                    model: delta.model,
                };
            };
            const failWith = async (error: SideQuestionError, detail: string | undefined, forceEstimated = false): Promise<SideQuestionOutcome> => {
                const spent = await measure(forceEstimated);
                return {
                    ok: false,
                    error,
                    ...(detail ? { detail } : {}),
                    ...(spent && usageTotal(spent.usage) > 0 ? spent : {}),
                };
            };
            let response: unknown;
            try {
                response = await channel.request({ subtype: 'side_question', question }, { signal });
            } catch (error) {
                // 시간 초과 뒤에도 포크가 더 쓸 수 있어 그때까지 본 값은 추정이다.
                return signal.aborted ? failWith('timeout', undefined, true) : failWith('failed', errorText(error));
            }
            const body = response as { response?: unknown; synthetic?: unknown } | null;
            const answer = typeof body?.response === 'string' ? body.response.trim() : '';
            if (!answer) return failWith('failed', 'empty side question answer');
            const spent = await measure();
            return {
                ok: true,
                answer,
                synthetic: body?.synthetic === true,
                usage: spent?.usage ?? null,
                usageQuality: spent?.usageQuality ?? null,
                model: spent?.model ?? null,
            };
        } finally {
            this.observedMain = null;
            this.inFlight = false;
        }
    }

    private async readUsage(channel: ClaudeSideQuestionChannel, signal: AbortSignal): Promise<Record<string, ModelUsageEntry> | null> {
        try {
            return readModelUsage(await channel.request({ subtype: 'get_usage', skip_behaviors: true }, { signal }));
        } catch {
            return null;
        }
    }
}

/**
 * SDK `Query` 의 제어 요청 함수. 타입상 private 이라 런타임에 확인한다 — SDK 가 형태를
 * 바꾸면 곁질문만 'not-running' 으로 꺼지고 본 대화는 영향이 없다. 공개 메서드
 * (`getContextUsage` 등)와 같이 control_response 의 `response` 본문만 돌려준다.
 */
export function sideQuestionRequestOf(query: unknown): ClaudeSideQuestionChannel['request'] | null {
    const request = (query as { request?: unknown } | null)?.request;
    if (typeof request !== 'function') return null;
    return async (body, options) => {
        const reply = await (request as (body: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown>).call(query, body, options);
        return (reply as { response?: unknown } | null)?.response;
    };
}

/** 세션 RPC `side-question` 의 응답. 실패는 `success:false` + `side-question:<코드>` (Desktop 이 코드로 안내). */
export type SideQuestionRpcReply =
    | {
        success: true;
        answer: string;
        synthetic: boolean;
        usage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } | null;
        usageQuality: 'exact' | 'estimated' | null;
        model: string | null;
    }
    | { success: false; error: string };

type DrainGate = { isClosed(): boolean; admit<T>(work: () => Promise<T>, kind?: 'input' | 'writer'): Promise<T> };

export function createSideQuestionRpcHandler(deps: {
    bridge: Pick<ClaudeSideQuestionBridge, 'ask'>;
    isManagedRun: () => boolean;
    gate: () => DrainGate | undefined;
    reportUsage: (input: { requestId: string; usage: ClaudeUsageLike; model: string | null; quality: 'exact' | 'estimated' }) => void;
    newRequestId: () => string;
    timeoutMs?: number;
}): (params: Record<string, unknown>) => Promise<SideQuestionRpcReply> {
    const fail = (code: SideQuestionError | 'managed-run' | 'shutting-down', detail?: string): SideQuestionRpcReply =>
        ({ success: false, error: `side-question:${code}${detail ? `: ${detail}` : ''}` });
    return async (params) => {
        // A managed run answers exactly the prompt its envelope admitted (same rule as `steer`).
        if (deps.isManagedRun()) return fail('managed-run');
        const question = typeof params?.question === 'string' ? params.question : '';
        const gate = deps.gate();
        if (gate?.isClosed()) return fail('shutting-down');
        const run = async (): Promise<SideQuestionRpcReply> => {
            const outcome = await deps.bridge.ask(question, { timeoutMs: deps.timeoutMs });
            const usage = outcome.usage;
            // 실패한 곁질문이 쓴 토큰도 집계에 넣는다 — 답을 못 받았다고 사용량을 숨기지 않는다.
            if (usage && outcome.usageQuality) {
                deps.reportUsage({ requestId: deps.newRequestId(), usage, model: outcome.model ?? null, quality: outcome.usageQuality });
            }
            if (!outcome.ok) return fail(outcome.error, outcome.detail);
            const cacheRead = usage?.cache_read_input_tokens ?? 0;
            const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
            return {
                success: true,
                answer: outcome.answer,
                synthetic: outcome.synthetic,
                usage: usage ? {
                    input: usage.input_tokens,
                    output: usage.output_tokens,
                    cacheRead,
                    cacheWrite,
                    total: usage.input_tokens + usage.output_tokens + cacheRead + cacheWrite,
                } : null,
                usageQuality: outcome.usageQuality,
                model: outcome.model,
            };
        };
        // Tracked so loop cleanup waits for it, but as a writer: it adds no input to the
        // conversation, so a pending side question must not hold off a standalone drain.
        return gate ? gate.admit(run, 'writer') : run();
    };
}
