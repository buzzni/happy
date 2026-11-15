import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'orgSubagentCrash.ts');
async function run(home: string, checkpoint: string) {
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', require.resolve('tsx/esm'), fixture, home, checkpoint], {
            cwd: join(dirname(fixture), '../../..'), env: { ...process.env, NODE_OPTIONS: '', HAPPY_HOME_DIR: home }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
}
describe.skipIf(process.platform === 'win32')('org subagent abrupt process loss', () => {
    it.each(['reserved', 'preparing', 'prepared', 'creating-session', 'created', 'launching', 'after-provider', 'started'])(
        'never replays prepare or provider after SIGKILL at %s', async checkpoint => {
            const home = await mkdtemp(join(tmpdir(), 'org-crash-'));
            const count = async (name: string) => {
                try { return (await readFile(join(home, name), 'utf8')).trim().split('\n').filter(Boolean).length; }
                catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
            };
            try {
                const crashed = await run(home, checkpoint);
                expect(crashed.signal, crashed.stderr).toBe('SIGKILL');
                const before = { prepare: await count('prepare-count'), provider: await count('provider-count') };
                expect(before.provider).toBe(['after-provider', 'started'].includes(checkpoint) ? 1 : 0);
                const recovered = await run(home, 'none');
                expect(recovered.code, recovered.stderr).toBe(0);
                expect(JSON.parse(recovered.stdout)).toMatchObject(checkpoint === 'started' ? { ok: true, sessionId: 'child' } : { ok: false, error: 'spawn_pending' });
                expect({ prepare: await count('prepare-count'), provider: await count('provider-count') }).toEqual(before);
            } finally { await rm(home, { recursive: true, force: true }); }
        }, 20_000);
});
