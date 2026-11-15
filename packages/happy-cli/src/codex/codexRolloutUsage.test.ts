import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { CodexRolloutUsage } from './codexRolloutUsage';

vi.mock('@/ui/logger', () => ({ logger: { warn: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const usage = { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 15 };
const row = (thread = 'fork', turn = 'new', response = 'response') => JSON.stringify({ type: 'token_usage_record', payload: {
    thread_id: thread, turn_id: turn, response_id: response, usage,
    thread_token_usage: { total_tokens: 9999 }, turn_token_usage: { total_tokens: 9999 },
} }) + '\n';
async function fixture(text = '') {
    const root = await mkdtemp(join(tmpdir(), 'codex-usage-')); roots.push(root);
    const path = join(root, 'rollout.jsonl'); await writeFile(path, text);
    const events: any[] = [];
    const reader = new CodexRolloutUsage(event => events.push(event));
    reader.allowTurn('fork', 'new');
    return { path, events, reader };
}
it('cold/fork reads request usage by native identity, excluding copied history and foreign rows', async () => {
    const { reader, path, events } = await fixture(row('parent', 'old') + row('fork', 'old') + row() + row('foreign'));
    await reader.read('fork', path);
    expect(events).toEqual([{ threadId: 'fork', turnId: 'new', responseId: 'response', usage: {
        inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15,
    } }]);
});
it('counts identical totals for distinct responses, but not raw/rollout duplicates or rereads', async () => {
    const { reader, path, events } = await fixture(row() + row('fork', 'new', 'second') + row());
    reader.markResponse('response');
    await reader.read('fork', path); await reader.read('fork', path);
    expect(events.map(e => e.responseId)).toEqual(['second']);
});
it('retries late writes and split lines without accepting incomplete or malformed usage', async () => {
    const line = row();
    const { reader, path, events } = await fixture(line.slice(0, -4));
    await reader.read('fork', path); expect(events).toEqual([]);
    await appendFile(path, line.slice(-4)); await reader.read('fork', path);
    expect(events).toHaveLength(1);
    await appendFile(path, row('fork', 'new', 'invalid').replace('"input_tokens":10', '"input_tokens":-1'));
    await reader.read('fork', path);
    expect(events).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledOnce();
});
it('retains observed aborted/child turn requests without inventing usage for an unobserved turn', async () => {
    const { reader, path, events } = await fixture(row('child', 'aborted') + row('child', 'unknown'));
    reader.allowTurn('child', 'aborted');
    await reader.read('child', path);
    expect(events.map(e => e.turnId)).toEqual(['aborted']);
});
it('a new reader on reconnect re-emits only explicitly owned turns with the same stable response id', async () => {
    const { reader, path, events } = await fixture(row());
    await reader.read('fork', path);
    const recovered: any[] = [];
    const next = new CodexRolloutUsage(e => recovered.push(e));
    await next.read('fork', path); expect(recovered).toEqual([]);
    next.allowTurn('fork', 'new');
    // Attach before reading live work; reconnect replay is explicitly scoped by turn identity.
    await next.read('fork', path);
    expect(recovered).toEqual([]);
    const replay = new CodexRolloutUsage(e => recovered.push(e)); replay.allowTurn('fork', 'new');
    await replay.read('fork', path); expect(recovered).toEqual(events);
});

it('retries an unaccepted event after consumer failure instead of losing it to deduplication', async () => {
    const { path } = await fixture(row());
    let fail = true;
    const events: any[] = [];
    const reader = new CodexRolloutUsage(event => { if (fail) throw new Error('consumer failed'); events.push(event); });
    reader.allowTurn('fork', 'new');
    await expect(reader.read('fork', path)).rejects.toThrow('consumer failed');
    fail = false;
    await reader.read('fork', path);
    expect(events).toHaveLength(1);
});

it('cold resume skips malformed historical rows and invalid observed usage without poisoning later records', async () => {
    const secret = 'PRIVATE_ROW_CONTENT';
    const invalid = row('fork', 'new', 'invalid').replace('"input_tokens":10', '"input_tokens":-1');
    const { reader, path, events } = await fixture(`{${secret}\nnull\n` + invalid + row());
    await reader.read('fork', path);
    await reader.read('fork', path);
    expect(events.map(e => e.responseId)).toEqual(['response']);
    expect(reader.hasResponse('invalid')).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(secret);
    await appendFile(path, row('fork', 'new', 'later'));
    await reader.read('fork', path);
    expect(events.map(e => e.responseId)).toEqual(['response', 'later']);
    expect(logger.warn).toHaveBeenCalledTimes(3);
});

it('discards oversized rows in bounded space, through later appends, then reads the next complete record', async () => {
    const { reader, path, events } = await fixture('x'.repeat(4 * 1024 * 1024));
    await reader.read('fork', path);
    expect(events).toEqual([]);
    expect(logger.warn).toHaveBeenCalledOnce();
    await appendFile(path, 'y'.repeat(4 * 1024 * 1024));
    await reader.read('fork', path);
    expect(logger.warn).toHaveBeenCalledOnce();
    await appendFile(path, '\n' + row().slice(0, -8));
    await reader.read('fork', path);
    expect(events).toEqual([]);
    await appendFile(path, row().slice(-8));
    await reader.read('fork', path);
    expect(events.map(e => e.responseId)).toEqual(['response']);
    expect(logger.warn).toHaveBeenCalledOnce();
});

it('does not re-diagnose skipped rows when a later consumer fails and needs a retry', async () => {
    const { path } = await fixture('broken\n' + row('fork', 'new', 'one') + row('fork', 'new', 'two'));
    let fail = true;
    const accepted: string[] = [];
    const reader = new CodexRolloutUsage(event => {
        if (event.responseId === 'two' && fail) throw new Error('consumer unavailable');
        accepted.push(event.responseId);
    });
    reader.allowTurn('fork', 'new');
    await expect(reader.read('fork', path)).rejects.toThrow('consumer unavailable');
    expect(accepted).toEqual(['one']);
    expect(logger.warn).toHaveBeenCalledOnce();
    fail = false;
    await reader.read('fork', path);
    expect(accepted).toEqual(['one', 'two']);
    expect(logger.warn).toHaveBeenCalledOnce();
});

it('never emits an oversized otherwise-valid usage record as exact, and accepts the following record', async () => {
    const oversized = { ...JSON.parse(row('fork', 'new', 'oversized')), padding: 'x'.repeat(1024 * 1024) };
    const { reader, path, events } = await fixture(JSON.stringify(oversized) + '\n' + row());
    await reader.read('fork', path);
    expect(events.map(e => e.responseId)).toEqual(['response']);
    expect(reader.hasResponse('oversized')).toBe(false);
    expect(logger.warn).toHaveBeenCalledOnce();
});

it('preserves a multi-chunk trailing row and retries that row alone if its consumer fails', async () => {
    const padded = JSON.stringify({ ...JSON.parse(row()), padding: '한'.repeat(30000) }) + '\n';
    const bytes = Buffer.from(padded);
    const { path } = await fixture('broken\n');
    await appendFile(path, bytes.subarray(0, 65537)); // Split a UTF-8 sequence across reads.
    let fail = true;
    const events: any[] = [];
    const reader = new CodexRolloutUsage(event => { if (fail) throw new Error('retry'); events.push(event); });
    reader.allowTurn('fork', 'new');
    await reader.read('fork', path);
    expect(events).toEqual([]);
    await appendFile(path, bytes.subarray(65537));
    await expect(reader.read('fork', path)).rejects.toThrow('retry');
    fail = false;
    await reader.read('fork', path);
    expect(events.map(e => e.responseId)).toEqual(['response']);
    expect(logger.warn).toHaveBeenCalledOnce();
});
