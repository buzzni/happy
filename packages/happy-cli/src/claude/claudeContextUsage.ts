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
 * The provider's first readable response names the API id its model resolved to; a later main
 * response under another id (fallbackModel on overload, same process, no new init) is paired by
 * its own id instead, and stays hidden unless the runtime reported a window for exactly that id.
 *
 * - Compaction (`system`/`compact_boundary`) clears occupancy only: same session, same runtime
 *   settings, so the cached windows are still right.
 * - A reset (`/clear`, another Claude session id) clears occupancy and every cached window and
 *   starts a new epoch: a new session may run under different settings.
 */
import { randomUUID } from 'node:crypto';

/** The wire contract. Keep in step with `__fixtures__/context-usage-snapshot.v1.json` and Desktop. */
export type ClaudeContextUsageSnapshot = {
    version: 1;
    type: 'context-usage';
    /** New per tracker (= per happy-cli process) and per reset; the consumer replaces on a new epoch. */
    epoch: string;
    /** Rises on every change within an epoch. A resend repeats the same seq. */
    seq: number;
    used: number | null;
    window: number | null;
    model: string | null;
};

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

export class ClaudeContextUsageTracker {
    private epoch: string;
    private seq = 0;
    private used: number | null = null;
    private model: string | null = null;
    /** `system`/`init.model` of the running provider. Describes the process, so a reset keeps it. */
    private providerModel: string | null = null;
    /** `message.model` of that provider's first readable main response. */
    private providerApiModel: string | null = null;
    /** Model names are runtime input: a Map keeps `__proto__` and friends as plain keys. */
    private readonly windows = new Map<string, number>();

    constructor(
        private readonly onChange: (snapshot: ClaudeContextUsageSnapshot) => void,
        private readonly newEpoch: () => string = randomUUID,
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
        if (this.providerModel && apiModel) this.providerApiModel ??= apiModel;
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

    noteCompactBoundary(): void {
        this.commit(() => { this.used = null; });
    }

    /** Nothing to show for now (local terminal mode), in the same conversation: windows stay cached. */
    hide(): void {
        this.commit(() => {
            this.used = null;
            this.model = null;
        });
    }

    reset(): void {
        this.windows.clear();
        // Nothing was ever shown in this epoch, so there is nothing to take back.
        if (!this.hasValue()) return;
        this.epoch = this.newEpoch();
        this.seq = 0;
        this.used = null;
        this.model = null;
        this.onChange(this.snapshot());
    }

    /**
     * Whether a consumer could be showing something from this epoch — what a resend repairs.
     * `used` is only ever set together with `model`, and a cached window with no main response
     * yet is not shown, so `model` alone decides.
     */
    hasValue(): boolean {
        return this.model !== null;
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
        };
    }

    private commit(apply: () => void): boolean {
        const before = this.snapshot();
        apply();
        const after = this.snapshot();
        if (before.used === after.used && before.window === after.window && before.model === after.model) return false;
        this.seq += 1;
        this.onChange(this.snapshot());
        return true;
    }
}
