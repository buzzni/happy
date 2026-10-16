/** Model input only: keep the encrypted conversation's stored user text unchanged. */
export function buildScheduledRunPrompt(task: string): string {
    return [
        '## Scheduled task occurrence',
        'This is one execution of an already-registered scheduled task. The scheduler controls its recurrence.',
        'Perform only the underlying work for the current occurrence now and return its result in this conversation.',
        'Do not create, register, or resume a schedule. Do not use script_automations, cron, or background timers to schedule this work.',
        'If the request mentions an interval or future repetitions, those are already handled by the scheduler. Missing scheduling tools do not prevent this occurrence from running.',
        'Original task:',
        '',
        task,
    ].join('\n');
}
