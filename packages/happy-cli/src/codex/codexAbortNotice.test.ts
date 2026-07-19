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

    it('stays silent for a user-initiated cancel (no inactivity reason)', () => {
        expect(describeCodexInactivityAbort({
            type: 'turn_aborted',
            status: 'cancelled',
        } as any)).toBeNull();
    });

    it('stays silent for non-abort events', () => {
        expect(describeCodexInactivityAbort({ type: 'task_complete' })).toBeNull();
        expect(describeCodexInactivityAbort(null)).toBeNull();
        expect(describeCodexInactivityAbort(undefined)).toBeNull();
    });
});
