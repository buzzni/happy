import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, readFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getProjectPath } from '../claude/utils/path';
import { readClaudeTranscriptUsage } from './claudeTranscriptUsage';
import { ClaudeStreamedUsage } from './claudeStreamedUsage';
import { createClaudeUsageEvent } from './providerUsageAdapters';
import { ProviderUsageSpool } from './providerUsageSpool';

// Opt-in only: existing local Claude login, synthetic text, tools/MCP/hooks disabled.
// No tokens, prompt contents, transcript or provider request IDs are persisted as evidence.
describe.skipIf(process.env.HAPPY_USAGE_LIVE !== '1')('real Claude usage reconciliation', () => {
    it.each(['text', 'read', 'subagent'])('matches independent provider transcript counters (%s)', async (mode) => {
        const withTool = mode !== 'text';
        const root = await realpath(await mkdtemp(join(tmpdir(), 'happy-live-usage-')));
        try {
            const env = Object.fromEntries(['HOME', 'PATH', 'USER', 'LANG', 'TMPDIR'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
            await writeFile(join(root, 'probe.txt'), 'USAGE_CHECK_OK');
            const { stdout } = await promisify(execFile)('claude', ['--print', '--output-format', 'stream-json', '--verbose',
                '--include-partial-messages', '--model', 'haiku', '--tools', mode === 'subagent' ? 'Agent' : withTool ? 'Read' : '',
                '--allowedTools', mode === 'subagent' ? 'Agent' : 'Read',
                '--agents', JSON.stringify({ usage_probe: { description: 'Synthetic usage test agent', prompt: 'Reply exactly USAGE_CHILD_OK.', tools: [], model: 'haiku' } }), '--strict-mcp-config',
                '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--setting-sources', '',
                '--settings', '{"disableAllHooks":true}', '--system-prompt', 'Follow the user request. Only read the named probe file when asked; perform no other actions.',
                '--max-budget-usd', '1', mode === 'subagent' ? 'Invoke the usage_probe agent exactly once with a request to reply USAGE_CHILD_OK, then reply USAGE_CHECK_OK. Do not invoke other tools.' : withTool ? 'Use the Read tool to read probe.txt in the current directory, then reply with its literal contents.' : 'Reply with exactly USAGE_CHECK_OK.'], { cwd: root, env, timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
            const rows = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
            const result = [...rows].reverse().find(row => row.type === 'result');
            expect(result?.is_error).toBe(false);
            expect(result?.usage?.output_tokens).toBeGreaterThan(0);
            const spool = new ProviderUsageSpool({ root: join(root, 'spool'), server: 'https://live-usage.test',
                sessionId: 'synthetic-session', key: new Uint8Array(32).fill(7), variant: 'dataKey' });
            const tracker = new ClaudeStreamedUsage();
            for (const row of rows) {
                if (row.type === 'stream_event') tracker.noteStreamEvent(row);
                if (row.type === 'assistant' && row.message?.usage) {
                    tracker.noteAssistant(row.message.id, row.message.usage, (usage, final) => {
                        expect(final).toBe(true);
                        spool.put(createClaudeUsageEvent({ sessionId: 'synthetic-session', occurredAt: Date.now(),
                            messageId: row.message.id, transcriptUuid: row.uuid, model: row.message.model, usage }));
                    });
                }
            }
            const nativeSession = rows.find(row => row.type === 'system' && row.subtype === 'init')?.session_id;
            expect(typeof nativeSession).toBe('string');
            const projectDir = getProjectPath(root);
            const observed = new Set<string>(rows.filter(row => row.type === 'assistant').map(row => row.message.id));
            for (const [id, usage] of await readClaudeTranscriptUsage(projectDir, nativeSession, observed)) tracker.noteTranscriptFinal(id, usage);
            tracker.drain();
            // Independent reference: the actual CLI's completed transcript, deduplicated by request ID.
            // result.usage can describe only the latest turn when an Agent completes asynchronously.
            const files = [join(projectDir, `${nativeSession}.jsonl`)];
            const children = join(projectDir, nativeSession, 'subagents');
            if (mode === 'subagent') files.push(...(await readdir(children)).filter(name => name.endsWith('.jsonl')).map(name => join(children, name)));
            const reference = new Map<string, any>();
            for (const file of files) for (const line of (await readFile(file, 'utf8')).split('\n').filter(Boolean)) {
                const row = JSON.parse(line);
                // This is a fresh synthetic session: every transcript request belongs to the probe.
                // Do not filter by collected IDs, which would hide entirely missing SDK requests.
                if (row.type === 'assistant' && typeof row.message?.id === 'string' && row.message.usage) reference.set(row.message.id, row.message.usage);
            }
            expect([...reference.keys()].sort()).toEqual([...observed].sort());
            if (mode === 'subagent') {
                const invocations = rows.filter(row => row.type === 'assistant' && !row.parent_tool_use_id)
                    .flatMap(row => row.message.content).filter(block => block.type === 'tool_use' && block.name === 'Agent');
                expect(new Set(invocations.map(block => block.id)).size).toBe(1);
                expect(rows.some(row => row.type === 'assistant' && row.parent_tool_use_id)).toBe(true);
            }
            const events = spool.load();
            expect(events.length).toBeGreaterThan(withTool ? 1 : 0);
            if (withTool) expect(rows.some(row => row.type === 'assistant' && row.message.content.some((block: { type: string; name?: string }) => block.type === 'tool_use' && block.name === (mode === 'subagent' ? 'Agent' : 'Read')))).toBe(true);
            const actual = events.reduce((sum, event) => ({ input: sum.input + event.tokens.input, output: sum.output + event.tokens.output,
                cacheRead: sum.cacheRead + event.tokens.cacheRead, cacheWrite: sum.cacheWrite + event.tokens.cacheWrite }),
                { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
            const expected = [...reference.values()].reduce((sum, usage) => ({
                input: sum.input + usage.input_tokens, output: sum.output + usage.output_tokens,
                cacheRead: sum.cacheRead + (usage.cache_read_input_tokens ?? 0), cacheWrite: sum.cacheWrite + (usage.cache_creation_input_tokens ?? 0),
            }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
            expect(events).toHaveLength(reference.size);
            expect(actual).toEqual(expected);
            if (process.env.HAPPY_USAGE_LIVE_RESULT) await writeFile(process.env.HAPPY_USAGE_LIVE_RESULT,
                JSON.stringify({ at: new Date().toISOString(), provider: 'anthropic', models: [...new Set(events.map(e => e.model))],
                    eventCount: events.length, actual, expected, matched: true, scope: `real CLI stream to encrypted spool; ${mode}` }, null, 2));
        } finally { await rm(root, { recursive: true, force: true }); }
    }, 100000);
});
