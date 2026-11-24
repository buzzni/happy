/**
 * aplus-dev-studio specs/work-machine-migration — the agent CLI status Studio
 * reads on page open, focus and dialog open: `agent-login-status` (Claude,
 * Codex and Grok login) and `codex-cli-status` (Codex version, login and
 * `codex debug models`).
 *
 * Studio used to send both through `bash`. A work machine counts every `bash`
 * as new work, so a Claude conversation's page alone recorded a migrated
 * machine's first execution. Here the programs are fixed; the caller chooses
 * only whether the login probe also checks Codex and Grok. Both answer in the
 * `bash` reply shape (`success`, `stdout`, `stderr`) with the markers Studio's
 * parsers already read.
 *
 * The login probe is web-ui `src/lib/sync/agentLoginProbe.ts`
 * COMMON_PROBE_SCRIPT and OTHER_PROBE_SCRIPT, kept byte for byte; it reads the
 * managed Claude env markers, `claude auth status --json`, the Claude OAuth
 * token, `cswap list --json`, `codex login status`, `grok models` and
 * `happy --help`.
 */
import type { MetadataDeps } from './machineMetadataMethods';
import { CSWAP_ENV_SCRIPT } from './machineAiUsage';
import { sanitizeChildEnv } from '@/utils/childEnv';

export const AGENT_LOGIN_STATUS_METHOD = 'agent-login-status';
export const CODEX_CLI_STATUS_METHOD = 'codex-cli-status';

const CLAUDE_MANAGED_MARKER = 'zai';
const CLAUDE_CREDENTIAL_MARKER = '__AP_CLAUDE_CREDENTIAL_READY__';
const HAPPY_GROK_READY_MARKER = '__AP_HAPPY_GROK_READY__';
const COMMON_PROBE_SCRIPT = `
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os')
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
const readJsonFromText = text => { try { return JSON.parse(text) } catch { return null } }
const run = (bin, args, env) => { const result = cp.spawnSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, shell: process.platform === 'win32', env: env || process.env }); return { ok: result.status === 0 && !result.error, stdout: String(result.stdout || ''), stderr: String(result.stderr || ''), error: result.error } }
const section = (name, value) => { process.stdout.write('__AP_' + name + '_BEGIN__\\n' + value + '\\n__AP_' + name + '_END__\\n') }
const home = os.homedir()
const happyHome = process.env.HAPPY_HOME_DIR || path.join(home, '.happy')
const hasContent = file => { try { return fs.statSync(file).size > 0 } catch { return false } }
const managed = hasContent(path.join(happyHome, 'zai-claude-env.json')) && hasContent(path.join(happyHome, 'trial-ai-credential-leases.json'))
const hasOAuthToken = () => Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN || readJson(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), '.credentials.json'))?.claudeAiOauth?.accessToken)
${CSWAP_ENV_SCRIPT}
const hasUsableSwapAccount = () => { const result = run('cswap', ['list', '--json'], cswapEnv); if (!result.ok) return false; const data = readJsonFromText(result.stdout); if (data?.error || !Array.isArray(data?.accounts)) return false; return data.accounts.some(account => account && typeof account === 'object' && account.disabled !== true && (!account.usageStatus || account.usageStatus === 'ok' || (typeof account.email === 'string' && /^managed-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@setup-token\\.local$/.test(account.email) && !['token_expired', 'relogin_required', 'authentication_failed'].includes(account.usageStatus)))) }
const claudeCandidates = process.platform === 'win32' ? ['claude'] : ['claude', path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude')].filter((value, index, values) => index === 0 || fs.existsSync(value))
const claudeStatus = () => { let installed = false; for (const bin of claudeCandidates) { const result = run(bin, ['auth', 'status', '--json']); if (!result.error || result.error.code !== 'ENOENT') installed = true; const parsed = readJsonFromText(result.stdout); if (parsed && typeof parsed.loggedIn === 'boolean') return { installed: true, loggedIn: parsed.loggedIn } } return { installed, loggedIn: null } }
const claudeProbe = claudeStatus()
const claudeLogin = claudeProbe.loggedIn
const claudeInstalled = claudeProbe.installed
const claudeAvailable = managed || claudeLogin === true || (claudeInstalled && (hasOAuthToken() || hasUsableSwapAccount()))
section('CLAUDE_MANAGED', managed ? '${CLAUDE_MANAGED_MARKER}' : '')
section('CLAUDE_CREDENTIAL', claudeAvailable ? '${CLAUDE_CREDENTIAL_MARKER}' : '')
section('CLAUDE', JSON.stringify({ loggedIn: claudeAvailable ? true : claudeLogin === false ? false : null }))
`

const OTHER_PROBE_SCRIPT = `
const codex = run('codex', ['login', 'status'])
section('CODEX', codex.stdout + codex.stderr)
const grok = run('grok', ['models'])
const grokMissing = grok.error?.code === 'ENOENT' || /not found|not recognized/i.test(grok.stderr)
const happy = grokMissing ? { stdout: '' } : run('happy', ['--help'])
section('GROK', grok.stdout + grok.stderr + (happy.stdout.includes('happy grok') ? '\\n${HAPPY_GROK_READY_MARKER}' : ''))
`

export const CLAUDE_LOGIN_PROBE_SCRIPT = COMMON_PROBE_SCRIPT;
export const AGENT_LOGIN_PROBE_SCRIPT = `${COMMON_PROBE_SCRIPT}${OTHER_PROBE_SCRIPT}`;

type Answer = { success: boolean; stdout: string; stderr: string };

/** The `bash` RPC's default timeout, which bounded these probes before. */
const PROBE_TIMEOUT_MS = 30_000;
const CODEX_COMMAND_TIMEOUT_MS = 10_000;

export function createAgentLoginStatusHandler(deps: { runFile: MetadataDeps['runFile']; nodePath: string }): (params: unknown) => Promise<Answer> {
    return async (params) => {
        const includeOtherAgents = (params as { includeOtherAgents?: unknown } | null)?.includeOtherAgents === true;
        try {
            const result = await deps.runFile(deps.nodePath, ['-e', includeOtherAgents ? AGENT_LOGIN_PROBE_SCRIPT : CLAUDE_LOGIN_PROBE_SCRIPT], {
                // The same environment the `bash` RPC gave this probe.
                env: sanitizeChildEnv(process.env, { boundary: 'session' }),
                timeoutMs: PROBE_TIMEOUT_MS,
            });
            return { success: result.code === 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
            return { success: false, stdout: '', stderr: error instanceof Error ? error.message : 'Probe could not start' };
        }
    };
}

export function createCodexCliStatusHandler(deps: { runFile: MetadataDeps['runFile'] }): (params: unknown) => Promise<Answer> {
    const codex = async (args: string[]) => {
        try {
            return await deps.runFile('codex', args, { env: sanitizeChildEnv(process.env, { boundary: 'session' }), timeoutMs: CODEX_COMMAND_TIMEOUT_MS });
        } catch (error) {
            if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
            return { code: 1, stdout: '', stderr: '' };
        }
    };
    return async () => {
        const version = await codex(['--version']);
        if (!version) return { success: true, stdout: '__AP_STATUS:not-installed\n', stderr: '' };
        const login = await codex(['login', 'status']);
        const models = await codex(['debug', 'models']);
        const firstLine = `${version.stdout}${version.stderr}`.split('\n')[0];
        return {
            success: true,
            stderr: '',
            stdout: `__AP_STATUS:installed\n__AP_VERSION:${firstLine}\n`
                + `__AP_LOGIN_BEGIN__\n${login ? login.stdout + login.stderr : ''}\n__AP_LOGIN_END__\n`
                // Only stdout, as the shell probe's `2>/dev/null`.
                + `__AP_MODELS_BEGIN__\n${models?.stdout ?? ''}\n__AP_MODELS_END__\n`,
        };
    };
}
