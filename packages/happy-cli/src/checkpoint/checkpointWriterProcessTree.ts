import type { ChildProcess } from 'node:child_process';

const GRACEFUL_EXIT_MS = 2_500;
const SIGNAL_EXIT_MS = 1_000;
const POLL_INTERVAL_MS = 20;

export class CheckpointWriterProcessTree {
    private readonly processGroupIds = new Set<number>();
    private readonly exitedRootProcessGroupIds = new Set<number>();

    track(child: Pick<ChildProcess, 'pid' | 'once'>): void {
        if (!child.pid) {
            throw new Error('checkpoint writer process has no process group id');
        }
        const processGroupId = child.pid;
        this.processGroupIds.add(processGroupId);
        child.once('exit', () => {
            this.exitedRootProcessGroupIds.add(processGroupId);
            this.forgetIfGone(processGroupId);
        });
    }

    async quiesce(closeProvider: () => void | Promise<void>): Promise<void> {
        let closeError: unknown;
        try {
            await closeProvider();
        } catch (error) {
            closeError = error;
        }
        if (!(await this.waitUntilGone(GRACEFUL_EXIT_MS))) {
            this.signalRemaining('SIGTERM');
            if (!(await this.waitUntilGone(SIGNAL_EXIT_MS))) {
                this.signalRemaining('SIGKILL');
                if (!(await this.waitUntilGone(SIGNAL_EXIT_MS))) {
                    throw new Error('checkpoint writer process tree did not quiesce');
                }
            }
        }

        if (closeError) throw closeError;
    }

    private signalRemaining(signal: NodeJS.Signals): void {
        for (const processGroupId of this.processGroupIds) {
            try {
                process.kill(-processGroupId, signal);
            } catch (error) {
                if (this.isGoneOrInaccessibleAfterRootExit(error, processGroupId)) {
                    this.forget(processGroupId);
                } else if (!isProcessError(error, 'EPERM')) {
                    throw error;
                }
            }
        }
    }

    private forgetIfGone(processGroupId: number): void {
        try {
            process.kill(-processGroupId, 0);
        } catch (error) {
            if (this.isGoneOrInaccessibleAfterRootExit(error, processGroupId)) {
                this.forget(processGroupId);
            }
        }
    }

    private async waitUntilGone(timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        do {
            for (const processGroupId of this.processGroupIds) {
                try {
                    process.kill(-processGroupId, 0);
                } catch (error) {
                    if (this.isGoneOrInaccessibleAfterRootExit(error, processGroupId)) {
                        this.forget(processGroupId);
                    } else if (!isProcessError(error, 'EPERM')) {
                        throw error;
                    }
                }
            }
            if (this.processGroupIds.size === 0) return true;
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        } while (Date.now() < deadline);
        return false;
    }

    private isGoneOrInaccessibleAfterRootExit(error: unknown, processGroupId: number): boolean {
        return isProcessError(error, 'ESRCH') || (
            isProcessError(error, 'EPERM')
            && this.exitedRootProcessGroupIds.has(processGroupId)
        );
    }

    private forget(processGroupId: number): void {
        this.processGroupIds.delete(processGroupId);
        this.exitedRootProcessGroupIds.delete(processGroupId);
    }
}

function isProcessError(error: unknown, code: string): boolean {
    return error instanceof Error && 'code' in error && error.code === code;
}
