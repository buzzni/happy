/**
 * Low-level ripgrep wrapper - just arguments in, string out
 */

import { spawn as crossSpawn } from 'cross-spawn';
import { projectPath } from '@/projectPath';
import { join, resolve } from 'path';

export interface RipgrepResult {
    exitCode: number
    stdout: string
    stderr: string
}

export interface RipgrepOptions {
    cwd?: string
    timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Run ripgrep with the given arguments
 * @param args - Array of command line arguments to pass to ripgrep
 * @param options - Options for ripgrep execution
 * @returns Promise with exit code, stdout and stderr
 */
export function run(args: string[], options?: RipgrepOptions): Promise<RipgrepResult> {
    const RUNNER_PATH = resolve(join(projectPath(), 'scripts', 'ripgrep_launcher.cjs'));
    return new Promise((resolve, reject) => {
        // Use cross-spawn so `node` resolves to `node.exe` on Windows (issue #1082).
        const child = crossSpawn('node', [RUNNER_PATH, JSON.stringify(args)], {
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: options?.cwd,
            windowsHide: true,
        });
        const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', (code) => {
            clearTimeout(timeout);
            if (timedOut) {
                reject(new Error(`Ripgrep timed out after ${timeoutMs}ms`));
                return;
            }
            resolve({
                exitCode: code ?? 1,
                stdout,
                stderr
            });
        });

        child.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}
