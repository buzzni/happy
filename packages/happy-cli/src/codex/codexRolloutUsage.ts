import { open } from 'node:fs/promises';
import { logger } from '@/ui/logger';

// Native usage records are small; oversized history items must not grow the reader without limit.
const MAX_ROW_BYTES = 1024 * 1024;

export type CodexResponseUsage = {
    threadId: string; turnId: string; responseId: string;
    usage: { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number;
        outputTokens: number; reasoningOutputTokens: number; totalTokens: number };
};

/** Request-scoped TokenUsageRecord is persisted even with raw events disabled (Codex 0.167.0).
 * https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/core/src/session/mod.rs
 * Live turn identity excludes copied fork history; response identity deduplicates both transports.
 */
export class CodexRolloutUsage {
    private turns = new Map<string, Set<string>>();
    private responses = new Set<string>();
    private files = new Map<string, { offset: number; pending: Buffer; length: number; skipping: boolean; queue: Promise<void> }>();
    constructor(private emit: (event: CodexResponseUsage) => void) {}
    allowTurn(thread: string, turn: string): void {
        const turns = this.turns.get(thread) ?? new Set<string>();
        turns.add(turn); this.turns.set(thread, turns);
    }
    hasResponse(responseId: string): boolean { return this.responses.has(responseId); }
    markResponse(responseId: string): boolean {
        if (this.responses.has(responseId)) return false;
        this.responses.add(responseId); return true;
    }
    read(thread: string, path: string): Promise<void> {
        let state = this.files.get(path);
        if (!state) {
            state = { offset: 0, pending: Buffer.allocUnsafe(MAX_ROW_BYTES), length: 0, skipping: false, queue: Promise.resolve() };
            this.files.set(path, state);
        }
        const file = state;
        const task = file.queue.then(async () => {
            const handle = await open(path, 'r');
            try {
                if ((await handle.stat()).size < file.offset) { file.offset = 0; file.length = 0; file.skipping = false; }
                const buffer = Buffer.alloc(64 * 1024);
                for (;;) {
                    const { bytesRead } = await handle.read(buffer, 0, buffer.length, file.offset);
                    if (!bytesRead) break;
                    let start = 0;
                    while (start < bytesRead) {
                        const newline = buffer.indexOf(10, start);
                        const end = newline !== -1 && newline < bytesRead ? newline : bytesRead;
                        const length = end - start;
                        file.offset += length;
                        if (!file.skipping) {
                            if (file.length + length > MAX_ROW_BYTES) {
                                file.skipping = true; file.length = 0;
                                logger.warn('[CodexRolloutUsage] Skipped oversized row; usage coverage unverified');
                            } else {
                                buffer.copy(file.pending, file.length, start, end);
                                file.length += length;
                            }
                        }
                        if (end < bytesRead) {
                            if (!file.skipping) {
                                const rowStart = file.offset - file.length;
                                try { this.consume(thread, file.pending.subarray(0, file.length).toString('utf8')); }
                                catch (error) {
                                    // A consumer has not accepted this row. Retry that row, without replaying bad history.
                                    file.offset = rowStart; file.length = 0;
                                    throw error;
                                }
                            }
                            file.length = 0; file.skipping = false;
                            file.offset++; // Commit the newline only after acceptance or an explicitly diagnosed skip.
                        }
                        start = end + 1;
                    }
                }
            } finally { await handle.close(); }
        });
        file.queue = task.catch(() => {}); // Caller reports errors; failed reads do not poison subsequent retries.
        return task;
    }
    private consume(thread: string, line: string): void {
        if (!line.trim()) return;
        let row: any;
        try { row = JSON.parse(line); } catch {
            logger.warn('[CodexRolloutUsage] Skipped malformed JSON row; usage coverage unverified');
            return;
        }
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            logger.warn('[CodexRolloutUsage] Skipped malformed row; usage coverage unverified');
            return;
        }
        if (row.type !== 'token_usage_record') return;
        const p = row.payload;
        if (p?.thread_id !== thread || !this.turns.get(thread)?.has(p?.turn_id)) return;
        const u = p.usage;
        const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
        if (typeof p.response_id !== 'string' || !p.response_id || !u
            || fields.some(key => !Number.isSafeInteger(u[key]) || u[key] < 0)
            || u.cached_input_tokens + u.cache_write_input_tokens > u.input_tokens
            || u.reasoning_output_tokens > u.output_tokens
            || u.total_tokens !== u.input_tokens + u.output_tokens) {
            logger.warn('[CodexRolloutUsage] Skipped invalid request usage; usage coverage unverified');
            return;
        }
        if (this.hasResponse(p.response_id)) return;
        this.emit({ threadId: thread, turnId: p.turn_id, responseId: p.response_id, usage: {
            inputTokens: u.input_tokens, cachedInputTokens: u.cached_input_tokens, cacheWriteInputTokens: u.cache_write_input_tokens,
            outputTokens: u.output_tokens, reasoningOutputTokens: u.reasoning_output_tokens, totalTokens: u.total_tokens,
        } });
        this.markResponse(p.response_id);
    }
}
