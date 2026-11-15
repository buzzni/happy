import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CodexAppServerClient } from './codexAppServerClient';
import { createCodexUsageEvent } from '@/usage/providerUsageAdapters';

// Opt-in real provider check: synthetic text only, no transcript/auth/response IDs in evidence.
it.skipIf(process.env.HAPPY_CODEX_USAGE_LIVE !== '1')('matches a real Codex response to its native request record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-live-usage-'));
    const client = new CodexAppServerClient(undefined, undefined, undefined, 'owner-choice', []);
    const events: any[] = [];
    client.setEventHandler(event => events.push(event));
    try {
        await client.connect();
        await client.startThread({ cwd: root, approvalPolicy: 'never', sandbox: 'read-only',
            developerInstructions: 'This is a usage accounting probe. Do not invoke any tools. Reply only USAGE_CHECK_OK.' });
        const result = await client.sendTurnAndWait('Reply exactly USAGE_CHECK_OK without calling any tool.', { effort: 'low' });
        expect(result.aborted).toBe(false);
        const thread = (await client.readThread({ threadId: client.threadId!, includeTurns: false })).thread;
        expect(thread.path).toBeTruthy();
        let records: any[] = [];
        for (let attempt = 0; attempt < 20; attempt++) {
            records = (await readFile(thread.path!, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
                .filter(row => row.type === 'token_usage_record' && row.payload.thread_id === thread.id).map(row => row.payload);
            if (records.length) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const collected = events.filter(event => event.type === 'codex_usage');
        expect(records).toHaveLength(1);
        expect(collected).toHaveLength(1);
        expect(collected[0].response_id).toBe(records[0].response_id);
        const actual = createCodexUsageEvent({ sessionId: 'probe', responseId: collected[0].response_id,
            occurredAt: 1, usage: collected[0].usage }).tokens;
        const u = records[0].usage;
        const expected = { input: u.input_tokens - u.cached_input_tokens - u.cache_write_input_tokens,
            output: u.output_tokens - u.reasoning_output_tokens, cacheRead: u.cached_input_tokens,
            cacheWrite: u.cache_write_input_tokens, reasoning: u.reasoning_output_tokens, total: u.total_tokens };
        expect(actual).toEqual(expected);
        expect(events.some(e => ['exec_command_begin', 'mcp_tool_call_begin', 'collab_agent_spawned'].includes(e.type))).toBe(false);
        if (process.env.HAPPY_CODEX_USAGE_LIVE_RESULT) await writeFile(process.env.HAPPY_CODEX_USAGE_LIVE_RESULT,
            JSON.stringify({ provider: 'openai', eventCount: collected.length, actual, expected, matched: true,
                scope: 'real Codex app-server response versus persisted request usage; synthetic text only' }, null, 2));
    } finally { await client.disconnect(); await rm(root, { recursive: true, force: true }); }
}, 90000);
