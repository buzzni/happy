import { describe, expect, it } from 'vitest';
import { describeCodexInactivityAbort } from './codexAbortNotice';

describe('describeCodexInactivityAbort', () => {
    it('names the not-ready MCP server when the watchdog force-stops a hung turn', () => {
        const notice = describeCodexInactivityAbort({
            type: 'turn_aborted',
            reason: 'inactivity_timeout',
            inactivity_timeout_ms: 600000,
            not_ready_mcp_servers: ['dataAnalyticsWidgets', 'mcp-gateway'],
        });

        expect(notice).toContain('Stopped automatically');
        expect(notice).toContain('600s');
        expect(notice).toContain('dataAnalyticsWidgets');
        expect(notice).toContain('mcp-gateway');
    });

    it('still explains the auto-stop when no MCP server is to blame', () => {
        const notice = describeCodexInactivityAbort({
            type: 'turn_aborted',
            reason: 'inactivity_timeout',
            inactivity_timeout_ms: 600000,
            not_ready_mcp_servers: [],
        });

        expect(notice).toContain('Stopped automatically');
        expect(notice).not.toContain('MCP server was not ready');
    });

    it('describes a watchdog stop even when codex settles the turn as task_complete', () => {
        // Real incident shape: codex answered turn/interrupt with status 'completed',
        // so the watchdog abort surfaced as task_complete, not turn_aborted.
        const notice = describeCodexInactivityAbort({
            type: 'task_complete',
            reason: 'inactivity_timeout',
            inactivity_timeout_ms: 600000,
            not_ready_mcp_servers: ['dataAnalyticsWidgets'],
        });

        expect(notice).toContain('Stopped automatically');
        expect(notice).toContain('dataAnalyticsWidgets');
    });

    it('falls back to wording without a duration when the timeout rounds to 0s', () => {
        const notice = describeCodexInactivityAbort({
            type: 'turn_aborted',
            reason: 'inactivity_timeout',
            inactivity_timeout_ms: 20,
            not_ready_mcp_servers: [],
        });

        expect(notice).toContain('a long silence');
        expect(notice).not.toContain('0s');
    });

    it('stays silent for a user-initiated cancel (no inactivity reason)', () => {
        const userCancel = { type: 'turn_aborted', status: 'cancelled' };
        expect(describeCodexInactivityAbort(userCancel)).toBeNull();
    });

    it('stays silent for events with no inactivity reason', () => {
        expect(describeCodexInactivityAbort({ type: 'task_complete' })).toBeNull();
        expect(describeCodexInactivityAbort(null)).toBeNull();
        expect(describeCodexInactivityAbort(undefined)).toBeNull();
    });
});
