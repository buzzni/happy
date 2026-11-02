/**
 * How much of the model's context window the main conversation occupies right now.
 *
 * Saycode Desktop specs/desktop-chat-context-window-meter (plan.md "happy-cli 변경"). The
 * session process is the only place that sees both halves: the request size of the latest main
 * assistant response, and the window size the runtime reports per model on a turn result
 * (`result.modelUsage[model].contextWindow`). Each change becomes one snapshot of the whole state,
 * so a later frame always repairs an earlier one that was lost on the volatile relay.
 *
 * Nothing here is estimated. A window the runtime has not reported for that model stays `null`,
 * and the consumer hides the meter rather than guessing (the same model has different windows
 * under different runtime settings, e.g. the 1M beta).
 *
 * Which `modelUsage` entry is the main agent's: the one keyed by the provider's own model name,
 * `system`/`init.model`. The assistant message's `message.model` is the API's id and need not
 * match — measured 2026-10-19 (SDK 0.3.285): `model: 'claude-haiku-4-5'` gave
 * `init.model` and the key `claude-haiku-4-5` but `message.model` `claude-haiku-4-5-20251001`,
 * and a subagent's request added its own `claude-haiku-4-5-20251001` entry beside it.
 * The provider's first readable response whose API id is that model's own name, or the name plus a
 * date suffix, is what pairs the two. A response under any other id (fallbackModel on overload —
 * possibly the very first one, after a provider restart) is paired by its own id instead, and stays
 * hidden unless the runtime reported a window for exactly that id: a window borrowed from the init
 * model would show 18% for a fallback that is at 90%.
 *
 * - Compaction (`system`/`compact_boundary`) clears occupancy only: same session, same runtime
 *   settings, so the cached windows are still right.
 * - A reset (`/clear`, another Claude session id) clears occupancy and every cached window and
 *   starts a new epoch: a new session may run under different settings.
 *
 * The optional `breakdown` (Desktop specs/context-meter-compact) is what the runtime itself says
 * fills the window: the `categories` of `Query.getContextUsage({ detail: 'summary' })`, asked once
 * per remote turn result. It is additive within v1 — a consumer that knows only v1 ignores it — and
 * is absent until an answer arrives. It carries its own totals because it is measured at the turn
 * result, while `used` follows every later main response. Compaction, hide and reset clear it, and
 * an answer to a request they overtook is dropped.
 */
import { randomBytes } from 'node:crypto';

/** The wire contract. Keep in step with `__fixtures__/context-usage-snapshot.v1.json` and Desktop. */
export type ClaudeContextUsageSnapshot = {
    version: 1;
    type: 'context-usage';
    /**
     * `<13-digit zero-padded ms>-<random id>`, new per tracker and per reset. The time part only
     * orders epochs (it rises within a process; a restarted process starts later): the consumer
     * drops a frame from an earlier epoch and replaces on a later one. Never shown.
     */
    epoch: string;
    /** Rises on every change within an epoch. A resend repeats the same seq. */
    seq: number;
    used: number | null;
    window: number | null;
    model: string | null;
    /** Absent until the runtime answers a breakdown request; see the header. Fixture: `__fixtures__/context-usage-breakdown.v1.json`. */
    breakdown?: ClaudeContextBreakdown;
};

/** One `getContextUsage().categories` row, as the runtime classified it. Rows may carry zero tokens. */
export type ClaudeContextBreakdownCategory = {
    /**
     * The runtime's stable row id (`system_prompt`, `system_tools`, `mcp_tools`, `memory_files`,
     * `skills`, `messages`, `free_space`, …), or null from a CLI that predates ids. Match rows on
     * this, never on `name`; a later CLI may add ids.
     */
    id: string | null;
    /** The runtime's English display name. */
    name: string;
    tokens: number;
    /** 'used' occupies the window, 'free' is what is left, 'buffer' the compaction reserve, 'deferred' tool schemas outside the window. */
    kind: 'used' | 'free' | 'buffer' | 'deferred';
};

export type ClaudeContextBreakdown = {
    /** `summary`: the runtime's local estimate per category, without token-count API calls. */
    detail: 'summary';
    /** The main-loop model the runtime measured for. */
    model: string;
    /** The runtime's estimate of the whole context; may exceed `rawMaxTokens` when over the limit. */
    totalTokens: number;
    /** The window the runtime measures against: its autocompact window, which can be smaller than `window`. */
    rawMaxTokens: number;
    categories: ClaudeContextBreakdownCategory[];
};

/** The SDK `Query` control request (`sideQuestionRequestOf`): resolves to the control_response body. */
export type ClaudeControlRequest = (body: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown>;

const BREAKDOWN_KINDS: ReadonlySet<unknown> = new Set(['used', 'free', 'buffer', 'deferred']);
const BREAKDOWN_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_BREAKDOWN_CATEGORIES = 32;
const MAX_BREAKDOWN_TEXT_LENGTH = 128;

function readSafeCount(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readBreakdownCategory(value: unknown): ClaudeContextBreakdownCategory | null {
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    const name = typeof row.name === 'string' ? row.name.trim().slice(0, MAX_BREAKDOWN_TEXT_LENGTH) : '';
    const tokens = readSafeCount(row.tokens);
    if (!name || tokens === null || !BREAKDOWN_KINDS.has(row.kind)) return null;
    const id = typeof row.id === 'string' && BREAKDOWN_ID_PATTERN.test(row.id) ? row.id : null;
    return { id, name, tokens, kind: row.kind as ClaudeContextBreakdownCategory['kind'] };
}

/** The breakdown in a `get_context_usage` answer, or null when it cannot be read as one. */
function readBreakdown(response: unknown): ClaudeContextBreakdown | null {
    if (!response || typeof response !== 'object') return null;
    const answer = response as Record<string, unknown>;
    const model = typeof answer.model === 'string' ? answer.model.trim().slice(0, MAX_BREAKDOWN_TEXT_LENGTH) : '';
    const totalTokens = readSafeCount(answer.totalTokens);
    const rawMaxTokens = readSafeCount(answer.rawMaxTokens);
    if (!model || totalTokens === null || !rawMaxTokens || !Array.isArray(answer.categories)) return null;
    const categories = answer.categories
        .map(readBreakdownCategory)
        .filter((row): row is ClaudeContextBreakdownCategory => row !== null)
        .slice(0, MAX_BREAKDOWN_CATEGORIES);
    if (categories.length === 0) return null;
    return { detail: 'summary', model, totalTokens, rawMaxTokens, categories };
}

function sameBreakdown(a: ClaudeContextBreakdown | null, b: ClaudeContextBreakdown | null): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function copyBreakdown(breakdown: ClaudeContextBreakdown): ClaudeContextBreakdown {
    return { ...breakdown, categories: breakdown.categories.map((row) => ({ ...row })) };
}

function readTokenCount(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** input + cache_read + cache_creation of one request, or null when it cannot be read as a real size. */
function readRequestSize(usage: unknown): number | null {
    if (!usage || typeof usage !== 'object') return null;
    const record = usage as Record<string, unknown>;
    const input = readTokenCount(record.input_tokens);
    if (input === null) return null;
    let total = input;
    for (const key of ['cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
        if (record[key] === undefined || record[key] === null) continue;
        const count = readTokenCount(record[key]);
        if (count === null) return null;
        total += count;
    }
    // Zero is what the Z.AI-compatible path reports for every assistant message; it is not a size.
    return total > 0 ? total : null;
}

/**
 * Epoch ids that rise strictly within one process (`max(now, previous + 1)`), so a reset in the
 * same millisecond, or a clock stepped back, still produces a later epoch.
 */
export function createContextUsageEpochSource(
    now: () => number = Date.now,
    randomId: () => string = () => randomBytes(4).toString('hex'),
): () => string {
    let previous = -1;
    return () => {
        previous = Math.max(Math.floor(now()), previous + 1);
        return `${String(previous).padStart(13, '0')}-${randomId()}`;
    };
}

/** One source for the process: every session client's epochs rise together. */
const processEpochSource = createContextUsageEpochSource();

/**
 * Whether a response's API id is the provider model itself: the same name, or the name (without a
 * runtime suffix such as `[1m]`) plus the API's date — `claude-haiku-4-5` → `claude-haiku-4-5-20251001`.
 */
function isProviderModelApiId(providerModel: string, apiModel: string): boolean {
    const base = providerModel.replace(/\[[^\]]*\]$/, '');
    if (apiModel === providerModel || apiModel === base) return true;
    return apiModel.startsWith(`${base}-`) && /^\d{8}$/.test(apiModel.slice(base.length + 1));
}

/**
 * The transcript signals the tracker needs, as an `OutgoingMessageQueue` item: the queue drops
 * every `system` log message, and these must still land after the responses queued before them.
 * A turn result's breakdown request rides it too: a `compact_boundary` still waiting in the queue
 * would otherwise clear the answer to a request made after it.
 */
export type ClaudeContextUsageSignal =
    | { kind: 'provider-model'; model: unknown }
    | { kind: 'compact-boundary' }
    | { kind: 'breakdown-request'; request: ClaudeControlRequest };

export interface ClaudeContextUsageSignalItem {
    __claudeContextUsageSignal: true;
    signal: ClaudeContextUsageSignal;
}

/** The queue item for an SDK `system`/`init` or `compact_boundary` message, or null for anything else. */
export function contextUsageSignalItem(message: unknown): ClaudeContextUsageSignalItem | null {
    const system = message as { type?: unknown; subtype?: unknown; model?: unknown } | null;
    if (!system || system.type !== 'system') return null;
    if (system.subtype === 'init') return { __claudeContextUsageSignal: true, signal: { kind: 'provider-model', model: system.model } };
    if (system.subtype === 'compact_boundary') return { __claudeContextUsageSignal: true, signal: { kind: 'compact-boundary' } };
    return null;
}

/** The queue item that asks for a breakdown once everything queued before it has been applied. */
export function contextUsageBreakdownRequestItem(request: ClaudeControlRequest): ClaudeContextUsageSignalItem {
    return { __claudeContextUsageSignal: true, signal: { kind: 'breakdown-request', request } };
}

/** Wraps the queue's send function so the signal items reach `apply` in their queued position. */
export function withContextUsageSignals(
    send: (message: unknown) => void,
    apply: (signal: ClaudeContextUsageSignal) => void,
): (message: unknown) => void {
    return (message) => {
        const item = message as Partial<ClaudeContextUsageSignalItem> | null;
        if (item && item.__claudeContextUsageSignal === true && item.signal) {
            apply(item.signal);
            return;
        }
        send(message);
    };
}

export class ClaudeContextUsageTracker {
    private epoch: string;
    private seq = 0;
    private used: number | null = null;
    private model: string | null = null;
    /** `system`/`init.model` of the running provider. Describes the process, so a reset keeps it. */
    private providerModel: string | null = null;
    /** `message.model` of that provider's first readable main response under the provider model's own id. */
    private providerApiModel: string | null = null;
    /** Model names are runtime input: a Map keeps `__proto__` and friends as plain keys. */
    private readonly windows = new Map<string, number>();
    private breakdown: ClaudeContextBreakdown | null = null;
    /** Only the answer to the latest request counts; compaction, hide and reset also move it on. */
    private breakdownTicket = 0;

    constructor(
        private readonly onChange: (snapshot: ClaudeContextUsageSnapshot) => void,
        private readonly newEpoch: () => string = processEpochSource,
    ) {
        this.epoch = newEpoch();
    }

    /** A provider process started (`system`/`init`). Its model names the main agent's `modelUsage` entry. */
    noteProviderModel(model: unknown): void {
        const name = typeof model === 'string' ? model.trim() : '';
        this.providerModel = name || null;
        this.providerApiModel = null;
    }

    /**
     * A main-agent assistant response. Sidechain, `/btw` and result fallback usage never come here.
     * `model` is the message's own API id; see the header for when it is used instead of the provider's.
     */
    noteMainAssistant(input: { model: unknown; usage: unknown }): void {
        const used = readRequestSize(input.usage);
        if (used === null) return;
        const apiModel = typeof input.model === 'string' ? input.model.trim() : '';
        if (this.providerModel && apiModel && this.providerApiModel === null
            && isProviderModelApiId(this.providerModel, apiModel)) this.providerApiModel = apiModel;
        const model = this.providerModel && (!apiModel || apiModel === this.providerApiModel)
            ? this.providerModel
            : apiModel;
        if (!model) return;
        this.commit(() => {
            this.used = used;
            this.model = model;
        });
    }

    /** Caches every reported window. Returns whether the shown snapshot changed (and was emitted). */
    noteTurnResult(modelUsage: unknown): boolean {
        if (!modelUsage || typeof modelUsage !== 'object') return false;
        return this.commit(() => {
            for (const [model, entry] of Object.entries(modelUsage as Record<string, unknown>)) {
                const window = entry && typeof entry === 'object'
                    ? (entry as { contextWindow?: unknown }).contextWindow
                    : undefined;
                if (!model.trim() || typeof window !== 'number' || !Number.isFinite(window) || window <= 0) continue;
                this.windows.set(model.trim(), window);
            }
        });
    }

    /** Opens a breakdown request: pass the ticket back with its answer. */
    beginBreakdown(): number {
        this.breakdownTicket += 1;
        return this.breakdownTicket;
    }

    /** The answer to `beginBreakdown`. Returns whether the shown snapshot changed (and was emitted). */
    noteBreakdown(ticket: number, response: unknown): boolean {
        if (ticket !== this.breakdownTicket) return false;
        const breakdown = readBreakdown(response);
        if (!breakdown) return false;
        return this.commit(() => { this.breakdown = breakdown; });
    }

    noteCompactBoundary(): void {
        this.breakdownTicket += 1;
        this.commit(() => {
            this.used = null;
            this.breakdown = null;
        });
    }

    /** Nothing to show for now (local terminal mode), in the same conversation: windows stay cached. */
    hide(): void {
        this.breakdownTicket += 1;
        this.commit(() => {
            this.used = null;
            this.model = null;
            this.breakdown = null;
        });
    }

    reset(): void {
        this.windows.clear();
        this.breakdownTicket += 1;
        // Nothing was ever shown in this epoch, so there is nothing to take back.
        if (!this.hasValue()) return;
        this.epoch = this.newEpoch();
        this.seq = 0;
        this.used = null;
        this.model = null;
        this.breakdown = null;
        this.onChange(this.snapshot());
    }

    /**
     * Whether a consumer could be showing something from this epoch — what a resend repairs.
     * `used` is only ever set together with `model`, and a cached window with no main response
     * yet is not shown, so `model` decides — or a breakdown that arrived before any readable
     * main response (the Z.AI zeros).
     */
    hasValue(): boolean {
        return this.model !== null || this.breakdown !== null;
    }

    snapshot(): ClaudeContextUsageSnapshot {
        return {
            version: 1,
            type: 'context-usage',
            epoch: this.epoch,
            seq: this.seq,
            used: this.used,
            window: this.model === null ? null : this.windows.get(this.model) ?? null,
            model: this.model,
            ...(this.breakdown ? { breakdown: copyBreakdown(this.breakdown) } : {}),
        };
    }

    private commit(apply: () => void): boolean {
        const before = this.snapshot();
        const breakdownBefore = this.breakdown;
        apply();
        const after = this.snapshot();
        if (before.used === after.used && before.window === after.window && before.model === after.model
            && sameBreakdown(breakdownBefore, this.breakdown)) return false;
        this.seq += 1;
        this.onChange(this.snapshot());
        return true;
    }
}
