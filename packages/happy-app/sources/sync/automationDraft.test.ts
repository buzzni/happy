import { describe, expect, it } from 'vitest';
import { automationDraftFor, automationPayloadFromDraft } from './automationDraft';

describe('automation draft', () => {
    it('uses the project workspace and validates the minimum interval', () => {
        const draft = automationDraftFor({
            id: 'project-1', name: 'Project', membership: 'owner', config: { workspaceDir: '/workspace/project' },
        }, null);
        expect(draft.directory).toBe('/workspace/project');
        expect(() => automationPayloadFromDraft({
            ...draft, name: 'Review', prompt: 'Review it', intervalMinutes: '14',
        })).toThrow('Interval must be at least 15 minutes.');
    });

    it('normalizes daily time and optional script without changing the selected agent', () => {
        const payload = automationPayloadFromDraft({
            projectId: 'project-1', item: null, name: ' Daily review ', prompt: ' Review ', directory: ' /workspace ',
            scheduleKind: 'daily', intervalMinutes: '30', dailyTime: '09:20', scriptCommand: ' ',
            suppressSilent: true, agent: 'codex',
        });
        expect(payload).toEqual({
            name: 'Daily review', prompt: 'Review', directory: '/workspace',
            schedule: { kind: 'daily', hour: 9, minute: 20 }, scriptCommand: null,
            suppressSilent: true, agent: 'codex',
        });
    });

    it('does not silently convert GitHub triggers into daily schedules', () => {
        const project = { id: 'project-1', name: 'Project', membership: 'owner' as const, config: null };
        expect(() => automationDraftFor(project, {
            row: {} as never,
            payload: { schedule: { kind: 'github', minutes: 15 } } as never,
            runs: [],
        })).toThrow('must be edited in Desktop');
    });
});
