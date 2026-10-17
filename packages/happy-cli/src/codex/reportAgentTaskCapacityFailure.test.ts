import { describe, expect, it, vi } from 'vitest';
import { reportAgentTaskCapacityFailure } from './reportAgentTaskCapacityFailure';

const env = {
    APLUS_AGENT_TASK_URL: 'https://studio.example/api/agent-tasks',
    APLUS_AGENT_TASK_ID: 'task 1',
    APLUS_AGENT_TASK_RUN_ID: 'run-1',
    APLUS_AGENT_TASK_COMPLETE_TOKEN: 'complete-secret',
};

describe('reportAgentTaskCapacityFailure', () => {
    it('tells the server the attempt failed for a retryable reason', async () => {
        const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));

        const reported = await reportAgentTaskCapacityFailure(env, fetchImpl as never);

        expect(reported).toBe(true);
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://studio.example/api/agent-tasks/task%201/fail');
        expect(JSON.parse(String(init.body))).toMatchObject({
            version: 1,
            token: 'complete-secret',
            agentRunId: 'run-1',
            retryable: true,
            idempotencyKey: expect.stringContaining('task 1'),
        });
        expect(String(init.body)).not.toContain('"claim');
    });

    it('does nothing outside an AgentTask session', async () => {
        const fetchImpl = vi.fn();

        expect(await reportAgentTaskCapacityFailure({}, fetchImpl as never)).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('reports false instead of throwing when the server cannot be reached', async () => {
        const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET'); });

        expect(await reportAgentTaskCapacityFailure(env, fetchImpl as never)).toBe(false);
    });

    it('reports false when the server refuses the report', async () => {
        const fetchImpl = vi.fn(async () => new Response('{}', { status: 409 }));

        expect(await reportAgentTaskCapacityFailure(env, fetchImpl as never)).toBe(false);
    });
});
