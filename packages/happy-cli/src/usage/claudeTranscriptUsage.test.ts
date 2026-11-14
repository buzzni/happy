import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { readClaudeTranscriptUsage, ClaudeTranscriptUsageReader } from './claudeTranscriptUsage';

describe('owned Claude transcript final usage', () => {
    it('reads only observed native IDs, including a no-stream child, and uses the last complete row rather than the maximum', async () => {
        const root = mkdtempSync(join(tmpdir(), 'claude-usage-'));
        try {
            mkdirSync(join(root, 'owned', 'subagents'), { recursive: true });
            const row = (id: string, output: number) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 2, output_tokens: output } } });
            writeFileSync(join(root, 'owned.jsonl'), row('historical', 99) + '\n');
            writeFileSync(join(root, 'owned', 'subagents', 'agent-one.jsonl'), [row('child', 20), row('child', 7), row('foreign', 90), '{'].join('\n'));
            writeFileSync(join(root, 'unrelated.jsonl'), row('child', 500));
            expect([...await readClaudeTranscriptUsage(root, 'owned', new Set(['child']))]).toEqual([['child', { input_tokens: 2, output_tokens: 7 }]]);
            expect([...await readClaudeTranscriptUsage(root, '../owned', new Set(['child']))]).toEqual([]);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
    it('continues from committed offsets and waits for partial UTF-8 rows across asynchronous turns', async () => {
        const root = mkdtempSync(join(tmpdir(), 'claude-incremental-'));
        try {
            const file = join(root, 'owned.jsonl');
            const first = JSON.stringify({ type: 'assistant', message: { id: 'first', usage: { input_tokens: 2, output_tokens: 3 } } }) + '\n';
            writeFileSync(file, first);
            const reader = new ClaudeTranscriptUsageReader(root, 'owned');
            expect((await reader.read(new Set(['first']))).get('first')?.output_tokens).toBe(3);
            // Already consumed bytes need not be loaded/parsed again. Preserve byte positions.
            writeFileSync(file, '!'.repeat(Buffer.byteLength(first) - 1) + '\n');
            const child = Buffer.from(JSON.stringify({ type: 'assistant', content: '한글', message: { id: 'child', usage: { input_tokens: 4, output_tokens: 9 } } }) + '\n');
            const split = child.indexOf(Buffer.from('한')) + 1;
            appendFileSync(file, child.subarray(0, split));
            expect((await reader.read(new Set(['child']))).size).toBe(0);
            appendFileSync(file, child.subarray(split));
            expect((await reader.read(new Set(['child']))).get('child')).toEqual({ input_tokens: 4, output_tokens: 9 });
            expect((await reader.read(new Set(['history']))).size).toBe(0);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
    it('diagnoses corrupt history and oversized rows without hiding later parent or child usage', async () => {
        const root = mkdtempSync(join(tmpdir(), 'claude-bounded-'));
        const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        try {
            const row = (id: string) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 2, output_tokens: 7 } } }) + '\n';
            mkdirSync(join(root, 'owned', 'subagents'), { recursive: true });
            writeFileSync(join(root, 'owned', 'subagents', 'agent-one.jsonl'), row('child'));
            const file = join(root, 'owned.jsonl');
            writeFileSync(file, '{private broken history}\n' + row('parent') + 'x'.repeat(8 * 1024 * 1024 + 1));
            const reader = new ClaudeTranscriptUsageReader(root, 'owned');
            const observed = new Set(['parent', 'child', 'later']);
            expect([...await reader.read(observed)].map(([id]) => id).sort()).toEqual(['child', 'parent']);
            appendFileSync(file, 'rest of oversized row\n' + row('later'));
            expect((await reader.read(observed)).get('later')?.output_tokens).toBe(7);
            expect(warning).toHaveBeenCalledTimes(2);
            expect(JSON.stringify(warning.mock.calls)).not.toContain('private broken history');
            await reader.read(observed);
            expect(warning).toHaveBeenCalledTimes(2);
        } finally { warning.mockRestore(); rmSync(root, { recursive: true, force: true }); }
    });

});
