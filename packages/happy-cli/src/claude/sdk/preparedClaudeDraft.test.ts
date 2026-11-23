import { describe, expect, it } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { matchPreparedClaudeOptions } from './preparedClaudeDraft';

const scope = { cwd: '/qa/project', installRoot: '/qa/happy' };
const settings = { permissions: { deny: ['Bash(killall:*)'] } };
const startup: Options = { includePartialMessages: true, promptSuggestions: true, env: { CLAUDE_CONFIG_DIR: '/qa/claude' }, settings };
const expected: Options = { ...startup, cwd: scope.cwd, model: 'sonnet', effort: 'high', permissionMode: 'bypassPermissions',
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'test instructions' }, allowedTools: ['mcp__happy__change_title'],
    env: { ...startup.env, SAYCODE_MCP_BEARER: 'e'.repeat(64), CLAUDE_CODE_HOST_SESSION_ID: 'fixture-session',
        APLUS_SESSION_ID: 'fixture-session', APLUS_SESSION_URL: 'https://qa.example/session/fixture-session' },
    mcpServers: { happy: { type: 'http', url: 'http://127.0.0.1:4242/', headers: { Authorization: 'Bearer ${SAYCODE_MCP_BEARER}' } } },
};

describe('Claude draft launch matching', () => {
    it('moves the new prompt settings and authenticated loopback MCP to the claim and keeps existing deny rules', () => {
        const claim = matchPreparedClaudeOptions(startup, expected, scope);
        expect(claim).toMatchObject({ options: { model: 'sonnet', permissionMode: 'bypassPermissions', appendSystemPrompt: 'test instructions',
            cwd: scope.cwd, env: { CLAUDE_CODE_HOST_SESSION_ID: 'fixture-session' }, settings: {
                effortLevel: 'high', permissions: { deny: ['Bash(killall:*)'], allow: ['mcp__happy__change_title'] },
                env: { APLUS_SESSION_ID: 'fixture-session', APLUS_SESSION_URL: 'https://qa.example/session/fixture-session' },
            } }, requiredMcp: ['happy'], mcpServers: { happy: { type: 'http', url: 'http://127.0.0.1:4242/',
                headers: { Authorization: `Bearer ${'e'.repeat(64)}` } } } });
        expect(claim?.options.env).not.toHaveProperty('SAYCODE_MCP_BEARER');
    });

    it.each<Partial<Options>>([
        { cwd: '/qa/another-project' }, { resume: 'old-session' }, { settings: {} },
        { allowedTools: ['Bash'] }, { disallowedTools: ['Write'] }, { systemPrompt: 'custom system prompt' },
        { env: { ...expected.env, CLAUDE_CONFIG_DIR: '/qa/unrelated-account' } },
        { env: { ...expected.env, APLUS_SESSION_URL: 'https://qa.example/session/other' } },
        { env: { ...expected.env, APLUS_SESSION_URL: 'https://qa.example/session/fixture-session?secret=1' } },
        { mcpServers: { happy: { type: 'http', url: 'http://localhost:4242/', headers: { Authorization: 'Bearer ${SAYCODE_MCP_BEARER}' } } } },
    ])('requires the existing launch for an unmatched option (%j)', changes => {
        expect(matchPreparedClaudeOptions(startup, { ...expected, ...changes }, scope)).toBeUndefined();
    });
});
