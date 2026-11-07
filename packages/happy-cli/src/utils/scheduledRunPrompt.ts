/**
 * The occurrence time this run actually started at, shown to the model only.
 * `timeZone` is the schedule's IANA zone for `*-zoned` schedules; otherwise (or
 * when the zone is unusable) the machine's zone — the clock the schedule runs on.
 */
export interface ScheduledRunTime {
    at: number
    timeZone?: string
}

function formatRunTime({ at, timeZone }: ScheduledRunTime): string {
    const machineZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    // Keep the zone name as the schedule spells it; ICU may canonicalize it (Asia/Kathmandu -> Asia/Katmandu).
    const zone = timeZone ?? machineZone
    let format: Intl.DateTimeFormat
    try {
        format = new Intl.DateTimeFormat('en-US', {
            timeZone: zone, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        })
    } catch {
        return formatRunTime({ at })
    }
    const parts = Object.fromEntries(format.formatToParts(at).map(part => [part.type, part.value]))
    // Wall clock minus the instant (both floored to the minute) is the zone's offset at that instant, DST included.
    const offsetMinutes = Math.round((
        Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute))
        - (at - (((at % 60_000) + 60_000) % 60_000))
    ) / 60_000)
    const offset = `${offsetMinutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0')}:${String(Math.abs(offsetMinutes) % 60).padStart(2, '0')}`
    return `[CURRENT RUN TIME: ${parts.weekday}, ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (${zone}, UTC${offset})]`
}

/** Model input only: keep the encrypted conversation's stored user text unchanged. */
export function buildScheduledRunPrompt(task: string, run: ScheduledRunTime): string {
    return [
        '## Scheduled task occurrence',
        'This is one execution of an already-registered scheduled task. The scheduler controls its recurrence.',
        'Perform only the underlying work for the current occurrence now and return its result in this conversation.',
        'Do not create, register, or resume a schedule. Do not use script_automations, cron, or background timers to schedule this work.',
        'If the request mentions an interval or future repetitions, those are already handled by the scheduler. Missing scheduling tools do not prevent this occurrence from running.',
        formatRunTime(run),
        'Original task:',
        '',
        task,
    ].join('\n');
}
