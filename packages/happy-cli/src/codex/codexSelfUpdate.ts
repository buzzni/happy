import { spawn as nodeSpawn } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { delimiter, join, sep } from 'node:path';

/**
 * Codex CLI self-update after "requires a newer version of Codex" (aplus specs/codex-cli-update-recovery).
 * Saycode Desktop used to splice this into the bundle at staging time; it lives here so every Happy entry
 * (including the Windows resident bundle) carries it.
 */
export const CODEX_SELF_UPDATE_TIMEOUT_MS = 180_000;
const VERSION_TIMEOUT_MS = 60_000;

export type CodexVersion = { text: string; parts: [number, number, number]; prerelease: boolean };
type CodexOnPath = { file: string; npmPrefix: string | null };
type SpawnLike = typeof nodeSpawn;

/**
 * The first codex a ChatGPT login may use each model with. Below it the provider does not ask for an update: it
 * says the model "is not supported when using Codex with a ChatGPT account" (0.163.0 with gpt-6.2-sol, 2026-11-28),
 * the same words a plan without the model gets. Only a codex below this version is updated for that refusal.
 */
const CHATGPT_MODEL_MINIMUM_CODEX: Readonly<Record<string, CodexVersion['parts']>> = {
    'gpt-6.2-sol': [0, 166, 0],
    'gpt-6.2-astra': [0, 166, 0],
};
const CHATGPT_MODEL_REFUSAL = /\bthe\s+['"‘’`]([^'"‘’`\s]{1,128})['"‘’`]\s+model\s+is\s+not\s+supported\s+when\s+using\s+codex\s+with\s+a\s+chatgpt\s+account\b/i;

export const codexUpgradeRequired = (failure: unknown, running: CodexVersion | null = null): boolean => {
    if (typeof failure !== 'string') return false;
    if (/requires a newer version of Codex/i.test(failure)) return true;
    const model = CHATGPT_MODEL_REFUSAL.exec(failure)?.[1];
    const minimum = model ? CHATGPT_MODEL_MINIMUM_CODEX[model] : undefined;
    return !!minimum && !!running && isNewer({ text: '', parts: minimum, prerelease: false }, running);
};

/**
 * The codex this runtime starts: the first runnable one on PATH. It is run by that full path, so cmd.exe's
 * current-folder lookup cannot pick a codex.cmd from the project instead. npm installs also give their prefix.
 */
export function findCodexOnPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): CodexOnPath | null {
    const windows = platform === 'win32';
    for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
        if (windows) {
            const file = ['codex.exe', 'codex.cmd'].map(name => join(dir, name)).find(candidate => existsSync(candidate));
            if (!file) continue;
            return { file, npmPrefix: existsSync(join(dir, 'node_modules', '@openai', 'codex', 'package.json')) ? dir : null };
        }
        const file = join(dir, 'codex');
        try {
            if (!statSync(file).isFile()) continue;
            accessSync(file, constants.X_OK);
        } catch {
            continue;
        }
        const real = realpathSync(file);
        const at = real.indexOf(join(sep, 'lib', 'node_modules', '@openai', 'codex') + sep);
        return { file, npmPrefix: at > 0 ? real.slice(0, at) : null };
    }
    return null;
}

function runCodex(spawn: SpawnLike, codex: CodexOnPath, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) {
    return new Promise<{ stdout: string; output: string }>((resolve, reject) => {
        // npm's Windows codex is a .cmd, which only a shell starts: its full path is quoted and the arguments are fixed words.
        const shell = /\.(?:cmd|bat)$/i.test(codex.file);
        const child = spawn(shell ? `"${codex.file}" ${args.join(' ')}` : codex.file, shell ? [] : args, {
            env, stdio: ['ignore', 'pipe', 'pipe'], shell, windowsHide: true,
        });
        let stdout = '';
        let output = '';
        let settled = false;
        child.stdout?.on('data', (chunk: Buffer) => {
            stdout = (stdout + chunk.toString()).slice(-4000);
            output = (output + chunk.toString()).slice(-4000);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-4000);
        });
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error); else resolve({ stdout, output });
        };
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            finish(new Error(`codex ${args[0]} timed out`));
        }, timeoutMs);
        child.once('error', error => finish(error));
        // "close", not "exit": the output may still be arriving when the process exits.
        child.once('close', code => {
            if (code === 0) finish();
            else finish(new Error(`codex ${args[0]} exited with ${code}${output.trim() ? `: ${output.trim()}` : ''}`));
        });
    });
}

async function readCodexVersion(spawn: SpawnLike, codex: CodexOnPath, env: NodeJS.ProcessEnv): Promise<CodexVersion | null> {
    const { stdout } = await runCodex(spawn, codex, ['--version'], env, VERSION_TIMEOUT_MS).catch(() => ({ stdout: '' }));
    const found = /\b(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?\b/.exec(stdout);
    return found
        ? { text: found[0], parts: [Number(found[1]), Number(found[2]), Number(found[3])], prerelease: !!found[4] }
        : null;
}

function isNewer(after: CodexVersion, before: CodexVersion): boolean {
    for (let index = 0; index < 3; index += 1) {
        if (after.parts[index] !== before.parts[index]) return after.parts[index] > before.parts[index];
    }
    return false;
}

/**
 * `codex update` on an npm install runs a plain `npm install -g`, which lands in npm's configured prefix rather
 * than the folder of the codex this runtime starts (Saycode's own Node points npm at ~/.aplus/tools/npm-packages,
 * nvm gives each Node its own), and still says it succeeded. So npm is pointed at that folder.
 */
function updateEnvironment(codex: CodexOnPath, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = { ...base };
    if (codex.npmPrefix) {
        // Windows env keys ignore case and the first one wins: drop NPM_CONFIG_PREFIX and the like first.
        for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_prefix') delete env[key];
        env.npm_config_prefix = codex.npmPrefix;
    }
    return env;
}

/**
 * Reads the version the app-server runs as soon as it is created (right after it connected), and updates the codex
 * on PATH only when that update provably moved it forward.
 */
export function createCodexSelfUpdater(deps: { spawn?: SpawnLike; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}) {
    const spawn = deps.spawn ?? nodeSpawn;
    const baseEnv = deps.env ?? process.env;
    const platform = deps.platform ?? process.platform;
    const locate = () => findCodexOnPath(baseEnv, platform);
    let runningVersion: Promise<CodexVersion | null> = Promise.resolve()
        .then(() => {
            const codex = locate();
            return codex ? readCodexVersion(spawn, codex, updateEnvironment(codex, baseEnv)) : null;
        })
        .catch(() => null);

    return {
        get runningVersion() { return runningVersion; },
        async update(): Promise<CodexVersion> {
            const running = await runningVersion;
            let codex: CodexOnPath | null = null;
            try { codex = locate(); } catch { codex = null; }
            if (!codex) throw new Error('codex was not found on PATH');
            const env = updateEnvironment(codex, baseEnv);
            const before = await readCodexVersion(spawn, codex, env);
            if (!before) throw new Error('Could not read the Codex CLI version before updating it');
            // A prerelease (alpha) codex could be taken down to an older release.
            if (before.prerelease) throw new Error(`Codex CLI ${before.text} is a prerelease; it is not updated automatically`);
            const { output } = await runCodex(spawn, codex, ['update'], env, CODEX_SELF_UPDATE_TIMEOUT_MS);
            const after = await readCodexVersion(spawn, codex, env);
            // Against the older of the running app-server and the disk: a disk already ahead of the running one (Codex's own
            // updater, another conversation's update) leaves `codex update` nothing to do, and the reconnect alone fixes it.
            const baseline = running && isNewer(before, running) ? running : before;
            if (!after || !isNewer(after, baseline)) {
                throw new Error(`Codex CLI is still ${after?.text ?? 'unreadable'} (running ${baseline.text}) after codex update${output.trim() ? `: ${output.trim().slice(-300)}` : ''}`);
            }
            return after;
        },
        /** After the app-server reconnected on the updated codex. */
        markRunning(version: CodexVersion) { runningVersion = Promise.resolve(version); },
    };
}
