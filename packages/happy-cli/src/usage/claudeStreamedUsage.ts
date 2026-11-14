/**
 * Final usage of an assistant message on the SDK stream path.
 *
 * The SDK hands over an assistant message when a content block ends, before the response does: its
 * `usage` is still what `message_start` said, with the output at 0 or a placeholder. The usage the
 * response ended on comes afterwards on `message_delta`, which names no message — it belongs to
 * the `message_start` before it on the same stream (`parent_tool_use_id`). Reproduced against a
 * known final on 2026-11-14 (providerUsageFinal.integration.test.ts): the ledger kept output 0 for
 * a response that ended on 5, while Claude's own transcript had 5.
 *
 * So a message is reported once both halves are known, whichever comes first — the message travels
 * through the outgoing queue and can be overtaken by its own end. A message whose end never came
 * is reconciled with the owned provider transcript. Only execution end hands an unresolved
 * response over as estimated; a turn result can precede a background child final.
 */
import type { ClaudeUsageLike } from './claudeTurnUsage';

type Report = (usage: ClaudeUsageLike, final: boolean) => void;

const BUCKETS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const;
/** Ends kept for messages still on their way; one that never arrives must not stay forever. */
const MAX_ENDS = 512;

export class ClaudeStreamedUsage {
    /** The message each stream is in, by `parent_tool_use_id` ('' for the main one). */
    private readonly streaming = new Map<string, string>();
    private readonly ends = new Map<string, Partial<ClaudeUsageLike>>();
    private readonly reported = new Set<string>();
    private readonly held = new Map<string, { usage: ClaudeUsageLike; report: Report }>();

    noteStreamEvent(message: { parent_tool_use_id: string | null; event: unknown }): void {
        const stream = message.parent_tool_use_id ?? '';
        const event = message.event as { type?: unknown; message?: { id?: unknown }; usage?: unknown } | null;
        if (event?.type === 'message_start' && typeof event.message?.id === 'string') {
            this.streaming.set(stream, event.message.id);
            return;
        }
        if (event?.type === 'message_stop') {
            this.streaming.delete(stream);
            return;
        }
        const messageId = this.streaming.get(stream);
        if (event?.type !== 'message_delta' || !messageId || !event.usage || typeof event.usage !== 'object') return;

        const end: Partial<ClaudeUsageLike> = {};
        for (const bucket of BUCKETS) {
            const value = (event.usage as Record<string, unknown>)[bucket];
            if (typeof value === 'number') end[bucket] = value;
        }
        this.ends.delete(messageId);
        this.ends.set(messageId, end);
        if (this.ends.size > MAX_ENDS) this.ends.delete(this.ends.keys().next().value!);

        const held = this.held.get(messageId);
        if (!held) return;
        this.held.delete(messageId);
        this.reported.add(messageId);
        held.report({ ...held.usage, ...end }, true);
    }

    /** An assistant message of the stream path: `usage` is what its response started with. */
    noteAssistant(messageId: string, usage: ClaudeUsageLike, report: Report): void {
        if (this.reported.has(messageId)) return;
        const end = this.ends.get(messageId);
        if (end) {
            this.reported.add(messageId);
            report({ ...usage, ...end }, true);
        }
        else this.held.set(messageId, { usage, report });
    }

    /** Accept only IDs already observed here. Transcript history alone cannot open a request. */
    noteTranscriptFinal(messageId: string, usage: ClaudeUsageLike): void {
        if (this.reported.has(messageId)) return;
        const held = this.held.get(messageId);
        if (!held) return;
        this.held.delete(messageId);
        this.reported.add(messageId);
        held.report(usage, true);
    }

    pendingIds(): ReadonlySet<string> { return new Set(this.held.keys()); }

    /** A turn result is not the end of background children. Only execution end seals estimates. */
    drain(executionEnded = true): void {
        if (!executionEnded) return;
        const held = [...this.held.entries()];
        this.held.clear();
        for (const [id, { usage, report }] of held) {
            this.reported.add(id);
            report(usage, false);
        }
    }
}
