import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sanitizeChildEnv } from '@/utils/childEnv';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareCodexMultiAuthProxy } from '@/codex/codexMultiAuthProxy';

/** Resolves only the selected session's AI account. Nothing from its auth files is copied into a container. */
export async function resolveReservationNativeAuth(input: { agent: 'claude' | 'codex'; home: string; environment: Record<string, string | undefined> }, read = (file: string) => readFile(file, 'utf8')): Promise<{ baseUrl: string; headers: Record<string, string>; close(): Promise<void> }> {
  const env = input.environment;
  const done = (baseUrl: string, headers: Record<string, string>) => ({ baseUrl, headers, close: async () => {} });
  if (input.agent === 'claude') {
    const baseUrl = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    if (env.ANTHROPIC_API_KEY) return done(baseUrl, { 'x-api-key': env.ANTHROPIC_API_KEY });
    if (env.ANTHROPIC_AUTH_TOKEN) return done(baseUrl, { Authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}` });
    let token = env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!token) {
      try { const value = JSON.parse(await read(join(env.CLAUDE_CONFIG_DIR ?? join(input.home, '.claude'), '.credentials.json'))); token = value.claudeAiOauth?.accessToken; }
      catch { throw new Error('RESERVATION_SELECTED_AI_AUTH_UNAVAILABLE'); }
    }
    if (!token || typeof token !== 'string') throw new Error('RESERVATION_SELECTED_AI_AUTH_UNAVAILABLE');
    return done(baseUrl, { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' });
  }
  // Retain the existing Codex account-pool selection/rotation contract in the
  // trusted host. Its proxy credential is not inherited by project commands.
  const multi = await prepareCodexMultiAuthProxy({ ...env, CODEX_HOME: env.CODEX_HOME ?? join(input.home, '.codex') });
  if (multi) {
    const setting = multi.args.find(value => value.includes('.base_url='));
    try {
      if (!setting || !multi.env.OPENAI_API_KEY) throw new Error();
      const baseUrl = JSON.parse(setting.slice(setting.indexOf('=') + 1));
      const url = new URL(baseUrl); if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error();
      return { baseUrl, headers: { Authorization: `Bearer ${multi.env.OPENAI_API_KEY}` }, close: multi.cleanup };
    } catch { await multi.cleanup(); throw new Error('RESERVATION_SELECTED_AI_AUTH_UNAVAILABLE'); }
  }
  if (env.OPENAI_API_KEY) return done(env.OPENAI_BASE_URL || 'https://api.openai.com/v1', { Authorization: `Bearer ${env.OPENAI_API_KEY}` });
  let value: any;
  try { value = JSON.parse(await read(join(env.CODEX_HOME ?? join(input.home, '.codex'), 'auth.json'))); }
  catch { throw new Error('RESERVATION_SELECTED_AI_AUTH_UNAVAILABLE'); }
  if (typeof value.OPENAI_API_KEY === 'string' && value.OPENAI_API_KEY) return done(env.OPENAI_BASE_URL || 'https://api.openai.com/v1', { Authorization: `Bearer ${value.OPENAI_API_KEY}` });
  const token = value.tokens?.access_token, account = value.tokens?.account_id;
  if (typeof token !== 'string' || !token || typeof account !== 'string' || !account) throw new Error('RESERVATION_SELECTED_AI_AUTH_UNAVAILABLE');
  return done('https://chatgpt.com/backend-api/codex', { Authorization: `Bearer ${token}`, 'ChatGPT-Account-Id': account, 'OpenAI-Beta': 'responses=experimental' });
}

/** Preserve the explicitly selected machine-gh default without handing its credential to native tools. */
export async function resolveReservationNativeGithub(input: { directory: string; environment: Record<string, string>; allowMachineDefault: boolean },
  run = promisify(execFile)): Promise<{ token: string; repository: string }> {
  const { GH_TOKEN, GH_REPO } = input.environment;
  if (GH_TOKEN && GH_REPO) return { token: GH_TOKEN, repository: GH_REPO };
  if (!input.allowMachineDefault) throw new Error('RESERVATION_SELECTED_GITHUB_AUTH_UNAVAILABLE');
  try {
    const options = { cwd: input.directory, env: sanitizeChildEnv(process.env), timeout: 10000, maxBuffer: 65536, windowsHide: true };
    const repository = JSON.parse(String((await run('gh', ['repo', 'view', '--json', 'nameWithOwner,url'], options)).stdout));
    const url = new URL(repository.url);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.nameWithOwner) || url.hostname !== 'github.com' || url.protocol !== 'https:' || url.pathname !== '/' + repository.nameWithOwner) throw new Error();
    const token = String((await run('gh', ['auth', 'token', '--hostname', 'github.com'], options)).stdout).trim();
    if (!token || token.length > 8192 || /[\r\n\0]/.test(token)) throw new Error();
    return { token, repository: repository.nameWithOwner };
  } catch { throw new Error('RESERVATION_SELECTED_GITHUB_AUTH_UNAVAILABLE'); }
}
