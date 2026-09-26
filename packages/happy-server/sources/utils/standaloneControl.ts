import type { Readable } from 'node:stream';

/** Parent-owned stdin capability; no network listener or persisted credential. */
export function standaloneControl(input: Readable): { requested: Promise<void>; dispose: () => void } {
    let request!: () => void;
    const requested = new Promise<void>((resolve) => { request = resolve; });
    let line = '';
    let oversized = false;
    const onData = (chunk: Buffer | string) => {
        // Commands are ASCII. Bound accumulated input even without a newline.
        for (const byte of Buffer.from(chunk)) {
            if (byte === 10) {
                if (!oversized) {
                    try {
                        const message = JSON.parse(line);
                        if (message?.v === 1 && message.command === 'shutdown'
                            && Object.keys(message).length === 2) request();
                    } catch { /* Unrecognized commands cannot control the server. */ }
                }
                line = '';
                oversized = false;
            } else if (!oversized) {
                if (line.length >= 256) { line = ''; oversized = true; }
                else line += String.fromCharCode(byte);
            }
        }
    };
    input.on('data', onData);
    input.on('end', request);
    input.on('close', request);
    input.on('error', request);
    if (input.readableEnded || input.destroyed) request();
    return {
        requested,
        dispose: () => {
            input.off('data', onData);
            input.off('end', request);
            input.off('close', request);
            input.off('error', request);
            input.pause();
        },
    };
}
