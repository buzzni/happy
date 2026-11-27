import { fork, type ForkOptions } from 'node:child_process';
import { join } from 'node:path';
import { projectPath } from '@/projectPath';

export interface FileDiscoveryResponse {
    version: 1;
    success: boolean;
    error?: string;
    supported?: boolean;
    matches?: { path: string; line: number; text: string }[];
    partial?: boolean;
    reason?: string;
    content?: string;
    identity?: string;
    size?: number;
    offset?: number;
    eof?: boolean;
}
let running = 0;
/** One worker owns each operation so blocked filesystem IO cannot hang the daemon. */
export async function fileDiscovery(allowedRoot: string, request: unknown, platform: NodeJS.Platform = process.platform): Promise<FileDiscoveryResponse> {
    // The worker has a symlink-safe open only for macOS (NOFOLLOW_ANY) and Windows (a checked link-free chain); elsewhere it
    // answers only this, so no worker is started for it.
    if (platform !== 'darwin' && platform !== 'win32') return { version: 1, success: false, error: 'unsupported' };
    if (running >= 2) return { version: 1, success: false, error: 'busy' };
    running++;
    try {
        return await new Promise<FileDiscoveryResponse>((resolve) => {
            // The app asks on every project switch, and each worker showed a node.exe console (docs/windows-child-processes.md).
            // fork passes its options to spawn, which honors windowsHide; ForkOptions only leaves it out of the type.
            const options: ForkOptions & { windowsHide: boolean } = { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: ['--max-old-space-size=32'], windowsHide: true };
            const forkedAt = Date.now(); // the worker's own search deadline counts from here, inside this 5s
            const worker = fork(join(projectPath(), 'scripts', 'file-discovery-worker.cjs'), [], options);
            let settled = false;
            let matches: NonNullable<FileDiscoveryResponse['matches']> = [];
            const finish = async (result: FileDiscoveryResponse) => {
                if (settled) return;
                settled = true; clearTimeout(timer);
                if (worker.pid && worker.exitCode === null && worker.signalCode === null) {
                    worker.once('exit', () => resolve(result));
                    worker.kill('SIGKILL');
                } else resolve(result);
            };
            const searching = !!request && typeof request === 'object' && (request as { operation?: unknown }).operation === 'search';
            const timer = setTimeout(() => void finish(searching
                ? { version: 1, success: true, matches, partial: true, reason: 'time-limit' }
                : { version: 1, success: false, error: 'time-limit' }), 5000);
            worker.on('message', (result: any) => {
                if (result.progress === true) matches = result.matches;
                else void finish(result);
            });
            worker.once('error', () => void finish({ version: 1, success: false, error: 'failed' }));
            worker.once('exit', () => { if (!settled) void finish({ version: 1, success: false, error: 'failed' }); });
            worker.send({ allowedRoot, request, forkedAt }, error => { if (error) void finish({ version: 1, success: false, error: 'failed' }); });
        });
    } finally { running--; }
}
