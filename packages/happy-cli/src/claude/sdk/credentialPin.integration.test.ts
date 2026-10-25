import { afterEach, describe, expect, it } from 'vitest';
import { query as sdkQuery, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryWithPinnedCredential } from './credentialPin';

// Explicit real-SDK opt-in. All credentials, HOME, hooks, policies and HTTP traffic are local fixtures.
const enabled = process.env.HAPPY_CLAUDE_AUTH_PIN_INTEGRATION === '1';
const TOKEN = 'sk-ant-oat01-fixture-personal-auth-pin';
let root: string, server: Server | undefined, q: Query | undefined;
let children: ChildProcess[] = [];
afterEach(async () => {
    q?.close(); q = undefined;
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
        const stopped = await Promise.race([new Promise<boolean>(r => child.once('exit', () => r(true))), new Promise<boolean>(r => setTimeout(() => r(false), 3000))]);
        if (!stopped) { child.kill('SIGKILL'); throw new Error('owned SDK process did not exit'); }
    }
    children = [];
    if (server) await new Promise<void>(r => server!.close(() => r())); server = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
});
describe.skipIf(!enabled)('real SDK credential pin with project rules', () => {
    async function prepare(managedConflict: boolean | 'reload' = false) {
        root = mkdtempSync(join(tmpdir(), 'happy-auth-pin-'));
        const home = join(root, 'home'), config = join(home, '.claude'), project = join(root, 'project');
        mkdirSync(config, { recursive: true }); mkdirSync(join(project, '.claude'), { recursive: true });
        const policyPath = join(root, 'managed-settings.json');
        const received: Array<{ owned: boolean; key: boolean; body: Record<string, any> }> = [];
        server = createServer(async (req, res) => {
            let text = ''; for await (const chunk of req) text += chunk;
            received.push({ owned: req.headers.authorization === `Bearer ${TOKEN}`, key: !!req.headers['x-api-key'], body: JSON.parse(text) });
            const result = { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'fixture result' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
            if (!JSON.parse(text).stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); return; }
            if (managedConflict === 'reload') {
                // The first model request is already in flight. Reload a mandatory auth policy
                // while the fake endpoint holds its answer; the ConfigChange guard must end it.
                writeFileSync(policyPath, JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-new-managed-token' } }));
                await new Promise(() => {});
                return;
            }
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            for (const event of [
                { type: 'message_start', message: { ...result, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
                { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture result' } },
                { type: 'content_block_stop', index: 0 },
                { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
                { type: 'message_stop' },
            ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            res.end();
        });
        await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
        const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const hooksPath = join(root, 'hooks.txt');
        const settings = (source: string) => ({
            apiKeyHelper: 'printf fixture-wrong-helper',
            env: { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '0', ANTHROPIC_API_KEY: 'fixture-wrong-key', ANTHROPIC_AUTH_TOKEN: 'fixture-wrong-auth', ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer fixture-wrong-header', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-wrong-oauth', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', [`KEEP_${source}`]: 'yes' },
            permissions: { deny: [`Bash(${source}-denied)`] },
            hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `printf '${source}\\n' >> '${hooksPath}'` }] }] },
        });
        const files = [join(config, 'settings.json'), join(project, '.claude/settings.json'), join(project, '.claude/settings.local.json')];
        files.forEach((path, i) => writeFileSync(path, JSON.stringify(settings(['user', 'project', 'local'][i]))));
        writeFileSync(join(project, 'CLAUDE.md'), 'PROJECT_RULE_AUTH_PIN_729: obey this project rule.');
        writeFileSync(join(config, 'CLAUDE.md'), 'USER_RULE_AUTH_PIN_729: obey this user rule.');
        writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: { [project]: { hasTrustDialogAccepted: true } } }));
        writeFileSync(policyPath, JSON.stringify(managedConflict === 'reload' ? { permissions: { deny: ['Bash(policy-denied)'] } } : { env: { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-managed-token' } }));
        const env = {
            PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
            ANTHROPIC_BASE_URL: baseUrl, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',

        };
        const args: string[][] = [];
        const options = {
            cwd: project, env, settingSources: ['user', 'project', 'local'] as const,
            pathToClaudeCodeExecutable: process.env.HAPPY_CLAUDE_AUTH_PIN_BINARY,
            persistSession: false, model: 'claude-sonnet-4-6', tools: [], maxTurns: 2,
            spawnClaudeCodeProcess(opts: { command: string; args: string[]; cwd?: string; env: NodeJS.ProcessEnv }) {
                args.push(opts.args);
                // Production builds ignore managed-path env overrides. A private Linux mount/PID
                // namespace supplies the actual policy path without changing the host's /etc.
                const command = managedConflict ? 'bwrap' : opts.command;
                const argv = managedConflict ? ['--ro-bind', '/', '/', '--tmpfs', '/etc', '--ro-bind', '/etc/passwd', '/etc/passwd', '--ro-bind', root, '/etc/claude-code', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--', opts.command, ...opts.args] : opts.args;
                const child = spawn(command, argv, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child); return child;
            },
        };
        return { received, options: { ...options, settingSources: [...options.settingSources] }, hooksPath, files, settings, args };
    }
    it.each(['default', 'explicit'] as const)('keeps CLAUDE.md, hooks and deny rules through two personal requests (%s sources)', async sources => {
        const f = await prepare(); const originals = f.files.map(path => readFileSync(path, 'utf8'));
        let next!: () => void; const nextInput = new Promise<void>(r => { next = r; });
        async function* prompt(): AsyncGenerator<SDKUserMessage> {
            yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'first-personal-probe' } };
            await nextInput;
            yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'second-personal-probe' } };
            await new Promise(() => {});
        }
        q = queryWithPinnedCredential(sdkQuery, { prompt: prompt(), options: { ...f.options, settingSources: sources === 'default' ? undefined : f.options.settingSources, debugFile: join(root, 'sdk-debug.log') } }, TOKEN);
        expect((await q.initializationResult()).account.apiKeySource).not.toBe('ANTHROPIC_API_KEY');
        let results = 0; let liveRules: string[] = []; let liveEnv: Record<string,string> = {};
        for await (const message of q) if (message.type === 'result') {
            expect(message.is_error).toBe(false); results++;
            if (results === 1) {
                // Simulate an auth edit between requests; flag auth remains pinned.
                writeFileSync(f.files[1], JSON.stringify({ ...f.settings('project'), apiKeyHelper: 'printf edited-wrong-helper' }));
                next();
            } else {
                const controls = q as Query & { listPermissionRules(): Promise<{ state: { rules: Array<{ rule: string }> } }>; getSettings(): Promise<{ effective: { env: Record<string, string> } }> };
                liveRules = (await controls.listPermissionRules()).state.rules.map(r => r.rule);
                liveEnv = (await controls.getSettings()).effective.env;
                break;
            }
        }
        expect(results).toBe(2);
        expect(f.received.length).toBeGreaterThanOrEqual(2);
        expect(f.received.every(r => r.owned && !r.key)).toBe(true);
        const prompts = f.received.map(r => JSON.stringify(r.body.messages?.filter((m: any) => m.role === 'user').at(-1)?.content));
        expect(prompts.filter(p => p?.includes('first-personal-probe'))).toHaveLength(1);
        expect(prompts.filter(p => p?.includes('second-personal-probe'))).toHaveLength(1);
        expect(f.received.some(r => JSON.stringify(r.body).includes('PROJECT_RULE_AUTH_PIN_729'))).toBe(true);
        expect(f.received.some(r => JSON.stringify(r.body).includes('USER_RULE_AUTH_PIN_729'))).toBe(true);
        expect(readFileSync(f.hooksPath, 'utf8')).toContain('user');
        expect(readFileSync(f.hooksPath, 'utf8')).toContain('project');
        expect(readFileSync(f.hooksPath, 'utf8')).toContain('local');
        expect(liveRules).toEqual(expect.arrayContaining(['Bash(user-denied)', 'Bash(project-denied)', 'Bash(local-denied)']));
        expect(liveEnv).toMatchObject({ KEEP_user: 'yes', KEEP_project: 'yes', KEEP_local: 'yes' });
        expect(f.args.flat().some(arg => arg.includes(TOKEN))).toBe(false);
        const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : entry.isFile() ? [join(dir, entry.name)] : []);
        expect(files(root).some(path => readFileSync(path).includes(TOKEN))).toBe(false);
        expect(readFileSync(f.files[0], 'utf8')).toBe(originals[0]); expect(readFileSync(f.files[2], 'utf8')).toBe(originals[2]);
    }, 30_000);
    it.skipIf(process.platform !== 'linux').each([false, true])('ends an in-flight personal generation when managed policy changes (disableAllHooks=%s)', async disableHooks => {
        const f = await prepare('reload');
        async function* prompt(): AsyncGenerator<SDKUserMessage> {
            yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'one-before-policy-change' } };
            await new Promise(() => {});
        }
        q = queryWithPinnedCredential(sdkQuery, { prompt: prompt(), options: { ...f.options, settings: { disableAllHooks: disableHooks } } }, TOKEN);
        await expect((async () => { for await (const _ of q!) {} })()).rejects.toThrow('CLAUDE_PERSONAL_AUTH_NOT_VERIFIED');
        expect(f.received).toHaveLength(1); expect(f.received[0].owned).toBe(true);
    }, 30_000);
    it.skipIf(process.platform !== 'linux')('refuses a conflicting managed policy before any prompt reaches the fake endpoint', async () => {
        const f = await prepare(true);
        let send!: () => void; const ready = new Promise<void>(r => { send = r; });
        async function* prompt(): AsyncGenerator<SDKUserMessage> { await ready; yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'must-not-send' } }; }
        q = queryWithPinnedCredential(sdkQuery, { prompt: prompt(), options: f.options }, TOKEN);
        await q.initializationResult();
        const live = await (q as Query & { getSettings(): Promise<{ sources: Array<{source:string}>, effective:{env:Record<string,string>} }> }).getSettings();
        expect(live.sources.some(s => s.source === 'policySettings')).toBe(true);
        expect(live.effective.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fixture-managed-token');
        send();
        await expect((async () => { for await (const _ of q!) {} })()).rejects.toThrow('CLAUDE_PERSONAL_AUTH_NOT_VERIFIED');
        expect(f.received).toEqual([]);
    }, 30_000);
});
