/**
 * An AgentTask worker whose Codex turn kept dying with "model at capacity" never reaches
 * `/complete` or `/fail` by itself — the session ends first. The server cannot tell that from
 * an abandoned task, so it waited out the deadline and the review vanished (aplus-dev-studio#5177).
 * The host reports it with the same capability the worker would have used, marked retryable so
 * the server can queue another attempt.
 */

const REPORT_TIMEOUT_MS = 10_000;

export async function reportAgentTaskCapacityFailure(
    env: NodeJS.ProcessEnv = process.env,
    fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
    const url = env.APLUS_AGENT_TASK_URL;
    const taskId = env.APLUS_AGENT_TASK_ID;
    const agentRunId = env.APLUS_AGENT_TASK_RUN_ID;
    const token = env.APLUS_AGENT_TASK_COMPLETE_TOKEN;
    if (!url || !taskId || !agentRunId || !token) return false;
    try {
        const response = await fetchImpl(`${url}/${encodeURIComponent(taskId)}/fail`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                version: 1,
                token,
                agentRunId,
                idempotencyKey: `host-capacity-fail:${taskId}:${agentRunId}`,
                reason: 'Codex model was at capacity and did not recover after automatic retries',
                retryable: true,
            }),
            signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
        });
        return response.ok;
    } catch {
        return false;
    }
}
