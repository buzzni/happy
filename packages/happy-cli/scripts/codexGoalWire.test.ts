import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { codexGoalActionCapabilities, codexGoalStatusForSharedState, mapCodexGoalEventToAgentGoalStatus } from '../src/codex/codexGoalStatus';

// Execute the actual app schemas using the CLI's Zod dependency, so this contract test also runs
// after a filtered CLI-only workspace install (which does not install the mobile app dependencies).
const appSchemaSource = readFileSync(new URL('../../happy-app/sources/sync/storageTypes.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(appSchemaSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const appSchemas = {} as typeof import('../../happy-app/sources/sync/storageTypes');
Function('require', 'exports', compiled)(createRequire(import.meta.url), appSchemas);
const { AgentGoalCapabilitiesSchema, AgentGoalStatusSchema, AgentStateSchema } = appSchemas;

// The strict active-goal schema shipped before phase/resume were introduced.
const legacyActiveGoalSchema = AgentGoalStatusSchema.options[2].omit({ phase: true }).extend({
    capabilities: AgentGoalCapabilitiesSchema.omit({ resume: true }).optional(),
});
const legacyAgentStateSchema = AgentStateSchema.extend({ agentGoalStatus: legacyActiveGoalSchema.optional() });

describe('Codex goal producer and app schema compatibility', () => {
    it.each(['active', 'paused', 'blocked', 'usageLimited'])('preserves a pending approval with a %s goal', (phase) => {
        const goal = mapCodexGoalEventToAgentGoalStatus({
            type: 'thread_goal_updated',
            threadId: 'thread-1',
            goal: { objective: 'ship it', status: phase },
        }, 'thread-1', { capabilities: codexGoalActionCapabilities(true) });
        const requests = { approval: { tool: 'shell', arguments: { command: 'pwd' }, createdAt: 1 } };

        const parsed = AgentStateSchema.safeParse({ agentGoalStatus: goal, requests });

        expect(parsed.success).toBe(true);
        if (!parsed.success) throw parsed.error;
        expect(parsed.data.requests).toEqual(requests);
        expect(parsed.data.agentGoalStatus).toEqual(goal);

        const sharedGoal = codexGoalStatusForSharedState(goal!);
        const legacyState = legacyAgentStateSchema.parse({ agentGoalStatus: sharedGoal, requests });
        expect(legacyState.requests).toEqual(requests);
        expect(legacyState.agentGoalStatus).toMatchObject({
            status: 'active', text: 'ship it', capabilities: { clear: true, edit: true },
        });
        expect(sharedGoal).not.toHaveProperty('phase');
        expect(sharedGoal).not.toHaveProperty('capabilities.resume');
    });
});
