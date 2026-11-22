import { spawn as nodeSpawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexUpgradeRequired, createCodexSelfUpdater } from './codexSelfUpdate';

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Layout = 'npm' | 'standalone' | 'windows-npm';

/**
 * A codex that reports `state/version` (with a version-like warning on stderr), and on `update` records the npm
 * prefix it was given and moves to `state/next`. `windows-npm` is npm's Windows layout: codex.cmd beside node_modules.
 */
function fakeCodex(layout: Layout, version: string, next?: string) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'happy-codex-self-update-')));
    tempDirs.push(root);
    const state = join(root, 'state');
    mkdirSync(state);
    writeFileSync(join(state, 'version'), version);
    if (next) writeFileSync(join(state, 'next'), next);
    const script = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "(node:1) Warning: engine v18.19.0 is old" >&2
  if [ -s "${state}/version" ]; then echo "codex-cli $(cat "${state}/version")"; fi
  exit 0
fi
if [ "$1" = "update" ]; then
  echo "\${npm_config_prefix:-<none>}" > "${state}/prefix"
  if [ -f "${state}/next" ]; then cp "${state}/next" "${state}/version"; fi
  echo "Update ran successfully! Please restart Codex."
  exit 0
fi
exit 1
`;
    const prefix = join(root, layout);
    const bin = layout === 'windows-npm' ? prefix : join(prefix, 'bin');
    mkdirSync(bin, { recursive: true });
    const write = (file: string) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, script); chmodSync(file, 0o755); };
    if (layout === 'npm') {
        const entry = join(prefix, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        write(entry);
        symlinkSync(entry, join(bin, 'codex'));
    } else if (layout === 'windows-npm') {
        write(join(bin, 'codex.cmd'));
        write(join(bin, 'node_modules', '@openai', 'codex', 'package.json'));
    } else {
        write(join(bin, 'codex'));
    }
    return { root, state, prefix, bin };
}

async function runSelfUpdate(path: string, options: { platform?: NodeJS.Platform; env?: Record<string, string>; diskMovesTo?: { state: string; version: string } } = {}) {
    // As win32 Node would start cmd.exe for `shell: true`; POSIX hands the same command line to /bin/sh instead.
    const spawn = ((file: string, args: string[], spawnOptions: Parameters<typeof nodeSpawn>[2]) =>
        nodeSpawn(file, args, options.platform === 'win32' && spawnOptions?.shell === true ? { ...spawnOptions, shell: '/bin/sh' } : spawnOptions ?? {})) as typeof nodeSpawn;
    const updater = createCodexSelfUpdater({ spawn, platform: options.platform, env: { PATH: `${path}:/usr/bin:/bin`, ...options.env } });
    if (options.diskMovesTo) {
        await updater.runningVersion;
        writeFileSync(join(options.diskMovesTo.state, 'version'), options.diskMovesTo.version);
    }
    try { await updater.update(); return { ok: true as const }; }
    catch (error) { return { ok: false as const, message: (error as Error).message }; }
}

describe.skipIf(process.platform === 'win32')('Codex CLI self-update', () => {
    it('recognises only the provider failure that asks for a newer Codex', () => {
        expect(codexUpgradeRequired('This model requires a newer version of Codex. Please upgrade.')).toBe(true);
        expect(codexUpgradeRequired('rate limited')).toBe(false);
        expect(codexUpgradeRequired(null)).toBe(false);
    });

    it('points npm at the folder of the npm-installed codex it runs, and succeeds once that codex is newer', async () => {
        const codex = fakeCodex('npm', '0.165.0', '0.166.0');
        expect(await runSelfUpdate(codex.bin)).toEqual({ ok: true });
        expect(readFileSync(join(codex.state, 'prefix'), 'utf8').trim()).toBe(codex.prefix);
    });

    it('replaces a differently cased npm prefix the environment already carries', async () => {
        const codex = fakeCodex('npm', '0.165.0', '0.166.0');
        expect(await runSelfUpdate(codex.bin, { env: { NPM_CONFIG_PREFIX: '/elsewhere' } })).toEqual({ ok: true });
        expect(readFileSync(join(codex.state, 'prefix'), 'utf8').trim()).toBe(codex.prefix);
    });

    it('leaves npm alone for a codex that npm did not install', async () => {
        const codex = fakeCodex('standalone', '0.165.0', '0.166.0');
        expect(await runSelfUpdate(codex.bin)).toEqual({ ok: true });
        expect(readFileSync(join(codex.state, 'prefix'), 'utf8').trim()).toBe('<none>');
    });

    it('skips a PATH entry named codex that cannot run, as the runtime\'s own start does', async () => {
        const codex = fakeCodex('npm', '0.165.0', '0.166.0');
        const decoy = join(codex.root, 'decoy');
        mkdirSync(decoy);
        writeFileSync(join(decoy, 'codex'), 'not a program');
        expect(await runSelfUpdate(`${decoy}:${codex.bin}`)).toEqual({ ok: true });
        expect(readFileSync(join(codex.state, 'prefix'), 'utf8').trim()).toBe(codex.prefix);
    });

    it('fails, without a retry, when the update said it ran but the codex it runs is no newer', async () => {
        const codex = fakeCodex('npm', '0.165.0');
        const result = await runSelfUpdate(codex.bin);
        expect(result.ok).toBe(false);
        expect(result.message).toContain('0.165.0');
        expect(result.message).toContain('Update ran successfully');
    });

    it('counts a disk already ahead of the running app-server, when the update has nothing left to do, so the reconnect still happens', async () => {
        const codex = fakeCodex('npm', '0.165.0');
        expect(await runSelfUpdate(codex.bin, { diskMovesTo: { state: codex.state, version: '0.166.0' } })).toEqual({ ok: true });
    });

    it('does not update a codex whose version it cannot read first, since it could not tell the update worked', async () => {
        const codex = fakeCodex('npm', '', '0.166.0');
        expect((await runSelfUpdate(codex.bin)).ok).toBe(false);
        expect(existsSync(join(codex.state, 'prefix'))).toBe(false);
    });

    it('does not update a prerelease codex, which the update could take down to an older release', async () => {
        const codex = fakeCodex('npm', '0.171.0-alpha.13', '0.170.0');
        const result = await runSelfUpdate(codex.bin);
        expect(result.ok).toBe(false);
        expect(result.message).toContain('0.171.0-alpha.13');
        expect(existsSync(join(codex.state, 'prefix'))).toBe(false);
    });

    it('on Windows runs npm\'s codex.cmd by its full path through the shell, with npm pointed at its folder', async () => {
        const codex = fakeCodex('windows-npm', '0.165.0', '0.166.0');
        expect(await runSelfUpdate(codex.bin, { platform: 'win32' })).toEqual({ ok: true });
        expect(readFileSync(join(codex.state, 'prefix'), 'utf8').trim()).toBe(codex.prefix);
    });
});
