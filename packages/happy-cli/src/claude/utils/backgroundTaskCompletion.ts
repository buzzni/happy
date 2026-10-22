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

/** Monitor events are independent; terminal receipts must not preempt scanner details in first-id-wins clients. */
export function backgroundTaskNoticeId(text: string, source: 'notification' | 'receipt' = 'notification'): string | undefined {
    const content = text.trim();
    if (!content.startsWith('<task-notification>') || !content.endsWith('</task-notification>')
        || content.indexOf('<task-notification>', 1) !== -1) return undefined;
    const id = content.match(/<task-id>\s*([A-Za-z0-9_-]{1,512})\s*<\/task-id>/)?.[1];
    const status = content.match(/<status>\s*(completed|failed|stopped|killed)\s*<\/status>/)?.[1];
    return id && status ? `task-notification:${id}${source === 'receipt' ? `:receipt:${status}` : ''}` : undefined;
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
    const content = typeof result?.content === 'string' ? result.content : Array.isArray(result?.content)
        ? result.content.flatMap(block => {
            const item = record(block);
            return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
        }).join('\n') : null;
    if (!content) return null;
    let receipt: Record<string, unknown> | null;
    try { receipt = record(JSON.parse(content)); } catch { return null; }
    if (!receipt || !taskId(receipt.task_id) || typeof receipt.message !== 'string'
        || !receipt.message.startsWith(`Successfully stopped task: ${receipt.task_id} (`)) return null;
    return notice({ taskId: receipt.task_id, status: 'stopped' });
}
