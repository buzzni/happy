import { describe, expect, it, vi } from 'vitest';
import type { QueryOptions } from '@/claude/sdk';
import { APP_PROFILE_ENV, appProfileSeed, applyAppProfile, consumeAppProfileSeed, parseAppProfile } from './appProfile';

const profile = { version: 1 as const, mcpServers: ['shopping'], systemPrompt: '너는 쇼핑 도우미다.' };

describe('parseAppProfile', () => {
    it('accepts a version 1 profile with server names and a prompt', () => {
        expect(parseAppProfile(profile)).toEqual(profile);
        expect(parseAppProfile(undefined)).toBeUndefined();
    });

    it.each([
        ['a non-object', 'shopping'],
        ['another version', { ...profile, version: 2 }],
        ['no servers', { ...profile, mcpServers: [] }],
        ['a server name that could reach another prefix', { ...profile, mcpServers: ['shop__ping'] }],
        ['a server name with spaces', { ...profile, mcpServers: ['my shop'] }],
        ['a repeated server', { ...profile, mcpServers: ['shopping', 'shopping'] }],
        ['too many servers', { ...profile, mcpServers: Array.from({ length: 21 }, (_, i) => `s${i}`) }],
        ['a missing prompt', { version: 1, mcpServers: ['shopping'] }],
        ['an empty prompt, which would bring back the default system prompt', { ...profile, systemPrompt: '' }],
        ['an oversized prompt', { ...profile, systemPrompt: 'x'.repeat(20_001) }],
        ['an unknown field', { ...profile, allowBash: true }],
    ])('refuses %s', (_label, value) => {
        expect(() => parseAppProfile(value)).toThrow(/App profile/);
    });
});

describe('app profile seed', () => {
    it('passes the profile to the child once and removes it from the environment', () => {
        const env: NodeJS.ProcessEnv = { ...appProfileSeed(profile) };
        expect(Object.keys(env)).toEqual([APP_PROFILE_ENV]);
        expect(consumeAppProfileSeed(env)).toEqual(profile);
        expect(env[APP_PROFILE_ENV]).toBeUndefined();
        expect(consumeAppProfileSeed(env)).toBeNull();
    });

    it('fails a malformed seed instead of running without the profile', () => {
        expect(() => consumeAppProfileSeed({ [APP_PROFILE_ENV]: '{"version":1}' })).toThrow(/App profile/);
    });
});

describe('applyAppProfile', () => {
    const canCallTool = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }));
    const base: QueryOptions = {
        mcpServers: { happy: { type: 'stdio', command: 'happy' }, shopping: { type: 'http', url: 'https://shop/mcp' }, 'aplus-common': { type: 'http', url: 'https://common/mcp' } } as any,
        permissionMode: 'bypassPermissions',
        customSystemPrompt: 'saycode prompt',
        appendSystemPrompt: 'title instructions',
        allowedTools: ['Bash', 'mcp__happy__change_title'],
        disallowedTools: ['WebFetch'],
        settingSources: ['user', 'project', 'local'],
        plugins: [{ type: 'local', path: '/plugins/memory' }] as any,
        agents: { worker: { description: 'd', prompt: 'p' } } as any,
        skills: 'all',
        promptSuggestions: true,
        canCallTool,
    };

    it('keeps only the profile servers, no built-in tools and only their tools allowed', () => {
        const options = applyAppProfile(base, profile);

        expect(options.tools).toEqual([]);
        expect(Object.keys(options.mcpServers ?? {})).toEqual(['shopping']);
        expect(options.strictMcpConfig).toBe(true);
        expect(options.allowedTools).toEqual(['mcp__shopping__*']);
        expect(options.disallowedTools).toBeUndefined();
        expect(options.permissionMode).toBe('default');
    });

    it('replaces the system prompt and loads no settings, plugins, agents, skills or memory', () => {
        const options = applyAppProfile(base, profile);

        expect(options.isolatedAutomationContext).toBe(true);
        expect(options.disabledPlugins).toEqual(expect.arrayContaining(['cc-plugin-agents-md@builtin', 'cc-plugin-plugin-authoring@builtin']));

        expect(options.customSystemPrompt).toBe('너는 쇼핑 도우미다.');
        expect(options.appendSystemPrompt).toBeUndefined();
        expect(options.settingSources).toEqual([]);
        expect(options.plugins).toBeUndefined();
        expect(options.agents).toBeUndefined();
        expect(options.skills).toEqual([]);
        expect(options.promptSuggestions).toBe(false);
    });

    it('refuses any tool outside the profile servers without asking anyone', async () => {
        const options = applyAppProfile(base, profile);
        const signal = new AbortController().signal;

        for (const tool of ['Bash', 'Read', 'mcp__happy__change_title', 'mcp__shoppingx__search', 'mcp__aplus-common__get_common_skill']) {
            await expect(options.canCallTool!(tool, {}, { signal, toolUseID: 't' } as any)).resolves.toMatchObject({ behavior: 'deny' });
        }
        expect(canCallTool).not.toHaveBeenCalled();
        await options.canCallTool!('mcp__shopping__search_products', { query: 'x' }, { signal, toolUseID: 't' } as any);
        expect(canCallTool).toHaveBeenCalledOnce();
    });
});
