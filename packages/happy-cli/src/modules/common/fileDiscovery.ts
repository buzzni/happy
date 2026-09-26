import { fork } from 'node:child_process';
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
export async function fileDiscovery(allowedRoot: string, request: unknown): Promise<FileDiscoveryResponse> {
    if (running >= 2) return { version: 1, success: false, error: 'busy' };
    running++;
    try {
        return await new Promise<FileDiscoveryResponse>((resolve) => {
            const worker = fork(join(projectPath(), 'scripts', 'file-discovery-worker.cjs'), [], {
                stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: ['--max-old-space-size=32'],
            });
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
            worker.send({ allowedRoot, request }, error => { if (error) void finish({ version: 1, success: false, error: 'failed' }); });
        });
    } finally { running--; }
}
