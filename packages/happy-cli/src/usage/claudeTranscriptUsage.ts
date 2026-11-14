import { open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { ClaudeUsageLike } from './claudeTurnUsage';
import { logger } from '@/ui/logger';

const CHUNK_BYTES = 256 * 1024;
const MAX_ROW_BYTES = 8 * 1024 * 1024;
const MAX_CACHED_FINALS = 512;

/** Incremental reads of one owned provider session. Cached history never authorizes a charge. */
export class ClaudeTranscriptUsageReader {
    private readonly offsets = new Map<string, number>();
    private readonly oversized = new Set<string>();
    private active: ReadonlySet<string> = new Set();
    private readonly finals = new Map<string, ClaudeUsageLike>();
    constructor(private readonly projectDir: string, private readonly sessionId: string) {}

    async read(observed: ReadonlySet<string>): Promise<Map<string, ClaudeUsageLike>> {
        if (!/^[a-zA-Z0-9_-]+$/.test(this.sessionId) || observed.size === 0) return new Map();
        this.active = observed;
        await this.readFile(join(this.projectDir, `${this.sessionId}.jsonl`));
        const children = join(this.projectDir, this.sessionId, 'subagents');
        try {
            const directory = await opendir(children);
            let count = 0;
            for await (const entry of directory) {
                if (entry.isFile() && /^agent-[a-zA-Z0-9_-]+\.jsonl$/.test(entry.name)) await this.readFile(join(children, entry.name));
                if (++count % 64 === 0) await setImmediate();
            }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        return new Map([...this.finals].filter(([id]) => observed.has(id)));
    }

    private async readFile(file: string): Promise<void> {
        let handle;
        try { handle = await open(file, 'r'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        try {
            const size = (await handle.stat()).size;
            let offset = this.offsets.get(file) ?? 0;
            if (size < offset) throw new Error('Claude usage transcript was truncated');
            let position = offset;
            let pending = Buffer.alloc(0);
            const chunk = Buffer.alloc(CHUNK_BYTES);
            while (position < size) {
                const { bytesRead } = await handle.read(chunk, 0, Math.min(CHUNK_BYTES, size - position), position);
                if (bytesRead === 0) break;
                position += bytesRead;
                pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
                let newline: number;
                while ((newline = pending.indexOf(10)) >= 0) {
                    if (this.oversized.has(file)) this.oversized.delete(file);
                    else if (newline > MAX_ROW_BYTES) logger.warn('[usage] Oversized Claude transcript row skipped; its usage is unverified');
                    else {
                        const line = pending.subarray(0, newline).toString('utf8');
                        if (line.trim()) this.noteRow(line);
                    }
                    offset += newline + 1;
                    this.offsets.set(file, offset);
                    pending = pending.subarray(newline + 1);
                }
                if (pending.length > MAX_ROW_BYTES || this.oversized.has(file)) {
                    if (!this.oversized.has(file)) logger.warn('[usage] Oversized Claude transcript row skipped; its usage is unverified');
                    this.oversized.add(file);
                    offset += pending.length;
                    this.offsets.set(file, offset);
                    pending = Buffer.alloc(0);
                }
                // Yield between fixed-size chunks, including cached local disk reads.
                await setImmediate();
            }
            // Do not commit the offset of an unterminated row: the provider may append its rest.
        } finally { await handle.close(); }
    }

    private noteRow(line: string): void {
        let row;
        try { row = JSON.parse(line); } catch {
            logger.warn('[usage] Malformed Claude transcript row skipped; its usage is unverified');
            return;
        }
        const message = row?.message;
        if (row?.type !== 'assistant' || typeof message?.id !== 'string') return;
        const usage = message.usage;
        if (!usage || !['input_tokens', 'output_tokens'].every(key => Number.isFinite(usage[key]) && usage[key] >= 0)) return;
        // Completed assistant transcript rows contain final request usage, even when the SDK omits
        // child message_delta. Keep the last row, never max(tokens), and omit content from the cache.
        const counters: ClaudeUsageLike = { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
        for (const key of ['cache_creation_input_tokens', 'cache_read_input_tokens'] as const) {
            if (typeof usage[key] === 'number') counters[key] = usage[key];
        }
        this.finals.delete(message.id);
        this.finals.set(message.id, counters);
        if (this.finals.size > MAX_CACHED_FINALS) {
            // Pending native IDs cannot be evicted by unrelated history encountered later in a scan.
            const oldest = [...this.finals.keys()].find(id => !this.active.has(id));
            if (oldest) this.finals.delete(oldest);
        }
    }
}

export async function readClaudeTranscriptUsage(projectDir: string, sessionId: string, observed: ReadonlySet<string>): Promise<Map<string, ClaudeUsageLike>> {
    return new ClaudeTranscriptUsageReader(projectDir, sessionId).read(observed);
}
