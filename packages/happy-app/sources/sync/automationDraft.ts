import type { AutomationPayload, AutomationSchedule } from '@slopus/happy-wire';
import type { AutomationProject, ServerAutomationItem } from './serverAutomations';

export interface AutomationDraft {
    projectId: string;
    item: ServerAutomationItem | null;
    name: string;
    prompt: string;
    directory: string;
    scheduleKind: Exclude<AutomationSchedule['kind'], 'github'>;
    intervalMinutes: string;
    dailyTime: string;
    scriptCommand: string;
    suppressSilent: boolean;
    agent: AutomationPayload['agent'];
}

export function automationDraftFor(project: AutomationProject, item: ServerAutomationItem | null): AutomationDraft {
    const payload = item?.payload;
    if (payload?.schedule.kind === 'github') {
        throw new Error('GitHub trigger automations must be edited in Desktop.');
    }
    return {
        projectId: project.id,
        item,
        name: payload?.name ?? '',
        prompt: payload?.prompt ?? '',
        directory: payload?.directory ?? project.config?.workspaceDir ?? '',
        scheduleKind: payload?.schedule.kind ?? 'interval',
        intervalMinutes: payload?.schedule.kind === 'interval' ? String(payload.schedule.minutes) : '30',
        dailyTime: payload?.schedule.kind === 'daily'
            ? `${String(payload.schedule.hour).padStart(2, '0')}:${String(payload.schedule.minute).padStart(2, '0')}`
            : '09:00',
        scriptCommand: payload?.scriptCommand ?? '',
        suppressSilent: payload?.suppressSilent ?? true,
        agent: payload?.agent ?? null,
    };
}

export function automationPayloadFromDraft(draft: AutomationDraft): AutomationPayload {
    if (!draft.name.trim() || !draft.prompt.trim() || !draft.directory.trim()) {
        throw new Error('Name, prompt, and workspace directory are required.');
    }
    let schedule: AutomationSchedule;
    if (draft.scheduleKind === 'interval') {
        const minutes = Number.parseInt(draft.intervalMinutes, 10);
        if (!Number.isSafeInteger(minutes) || minutes < 15) throw new Error('Interval must be at least 15 minutes.');
        schedule = { kind: 'interval', minutes };
    } else {
        const match = /^(\d{2}):(\d{2})$/.exec(draft.dailyTime);
        const hour = Number(match?.[1]);
        const minute = Number(match?.[2]);
        if (!match || hour > 23 || minute > 59) throw new Error('Daily time must use HH:MM.');
        schedule = { kind: 'daily', hour, minute };
    }
    return {
        name: draft.name.trim(),
        prompt: draft.prompt.trim(),
        directory: draft.directory.trim(),
        schedule,
        scriptCommand: draft.scriptCommand.trim() || null,
        suppressSilent: draft.suppressSilent,
        agent: draft.agent,
    };
}
