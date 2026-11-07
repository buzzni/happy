import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeBackgroundTaskDetails } from './claudeBackgroundTaskDetails';

const toolUse = (id: string, name: string, input: object) => ({
    type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] },
}) as unknown as SDKMessage;
const started = (taskId: string, toolUseId?: string) => ({
    type: 'system', subtype: 'task_started', task_id: taskId, description: 'x', ...(toolUseId ? { tool_use_id: toolUseId } : {}),
}) as unknown as SDKMessage;

describe('Claude background task rows (specs/agent-background-work-panel R1)', () => {
    it('keeps the type, the first listed time, and the Bash/Monitor command of each task', () => {
        let clock = 1_000;
        const details = createClaudeBackgroundTaskDetails(() => clock);
        expect(details.observe(toolUse('use-1', 'Bash', { command: '  npm run dev  ', run_in_background: true }))).toBeNull();
        expect(details.observe(toolUse('use-2', 'Monitor', { command: 'tail -f log', description: 'watch' }))).toBeNull();
        expect(details.observe(started('shell-1', 'use-1'))).toBe('shell-1');
        expect(details.list([
            { task_id: 'shell-1', task_type: 'local_bash', description: 'dev server' },
            { task_id: 'agent-1', task_type: 'local_agent', description: 'review' },
        ])).toEqual([
            { taskId: 'shell-1', label: 'dev server', kind: 'shell', taskType: 'local_bash', startedAt: 1_000, command: 'npm run dev', toolName: 'Bash' },
            { taskId: 'agent-1', label: 'review', kind: 'agent', taskType: 'local_agent', startedAt: 1_000 },
        ]);
        clock = 5_000;
        // The level usually precedes its bookend: the monitor is listed before its command is known.
        const rows = details.list([
            { task_id: 'shell-1', task_type: 'local_bash', description: 'dev server' },
            { task_id: 'monitor-1', task_type: 'local_bash', description: 'watch' },
        ]);
        expect(rows.map(row => [row.taskId, row.startedAt, row.command])).toEqual([['shell-1', 1_000, 'npm run dev'], ['monitor-1', 5_000, undefined]]);
        expect(details.observe(started('monitor-1', 'use-2'))).toBe('monitor-1');
        expect(details.withCommands(rows)[1]).toEqual(expect.objectContaining({ command: 'tail -f log', toolName: 'Monitor' }));
    });

    it('ignores other tools, empty commands and bookends without a known call', () => {
        const details = createClaudeBackgroundTaskDetails(() => 1);
        details.observe(toolUse('use-read', 'Read', { command: 'not a shell' }));
        details.observe(toolUse('use-empty', 'Bash', { command: '   ' }));
        expect(details.observe(started('a', 'use-read'))).toBeNull();
        expect(details.observe(started('b', 'use-empty'))).toBeNull();
        expect(details.observe(started('c'))).toBeNull();
        expect(details.list([{ task_id: 'a', task_type: 'local_bash', description: '' }])[0]).not.toHaveProperty('command');
    });

    it('restarts the clock of a task that left the list and caps the command length', () => {
        let clock = 1;
        const details = createClaudeBackgroundTaskDetails(() => clock);
        details.observe(toolUse('use-long', 'Bash', { command: 'x'.repeat(5000) }));
        details.observe(started('long', 'use-long'));
        details.list([{ task_id: 'long', task_type: 'local_bash', description: '' }]);
        details.list([]);
        clock = 7;
        const [row] = details.list([{ task_id: 'long', task_type: 'local_bash', description: '' }]);
        expect(row.startedAt).toBe(7);
        expect(row.command).toHaveLength(1000);
    });
});
