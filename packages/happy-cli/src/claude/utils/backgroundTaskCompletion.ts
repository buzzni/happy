// Forward terminal receipts using the task-notification format clients already understand.
// A launch result or a turn-end does not prove that a detached process has ended.
type Completion = { taskId: string; toolUseId?: string; status: 'completed' | 'failed' | 'stopped' };

function taskId(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(value);
}

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : null;
}

function notice(completion: Completion): string {
    return ['<task-notification>', `<task-id>${completion.taskId}</task-id>`,
        ...(completion.toolUseId ? [`<tool-use-id>${completion.toolUseId}</tool-use-id>`] : []),
        `<status>${completion.status}</status>`, '</task-notification>'].join('\n');
}

export function sdkBackgroundTaskCompletion(message: unknown): string | null {
    const data = record(message);
    if (data?.type !== 'system' || data.subtype !== 'task_notification' || !taskId(data.task_id)) return null;
    const status = data.status === 'completed' || data.status === 'failed' ? data.status
        : data.status === 'stopped' || data.status === 'cancelled' ? 'stopped' : null;
    if (!status) return null;
    return notice({ taskId: data.task_id, status,
        ...(taskId(data.tool_use_id) ? { toolUseId: data.tool_use_id } : {}) });
}

export function stoppedBackgroundTaskCompletion(toolName: string | undefined, block: unknown): string | null {
    const result = record(block);
    if (toolName !== 'TaskStop' || result?.is_error === true) return null;
    // TaskStop's harness-authored JSON receipt is the evidence, never the stop request itself.
    if (typeof result?.content !== 'string') return null;
    let receipt: Record<string, unknown> | null;
    try { receipt = record(JSON.parse(result.content)); } catch { return null; }
    if (!receipt || !taskId(receipt.task_id) || typeof receipt.message !== 'string'
        || !receipt.message.startsWith(`Successfully stopped task: ${receipt.task_id} (`)) return null;
    return notice({ taskId: receipt.task_id, status: 'stopped' });
}
