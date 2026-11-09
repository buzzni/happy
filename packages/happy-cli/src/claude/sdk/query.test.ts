import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sdkQuery = vi.hoisted(() => vi.fn(() => ({ mocked: true })));
const pinnedQuery = vi.hoisted(() => vi.fn(() => ({ pinned: true })));
const pinnedEndpointQuery = vi.hoisted(() => vi.fn(() => ({ pinnedEndpoint: true })));
vi.mock('./credentialPin', () => ({ queryWithPinnedCredential: pinnedQuery, queryWithPinnedEndpoint: pinnedEndpointQuery }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
    query: sdkQuery,
}));

import { query } from './query';

describe('query adapter', () => {
    let configDirectory: string;
    beforeEach(() => {
        sdkQuery.mockClear();
        pinnedQuery.mockClear();
        pinnedEndpointQuery.mockClear();
        vi.stubEnv('HAPPY_AI_AUTH_SOURCE', undefined);
        vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', undefined);
        configDirectory = mkdtempSync(join(tmpdir(), 'happy-plugin-config-'));
        vi.stubEnv('CLAUDE_CONFIG_DIR', configDirectory);
        vi.stubEnv('HAPPY_CLAUDE_PATH', undefined);
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(configDirectory, { recursive: true, force: true });
    });

    function lastOptions(): Record<string, unknown> {
        return (sdkQuery.mock.calls as unknown as [{ options: Record<string, unknown> }][]).at(-1)![0].options;
    }

    it('disables native automatic memory for an isolated run while preserving explicit tools and permission hooks', () => {
        const settingsPath = join(configDirectory, 'isolated-hooks.json');
        const hooks = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'trusted-policy-hook' }] }] };
        writeFileSync(settingsPath, JSON.stringify({ hooks, autoMemoryEnabled: true,
            env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0', KEEP_SETTING: 'value' } }));
        vi.stubEnv('CLAUDE_CODE_DISABLE_AUTO_MEMORY', '0');
        const mcpServers = { approved: { command: 'approved-mcp' } };
        query({ prompt: 'this occurrence', options: { isolatedAutomationContext: true,
            settingsPath, settingSources: ['user', 'project'], mcpServers, resume: 'own-run-continuation' } });
        const options = lastOptions();
        expect(options).toMatchObject({ settingSources: [], strictMcpConfig: true, mcpServers, resume: 'own-run-continuation',
            env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_MEMORY_RECALL_OWNER: 'host', CLAUDE_MEMORY_LESSON_OWNER: 'host' } });
        expect(JSON.parse(options.settings as string)).toMatchObject({ autoMemoryEnabled: false, hooks,
            env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', KEEP_SETTING: 'value' } });
        expect(process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('0');
        expect(JSON.parse(readFileSync(settingsPath, 'utf8')).autoMemoryEnabled).toBe(true);
    });

    it('pins the assigned organization token on every query, including resume and title calls', () => {
        vi.stubEnv('HAPPY_AI_AUTH_SOURCE', 'org-bundle');
        for (const token of ['fixture-first-generation', 'fixture-next-generation']) {
            vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', token);
            query({ prompt: 'continue', options: { resume: 'session', settingSources: ['user', 'project'], model: 'claude-opus-5-5' } });
            expect(pinnedQuery).toHaveBeenLastCalledWith(sdkQuery, expect.objectContaining({
                options: expect.objectContaining({ resume: 'session', settingSources: ['user', 'project'], env: expect.objectContaining({ CLAUDE_CODE_OAUTH_TOKEN: token }) }),
            }), token, 'organization');
        }
        expect(sdkQuery).not.toHaveBeenCalled();
    });

    // aplus specs/org-llm-endpoints r2 — an endpoint session is pinned after the settings files load too.
    describe('organization LLM endpoint session', () => {
        const endpointEnvironment = {
            HAPPY_AI_AUTH_SOURCE: 'org-endpoint', ANTHROPIC_BASE_URL: 'https://llm.corp.example', ANTHROPIC_AUTH_TOKEN: 'corp-token',
            ANTHROPIC_MODEL: 'corp-model', ANTHROPIC_DEFAULT_OPUS_MODEL: 'corp-big', ANTHROPIC_DEFAULT_SONNET_MODEL: 'corp-model',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'corp-small', ANTHROPIC_DEFAULT_FABLE_MODEL: 'corp-big',
        };
        beforeEach(() => { for (const [key, value] of Object.entries(endpointEnvironment)) vi.stubEnv(key, value); });

        it('goes through the endpoint pin with the daemon environment on every query, resume and title call included', () => {
            for (const options of [{ resume: 'session', settingSources: ['user', 'project'] as ('user' | 'project')[] }, undefined]) {
                query({ prompt: 'continue', options });
                expect(pinnedEndpointQuery).toHaveBeenLastCalledWith(sdkQuery, expect.objectContaining({
                    options: expect.objectContaining({ env: expect.objectContaining(endpointEnvironment) }),
                }), expect.objectContaining(endpointEnvironment));
            }
            expect(sdkQuery).not.toHaveBeenCalled();
            expect(pinnedQuery).not.toHaveBeenCalled();
        });

        it('folds the requested model onto the endpoint names and drops the fallback model before the SDK sees them', () => {
            query({ prompt: 'hello', options: { model: 'claude-opus-5-5', fallbackModel: 'haiku' } });
            expect(pinnedEndpointQuery.mock.calls.at(-1)).toBeDefined();
            const options = (pinnedEndpointQuery.mock.calls.at(-1) as unknown as [unknown, { options: Record<string, unknown> }])[1].options;
            expect(options).toMatchObject({ model: 'corp-model' });
            // An endpoint has no second model to fall back to, and the SDK refuses a fallback equal to the main model
            // (which folding produces whenever the endpoint maps no tiers).
            expect(options.fallbackModel).toBeUndefined();
        });

        it.each(['claude-sonnet-5', 'sonnet', 'corp-model', 'corp-small'])('never hands the SDK a fallback model equal to the main one (%s)', fallback => {
            query({ prompt: 'hello', options: { model: 'claude-opus-5-5', fallbackModel: fallback } });
            const options = (pinnedEndpointQuery.mock.calls.at(-1) as unknown as [unknown, { options: Record<string, unknown> }])[1].options;
            expect(options.fallbackModel).toBeUndefined();
        });

        // The pin applies its flag layer after Claude Code started; the settings files' env is read at startup (telemetry
        // is initialised from it), so the startup flag layer must carry the closed routes too — token excluded.
        it('starts Claude Code with the closed routes in the flag settings even without a hook settings file, never the token', () => {
            query({ prompt: 'hello' });
            const options = (pinnedEndpointQuery.mock.calls.at(-1) as unknown as [unknown, { options: { settings?: string } }])[1].options;
            const settings = JSON.parse(options.settings!);
            expect(settings.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://llm.corp.example', ANTHROPIC_MODEL: 'corp-model', CLAUDE_CODE_ENABLE_TELEMETRY: '', ANTHROPIC_UNIX_SOCKET: '' });
            expect(options.settings).not.toContain('corp-token');
        });

        it('holds the machine\'s own proxy and TLS trust above the settings files, empty where it has none', () => {
            vi.stubEnv('HTTPS_PROXY', 'http://proxy.corp.example:3128');
            for (const key of ['HTTP_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS']) vi.stubEnv(key, undefined);
            query({ prompt: 'hello' });
            const options = (pinnedEndpointQuery.mock.calls.at(-1) as unknown as [unknown, { options: { settings?: string } }])[1].options;
            expect(JSON.parse(options.settings!).env).toMatchObject({ HTTPS_PROXY: 'http://proxy.corp.example:3128', HTTP_PROXY: '', ALL_PROXY: '', https_proxy: '',
                NODE_TLS_REJECT_UNAUTHORIZED: '', NODE_EXTRA_CA_CERTS: '' });
        });

        it('keeps loopback off the proxy in the layer that outranks the SDK\'s own environment, the machine\'s exceptions included', () => {
            vi.stubEnv('HTTPS_PROXY', 'http://proxy.corp.example:3128');
            vi.stubEnv('NO_PROXY', '.corp.example');
            vi.stubEnv('no_proxy', undefined);
            query({ prompt: 'hello' });
            const options = (pinnedEndpointQuery.mock.calls.at(-1) as unknown as [unknown, { options: { settings?: string } }])[1].options;
            const env = JSON.parse(options.settings!).env;
            expect(env.NO_PROXY).toBe('.corp.example,127.0.0.1,localhost,::1');
            expect(env.no_proxy).toBe(env.NO_PROXY);
        });

        it('adds the closed routes to a hook settings file\'s own env and keeps its hooks', () => {
            const settingsPath = join(configDirectory, 'hooks.json');
            const hooks = { SessionStart: [{ matcher: '*' }] };
            writeFileSync(settingsPath, JSON.stringify({ hooks, env: { KEEP: 'yes', ANTHROPIC_MODEL: 'corp-model' } }));
            query({ prompt: 'hello', options: { settingsPath } });
            const options = (pinnedEndpointQuery.mock.calls.at(-1) as unknown as [unknown, { options: { settings?: string } }])[1].options;
            expect(JSON.parse(options.settings!)).toMatchObject({ hooks, env: { KEEP: 'yes', ANTHROPIC_MODEL: 'corp-model', CLAUDE_CODE_ENABLE_TELEMETRY: '' } });
        });

        it('leaves the settings of every other source as they were', () => {
            vi.stubEnv('HAPPY_AI_AUTH_SOURCE', 'org-bundle');
            query({ prompt: 'hello' });
            expect(lastOptions().settings).toBeUndefined();
        });

        it('leaves a query with no model naming none, for the pinned environment to answer', () => {
            query({ prompt: 'hello' });
            const options = (pinnedEndpointQuery.mock.calls.at(-1) as unknown as [unknown, { options: Record<string, unknown> }])[1].options;
            expect(options.model).toBeUndefined();
        });

        it('keeps every other source off the endpoint pin and its model untouched', () => {
            vi.stubEnv('HAPPY_AI_AUTH_SOURCE', 'org-bundle');
            query({ prompt: 'hello', options: { model: 'claude-opus-5-5' } });
            expect(pinnedEndpointQuery).not.toHaveBeenCalled();
            expect(lastOptions().model).toBe('claude-opus-5-5');
        });

        it('leaves every other source\'s fallback model alone', () => {
            vi.stubEnv('HAPPY_AI_AUTH_SOURCE', 'org-bundle');
            query({ prompt: 'hello', options: { model: 'claude-opus-5-5', fallbackModel: 'claude-sonnet-5' } });
            expect(lastOptions().fallbackModel).toBe('claude-sonnet-5');
        });
    });

    it.each(['personal-subscription', 'org-bundle-observed', undefined])('keeps ordinary token source %s on the existing route', source => {
        vi.stubEnv('HAPPY_AI_AUTH_SOURCE', source);
        vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'fixture-token');
        query({ prompt: 'hello' });
        expect(pinnedQuery).not.toHaveBeenCalled();
        expect(sdkQuery).toHaveBeenCalledOnce();
    });

    it('keeps non-OAuth organization routes and explicit personal fallback distinct', () => {
        vi.stubEnv('HAPPY_AI_AUTH_SOURCE', 'org-bundle');
        query({ prompt: 'hello' });
        expect(sdkQuery).toHaveBeenCalledOnce();
        vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'fixture-org-token');
        query({ prompt: 'hello', options: { personalClaudeAuth: { oauthToken: 'fixture-personal' } } });
        expect(pinnedQuery).toHaveBeenLastCalledWith(sdkQuery, expect.anything(), 'fixture-personal');
    });

    it('uses the SDK bundled executable unless a local path is explicitly configured', () => {
        query({ prompt: 'continue' });
        expect(lastOptions().pathToClaudeCodeExecutable).toBeUndefined();
    });

    it('resolves an explicit executable symlink and preserves resume and sandbox spawning', () => {
        const executable = join(configDirectory, 'claude');
        symlinkSync(process.execPath, executable);
        vi.stubEnv('HAPPY_CLAUDE_PATH', executable);
        const spawnClaudeCodeProcess = vi.fn();
        const sandbox = { enabled: true, failIfUnavailable: true };
        query({ prompt: 'continue', options: {
            resume: 'existing-session', model: 'claude-opus-5-5', effort: 'low',
            spawnClaudeCodeProcess, sandbox,
        } });
        const options = lastOptions();
        expect(options.pathToClaudeCodeExecutable).toBe(realpathSync(process.execPath));
        expect(options.resume).toBe('existing-session');
        expect(options.model).toBe('claude-opus-5-5');
        expect(options.effort).toBe('low');
        expect(options.spawnClaudeCodeProcess).toBe(spawnClaudeCodeProcess);
        expect(options.sandbox).toEqual(sandbox);
    });

    it('forwards a session output format to the SDK and leaves it absent otherwise', () => {
        // Saycode specs/claude-cli-benchmark-followups R2: the field was missing from this mapping,
        // so a format set upstream never reached the SDK.
        const outputFormat = { type: 'json_schema' as const, schema: { type: 'object' } };
        query({ prompt: 'continue', options: { outputFormat } });
        expect(lastOptions().outputFormat).toEqual(outputFormat);
        query({ prompt: 'continue' });
        expect(lastOptions().outputFormat).toBeUndefined();
    });

    it('forwards plugin directories to the SDK and leaves them absent otherwise', () => {
        // specs/cli-plugin-dir-and-env-scrub R5-a: a remote session's `--plugin-dir` reaches Claude only here.
        const plugins = [{ type: 'local' as const, path: '/plugins/one' }];
        query({ prompt: 'continue', options: { plugins } });
        expect(lastOptions().plugins).toEqual(plugins);
        query({ prompt: 'continue' });
        expect(lastOptions().plugins).toBeUndefined();
    });

    it('accepts a readable JavaScript CLI entrypoint without requiring native execute permissions', () => {
        const executable = join(configDirectory, 'cli.js');
        writeFileSync(executable, '// CLI entrypoint', { mode: 0o600 });
        vi.stubEnv('HAPPY_CLAUDE_PATH', executable);
        query({ prompt: 'continue' });
        expect(lastOptions().pathToClaudeCodeExecutable).toBe(realpathSync(executable));
    });

    it.each(['', 'claude', './claude', '/missing/claude', 'bad\0path'])(
        'rejects invalid explicit path %j without falling back or invoking the SDK', (path) => {
            vi.stubEnv('HAPPY_CLAUDE_PATH', path);
            expect(() => query({ prompt: 'continue' })).toThrow(/HAPPY_CLAUDE_PATH/);
            expect(sdkQuery.mock.calls.length).toBe(0);
        },
    );

    it('rejects directories and non-executable native files', () => {
        vi.stubEnv('HAPPY_CLAUDE_PATH', configDirectory);
        expect(() => query({ prompt: 'continue' })).toThrow(/HAPPY_CLAUDE_PATH/);
        if (process.platform !== 'win32') {
            const executable = join(configDirectory, 'claude');
            writeFileSync(executable, 'not executable', { mode: 0o600 });
            vi.stubEnv('HAPPY_CLAUDE_PATH', executable);
            expect(() => query({ prompt: 'continue' })).toThrow(/HAPPY_CLAUDE_PATH/);
        }
        expect(sdkQuery.mock.calls.length).toBe(0);
    });

    function writePlugin(servers: Record<string, unknown>, name = 'sales') {
        const directory = join(configDirectory, 'plugins', 'synced', 'account', name);
        mkdirSync(join(directory, '.claude-plugin'), { recursive: true });
        writeFileSync(join(directory, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }));
        const config = join(directory, '.mcp.json');
        writeFileSync(config, JSON.stringify({ mcpServers: servers }));
        return config;
    }

    function sdkSettings() {
        const calls = sdkQuery.mock.calls as unknown as Array<Array<any>>;
        return JSON.parse(calls.at(-1)![0].options.settings);
    }

    it('excludes only synced HTTP/SSE plugins with blank URLs before starting the SDK', () => {
        const config = writePlugin({
            gmail: { type: 'http', url: '' },
            calendar: { type: 'sse', url: '  \n' },
            configured: { type: 'http', url: 'https://example.com/mcp' },
            stdio: { command: 'node', args: ['server.js'] },
            missing: { type: 'http' },
        });
        const original = readFileSync(config, 'utf8');
        const mcpServers = { gmail: { type: 'http' as const, url: 'https://gateway.example/mcp' } };
        query({ prompt: 'continue', options: { mcpServers } });
        expect(sdkSettings().deniedMcpServers).toEqual([
            { serverName: 'plugin:sales:gmail' },
            { serverName: 'plugin:sales:calendar' },
        ]);
        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ mcpServers }),
        }));
        expect(readFileSync(config, 'utf8')).toBe(original);
    });

    it('preserves hook settings, existing MCP exclusions and tool deny rules', () => {
        writePlugin({ gmail: { type: 'http', url: '' } });
        const settingsPath = join(configDirectory, 'hooks.json');
        const hooks = { SessionStart: [{ matcher: '*' }] };
        writeFileSync(settingsPath, JSON.stringify({ hooks, deniedMcpServers: [{ serverName: 'blocked' }] }));
        query({ prompt: 'continue', options: { settingsPath, permissionsDeny: ['Read(/private/**)'] } });
        expect(sdkSettings()).toEqual({
            hooks,
            deniedMcpServers: [{ serverName: 'blocked' }, { serverName: 'plugin:sales:gmail' }],
            permissions: { deny: ['Read(/private/**)'] },
        });
    });

    it('allows a repaired plugin URL on the next query instead of persisting a disable flag', () => {
        writePlugin({ gmail: { type: 'http', url: '' } });
        query({ prompt: 'continue' });
        expect(sdkSettings().deniedMcpServers).toHaveLength(1);
        writePlugin({ gmail: { type: 'http', url: 'https://example.com/mcp' } });
        query({ prompt: 'continue' });
        expect(sdkQuery).toHaveBeenLastCalledWith(expect.objectContaining({
            options: expect.objectContaining({ settings: undefined }),
        }));
    });

    it('keeps usable definitions when another account caches the same server with a blank URL', () => {
        writePlugin({ gmail: { type: 'http', url: '' }, calendar: { type: 'http', url: '' } });
        const other = join(configDirectory, 'plugins', 'synced', 'other-account', 'sales');
        mkdirSync(join(other, '.claude-plugin'), { recursive: true });
        writeFileSync(join(other, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sales' }));
        writeFileSync(join(other, '.mcp.json'), JSON.stringify({
            gmail: { type: 'http', url: 'https://example.com/mcp' },
            calendar: { type: 'http', url: '' },
        }));
        query({ prompt: 'continue' });
        expect(sdkSettings().deniedMcpServers).toEqual([{ serverName: 'plugin:sales:calendar' }]);
    });

    it('does not exclude explicitly supplied servers with the same name as a synced placeholder', () => {
        writePlugin({ gmail: { type: 'http', url: '' } });
        query({ prompt: 'continue', options: { mcpServers: {
            'plugin:sales:gmail': { type: 'http', url: 'https://example.com/mcp' },
        } } });
        expect(sdkQuery).toHaveBeenLastCalledWith(expect.objectContaining({
            options: expect.objectContaining({ settings: undefined }),
        }));
    });

    it('leaves an ambiguous plugin alone when another account has custom MCP definitions', () => {
        writePlugin({ gmail: { type: 'http', url: '' } });
        const other = join(configDirectory, 'plugins', 'synced', 'other-account', 'sales', '.claude-plugin');
        mkdirSync(other, { recursive: true });
        writeFileSync(join(other, 'plugin.json'), JSON.stringify({ name: 'sales', mcpServers: './other.json' }));
        query({ prompt: 'continue' });
        expect(sdkQuery).toHaveBeenLastCalledWith(expect.objectContaining({
            options: expect.objectContaining({ settings: undefined }),
        }));
    });

    it('does not guess exclusions from malformed files or custom manifest MCP definitions', () => {
        const malformed = writePlugin({ gmail: { type: 'http', url: '' } });
        writeFileSync(malformed, '{');
        const custom = writePlugin({ gmail: { type: 'http', url: '' } }, 'custom');
        writeFileSync(join(custom, '..', '.claude-plugin', 'plugin.json'), JSON.stringify({
            name: 'custom', mcpServers: './configured-mcp.json',
        }));
        query({ prompt: 'continue' });
        expect(sdkQuery).toHaveBeenLastCalledWith(expect.objectContaining({
            options: expect.objectContaining({ settings: undefined }),
        }));
    });

    it('forwards the built-in tool allowance, including the empty list that disables them', () => {
        query({ prompt: 'continue', options: { tools: [] } });
        // 빈 배열은 "전부 끈다" 는 뜻이다. 여기서 흘리면 관리 실행의 도구 경계가
        // SDK 까지 도달하지 못한다.
        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ tools: [] }),
        }));

        sdkQuery.mockClear();
        pinnedQuery.mockClear();
        vi.stubEnv('HAPPY_AI_AUTH_SOURCE', undefined);
        vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', undefined);
        query({ prompt: 'continue', options: { tools: ['Read'] } });
        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ tools: ['Read'] }),
        }));
    });

    it('forwards prompt suggestion enablement to the Claude Agent SDK', () => {
        query({
            prompt: 'continue',
            options: { promptSuggestions: true },
        });

        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({
                promptSuggestions: true,
            }),
        }));
    });

    it('gives Claude the session scope but not lineage or spawn seeds (utils/childEnv)', () => {
        const injected = { HAPPY_RECONNECT_SESSION_ID: 'cmr-poisoned', HAPPY_INITIAL_PROMPT: 'seed', APLUS_SESSION_ID: 'self-session' }
        Object.assign(process.env, injected)
        try {
            query({ prompt: 'continue', options: {} })
            const env = lastOptions().env as Record<string, string>
            expect(env.HAPPY_RECONNECT_SESSION_ID).toBeUndefined()
            expect(env.HAPPY_INITIAL_PROMPT).toBeUndefined()
            expect(env.APLUS_SESSION_ID).toBe('self-session')
        } finally {
            for (const key of Object.keys(injected)) delete process.env[key]
        }
    });

    it('asks the CLI for its turn-over state only when the caller needs it', () => {
        query({ prompt: 'continue', options: { emitSessionStateEvents: true } });
        expect((lastOptions().env as Record<string, string>).CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe('1');

        query({ prompt: 'continue', options: {} });
        expect((lastOptions().env as Record<string, string>).CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBeUndefined();
    });

    it('enables partial assistant message streaming so the app can render tokens before a block completes', () => {
        query({ prompt: 'continue', options: {} });

        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ includePartialMessages: true }),
        }));
    });

    it('forwards additional directories to the Claude Agent SDK for new and resumed queries', () => {
        for (const resume of [undefined, 'claude-session-id']) {
            query({
                prompt: 'continue',
                options: {
                    additionalDirectories: ['/repo/frontend', '/repo/backend'],
                    resume,
                },
            });
        }

        expect(sdkQuery).toHaveBeenNthCalledWith(1, expect.objectContaining({
            options: expect.objectContaining({
                additionalDirectories: ['/repo/frontend', '/repo/backend'],
                resume: undefined,
            }),
        }));
        expect(sdkQuery).toHaveBeenNthCalledWith(2, expect.objectContaining({
            options: expect.objectContaining({
                additionalDirectories: ['/repo/frontend', '/repo/backend'],
                resume: 'claude-session-id',
            }),
        }));
    });

    it('forwards fail-closed sandbox settings to the Claude Agent SDK', () => {
        const sandbox = {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            filesystem: { denyWrite: ['/project/**/.env*'] },
        };

        query({ prompt: 'edit', options: { sandbox } });

        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ sandbox }),
        }));
    });

    it('inlines hook settings when sandbox settings must be merged by the SDK', () => {
        const directory = mkdtempSync(join(tmpdir(), 'happy-query-settings-'));
        const settingsPath = join(directory, 'settings.json');
        const hooks = { hooks: { SessionStart: [{ matcher: '*' }] } };
        writeFileSync(settingsPath, JSON.stringify(hooks));
        const sandbox = { enabled: true, failIfUnavailable: true };
        try {
            query({ prompt: 'edit', options: { settingsPath, sandbox } });

            const settings = (sdkQuery.mock.calls as unknown as Array<Array<any>>)[0][0].options.settings;
            expect(typeof settings).toBe('string');
            expect(JSON.parse(settings as string)).toEqual(hooks);
            expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
                options: expect.objectContaining({ sandbox }),
            }));
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    // SDK 의 sandbox 는 주로 Bash 실행 경계다. Read/Edit 같은 도구는 CLI 의 권한
    // 규칙으로 막아야 하므로, 공유 머신에서는 두 층을 함께 내려보낸다.
    it('merges deny rules into the inlined settings so tool reads are blocked too', () => {
        const directory = mkdtempSync(join(tmpdir(), 'happy-query-deny-'));
        const settingsPath = join(directory, 'settings.json');
        const hooks = { hooks: { SessionStart: [{ matcher: '*' }] } };
        writeFileSync(settingsPath, JSON.stringify(hooks));
        try {
            query({
                prompt: 'edit',
                options: {
                    settingsPath,
                    sandbox: { enabled: true, failIfUnavailable: true },
                    permissionsDeny: ['Read(/root/.happy/**)', 'Edit(/root/.happy/**)'],
                },
            });

            const settings = (sdkQuery.mock.calls as unknown as Array<Array<any>>)[0][0].options.settings;
            const parsed = JSON.parse(settings as string);
            expect(parsed.hooks).toEqual(hooks.hooks);
            expect(parsed.permissions.deny).toEqual([
                'Read(/root/.happy/**)',
                'Edit(/root/.happy/**)',
            ]);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    // 규칙만 있고 sandbox 가 없어도 규칙은 반드시 내려가야 한다 — 경로로 넘기면
    // SDK 가 그 파일을 읽고 우리 규칙은 사라진다.
    it('inlines settings for deny rules even without sandbox settings', () => {
        const directory = mkdtempSync(join(tmpdir(), 'happy-query-deny-only-'));
        const settingsPath = join(directory, 'settings.json');
        writeFileSync(settingsPath, JSON.stringify({}));
        try {
            query({
                prompt: 'edit',
                options: { settingsPath, permissionsDeny: ['Read(/root/.happy/**)'] },
            });

            const settings = (sdkQuery.mock.calls as unknown as Array<Array<any>>)[0][0].options.settings;
            expect(JSON.parse(settings as string).permissions.deny).toEqual(['Read(/root/.happy/**)']);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('keeps existing deny rules from the settings file', () => {
        const directory = mkdtempSync(join(tmpdir(), 'happy-query-deny-merge-'));
        const settingsPath = join(directory, 'settings.json');
        writeFileSync(settingsPath, JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }));
        try {
            query({
                prompt: 'edit',
                options: { settingsPath, permissionsDeny: ['Read(/root/.happy/**)'] },
            });

            const settings = (sdkQuery.mock.calls as unknown as Array<Array<any>>)[0][0].options.settings;
            expect(JSON.parse(settings as string).permissions.deny).toEqual([
                'Bash(rm:*)',
                'Read(/root/.happy/**)',
            ]);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
