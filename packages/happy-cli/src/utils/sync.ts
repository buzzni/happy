import { backoff } from "@/utils/time";
import { logger } from "@/ui/logger";

export class InvalidateSync {
    private _invalidated = false;
    private _invalidatedDouble = false;
    private _stopped = false;
    private _command: () => Promise<void>;
    private _onError?: (e: unknown) => void;
    private _pendings: (() => void)[] = [];

    constructor(command: () => Promise<void>, onError?: (e: unknown) => void) {
        this._command = command;
        this._onError = onError;
    }

    invalidate() {
        if (this._stopped) {
            return;
        }
        if (!this._invalidated) {
            this._invalidated = true;
            this._invalidatedDouble = false;
            this._doSync();
        } else {
            if (!this._invalidatedDouble) {
                this._invalidatedDouble = true;
            }
        }
    }

    async invalidateAndAwait() {
        if (this._stopped) {
            return;
        }
        await new Promise<void>(resolve => {
            this._pendings.push(resolve);
            this.invalidate();
        });
    }

    stop() {
        if (this._stopped) {
            return;
        }
        this._notifyPendings();
        this._stopped = true;
    }

    private _notifyPendings = () => {
        for (let pending of this._pendings) {
            pending();
        }
        this._pendings = [];
    }


    private _doSync = async () => {
        try {
            await backoff(async () => {
                if (this._stopped) {
                    return;
                }
                await this._command();
            });
        } catch (e) {
            // backoff only throws for permanently non-retryable errors (e.g. a
            // 404 after the session was archived/deleted). Stop syncing instead
            // of leaving an unhandled rejection or spinning forever. The log
            // matters for instances constructed without onError — they stop
            // silently otherwise.
            logger.debug('[InvalidateSync] permanently stopped on non-retryable error:', e);
            this._notifyPendings();
            this._stopped = true;
            this._onError?.(e);
            return;
        }
        if (this._stopped) {
            this._notifyPendings();
            return;
        }
        if (this._invalidatedDouble) {
            this._invalidatedDouble = false;
            this._doSync();
        } else {
            this._invalidated = false;
            this._notifyPendings();
        }
    }
}
