/**
 * Claude permission prompts under an organization permission ceiling (aplus-dev-studio-desktop
 * specs/codexcli-org-requirements R10.3, R10.12). The gate and its adapter are real; the session is
 * the handful of fields the handler touches.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnAttendanceState, type TurnAttendance } from '@/api/turnAttendance';
import { ceilingDenialMessage, createOrgRequirementsGate } from '@/orgRequirements/gate';
import { createClaudeOrgRequirements } from '../claudeOrgRequirements';
import type { EnhancedMode } from '../loop';
import type { Session } from '../session';
import { PermissionHandler } from './permissionHandler';

type State = { requests?: Record<string, Record<string, unknown>>; completedRequests?: Record<string, Record<string, unknown>> };

let home: string;
beforeEach(() => { vi.useFakeTimers(); home = mkdtempSync(join(tmpdir(), 'perm-org-')); });
afterEach(() => { vi.useRealTimers(); rmSync(home, { recursive: true, force: true }); });

function setup(attendance: TurnAttendance, requestedMode: string) {
    const gate = createOrgRequirementsGate({ agent: 'claude', happyHomeDir: home, serverUrl: 'https://s', accountKey: 'a', sessionId: () => 's1', projectHint: null, publish: () => {}, refresh: async () => {} });
    gate.onRequirements({ kind: 'response', status: 'ok', requirements: {
        schemaVersion: 1, companyId: 'c1', revision: 2, modelPolicyUpdatedAt: null, issuedAt: 1,
        items: { 'permissions.mode': { kind: 'ceiling', max: 'default' }, 'tools.rules': { kind: 'rules', rules: [{ id: 'no-mail', tool: 'mcp__gmail__*', decision: 'blocked', since: 2 }] } },
    } });
    const attendanceState = new TurnAttendanceState();
    attendanceState.beginTurn(attendance);
    const orgRequirements = createClaudeOrgRequirements(gate, { normalizeModel: (model) => model, attendance: () => attendanceState.current(), initialPermissionMode: () => 'bypassPermissions' });
    // The launcher judges the batch as the turn starts.
    const turn = orgRequirements.checkTurn({ permissionMode: requestedMode as EnhancedMode['permissionMode'], orgModel: { requested: null, origin: 'none' } });
    let agentState: State = {};
    const handlers = new Map<string, (message: any) => Promise<any>>();
    const pushes: unknown[] = [];
    const session = {
        orgRequirements,
        client: {
            sessionId: 's1',
            rpcHandlerManager: { registerHandler: (name: string, fn: (message: any) => Promise<any>) => { handlers.set(name, fn); } },
            updateAgentState: (updater: (state: any) => any) => { agentState = updater(agentState); },
            getMetadata: () => ({}),
        },
        api: { push: () => ({ sendSessionNotification: (n: unknown) => { pushes.push(n); } }) },
    } as unknown as Session;
    const handler = new PermissionHandler(session);
    handler.setAttendance(attendanceState);
    if (turn.kind === 'run') handler.handleModeChange(turn.mode.permissionMode);
    const raise = (id: string, tool = 'Bash') => handler.handleToolCall(tool, { command: 'ls' }, { permissionMode: 'default' } as EnhancedMode, { signal: new AbortController().signal, toolUseID: id });
    return { handler, raise, agentState: () => agentState, pushes, answer: (m: unknown) => handlers.get('permission')!(m) };
}

describe('Claude prompts under an organization permission ceiling', () => {
    it('declines at once, with no card, push or timer, a prompt only the ceiling raised in an unattended turn', async () => {
        const t = setup('unattended', 'bypassPermissions');
        await expect(t.raise('toolu_1')).resolves.toEqual({ behavior: 'deny', message: ceilingDenialMessage() });
        expect(t.agentState().requests ?? {}).toEqual({});
        expect(t.agentState().completedRequests?.toolu_1).toMatchObject({ tool: 'Bash', status: 'denied', reason: 'requirement_ceiling' });
        expect(t.agentState().completedRequests?.toolu_1).not.toHaveProperty('resolution');
        expect(t.pushes).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
        // Not a person's stop: the turn goes on.
        expect(t.handler.isAborted('toolu_1')).toBe(false);
    });

    it('waits for a person as before in an attended turn', async () => {
        const t = setup('attended', 'bypassPermissions');
        const pending = t.raise('toolu_1');
        pending.catch(() => {});
        expect(t.agentState().requests?.toolu_1).toMatchObject({ tool: 'Bash' });
        expect(t.agentState().requests?.toolu_1).not.toHaveProperty('expiresAt');
    });

    it('keeps the D1 behaviour for a prompt the requested mode would have raised too', async () => {
        const t = setup('unattended', 'default');
        const pending = t.raise('toolu_1');
        pending.catch(() => {});
        // An ordinary unattended prompt: raised with the D1 thirty-minute wait.
        expect(t.agentState().requests?.toolu_1).toMatchObject({ tool: 'Bash', expiresAt: expect.any(Number) });
    });

    it('clips a plan approval to bypass and drops a blocked tool from allowTools (R10.3)', async () => {
        const t = setup('attended', 'bypassPermissions');
        const pending = t.raise('plan_1', 'ExitPlanMode');
        expect(await t.answer({ id: 'plan_1', approved: true, mode: 'bypassPermissions', allowTools: ['mcp__gmail__send_email', 'Read'] })).toEqual({ applied: true });
        await expect(pending).resolves.toMatchObject({ behavior: 'allow' });
        expect(t.agentState().completedRequests?.plan_1).toMatchObject({ status: 'approved', mode: 'default', allowTools: ['Read'] });
    });
});
