import { describe, expect, it } from 'vitest';
import { claudeRateLimits, codexRateLimits } from './aiRateLimits';

describe('claudeRateLimits (aplus specs/org-member-ai-plan-usage P10)', () => {
    it('takes the five-hour and seven-day windows the session already holds', () => {
        expect(claudeRateLimits({
            capturedAt: 1,
            windows: [
                { id: 'five_hour', utilization: 72, resetsAt: '2026-11-24T05:00:00.000Z' },
                { id: 'seven_day', utilization: 40.5, resetsAt: null },
                { id: 'seven_day_opus', utilization: 99, resetsAt: null },
            ],
        })).toEqual({
            fiveHour: { usedPercent: 72, resetsAt: Date.parse('2026-11-24T05:00:00.000Z') },
            weekly: { usedPercent: 40.5, resetsAt: null },
        });
    });

    it('reports nothing when no account-wide window is known', () => {
        expect(claudeRateLimits(undefined)).toBeNull();
        expect(claudeRateLimits({ capturedAt: 1, windows: [{ id: 'plan', utilization: 10, resetsAt: null }] })).toBeNull();
        expect(claudeRateLimits({ capturedAt: 1, windows: [{ id: 'five_hour', utilization: null, resetsAt: null }] })).toBeNull();
    });
});

describe('codexRateLimits', () => {
    it('places windows by their duration and reads reset seconds as epoch ms', () => {
        expect(codexRateLimits({
            primary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 1_788_000_000 },
            secondary: { usedPercent: 55, windowDurationMins: 300, resetsAt: null },
        })).toEqual({
            fiveHour: { usedPercent: 55, resetsAt: null },
            weekly: { usedPercent: 20, resetsAt: 1_788_000_000_000 },
        });
    });

    it('falls back to primary = five-hour, secondary = weekly when Codex does not say', () => {
        expect(codexRateLimits({
            primary: { usedPercent: 5, windowDurationMins: null, resetsAt: null },
            secondary: { usedPercent: 9, windowDurationMins: null, resetsAt: null },
        })).toEqual({ fiveHour: { usedPercent: 5, resetsAt: null }, weekly: { usedPercent: 9, resetsAt: null } });
    });

    it('reports nothing for a snapshot without windows', () => {
        expect(codexRateLimits({ primary: null, secondary: null })).toBeNull();
        expect(codexRateLimits(undefined)).toBeNull();
    });
});
