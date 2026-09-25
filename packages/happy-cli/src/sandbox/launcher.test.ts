import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filterClaudeProcessEnv } from './claudeProcessSandbox';
const dir = mkdtempSync(join(tmpdir(), 'launcher-unit-'));
copyFileSync('scripts/agent-browser/claude-sbx-launch', join(dir, 'launcher.cjs'));
const launcher = createRequire(import.meta.url)(join(dir, 'launcher.cjs')) as { filterEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv; validate: (meta: unknown, args: string[]) => void };
afterAll(() => rmSync(dir, { recursive: true, force: true }));
describe('installed fixed launcher', () => {
    it('reapplies the env allowlist independently of the Happy caller', () => {
        const env = { HOME: '/secret', PATH: '/work', BASH_ENV: '/work/evil', NODE_OPTIONS: '--inspect', LD_PRELOAD: '/work/evil', HAPPY_TOKEN: 'synthetic', SAYCODE_MCP_TOKEN: 'synthetic', CLAUDE_CONFIG_DIR: '/secret', ANTHROPIC_API_KEY: 'synthetic', LANG: 'C' };
        expect(launcher.filterEnv(env)).toEqual(filterClaudeProcessEnv(env));
    });
    it('rejects invalid argv metadata without executing text', () => {
        const meta = { version: 1, argc: 1, cwd: '/work', env: {}, denyRead: [], denyWrite: [] };
        launcher.validate(meta, ['/bin/true']);
        for (const altered of [{ ...meta, argc: 2 }, { ...meta, argc: -1 }, { ...meta, version: 0 }, { ...meta, cwd: 'relative' }, { ...meta, denyRead: ['relative'] }]) expect(() => launcher.validate(altered, ['/bin/true'])).toThrow();
        expect(() => launcher.validate(meta, ['$(touch /work/evil)'])).toThrow();
    });
});
