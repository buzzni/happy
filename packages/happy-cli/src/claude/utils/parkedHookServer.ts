import { createServer, type RequestListener } from 'node:http';

export type ParkedClaudeHookServer = {
    port: number;
    adopt(listener: RequestListener): boolean;
    stop(): void;
};

// The worker's disk entry and the activated CLI may load different copies of this module.
const offerKey = Symbol.for('happy.claude.parkedHookServer');
const processOffer = globalThis as typeof globalThis & { [offerKey]?: ParkedClaudeHookServer };

/** Prepare the address only. The parked listener owns neither session state nor a tool policy. */
export function reserveClaudeHookServer(): Promise<ParkedClaudeHookServer> {
    return new Promise((resolve, reject) => {
        let listener: RequestListener | undefined;
        let stopped = false;
        const server = createServer((req, res) => {
            if (listener) listener(req, res);
            else {
                req.resume();
                res.writeHead(503, { Connection: 'close' }).end('not ready');
            }
        });
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close();
                reject(new Error('Claude hook address unavailable'));
                return;
            }
            const parked: ParkedClaudeHookServer = {
                port: address.port,
                adopt(handle) {
                    if (stopped || !server.listening || listener) return false;
                    listener = handle;
                    server.ref();
                    return true;
                },
                stop() {
                    if (stopped) return;
                    stopped = true;
                    listener = undefined;
                    if (processOffer[offerKey] === parked) delete processOffer[offerKey];
                    server.close();
                    server.closeAllConnections();
                },
            };
            server.unref();
            resolve(parked);
        });
    });
}

/** The draft worker calls this after receiving and installing the authorized launch. */
export function offerParkedClaudeHookServer(parked: ParkedClaudeHookServer): void {
    if (processOffer[offerKey] && processOffer[offerKey] !== parked) throw new Error('Claude hook address already offered');
    processOffer[offerKey] = parked;
}

export function takeParkedClaudeHookServer(): ParkedClaudeHookServer | undefined {
    const parked = processOffer[offerKey];
    delete processOffer[offerKey];
    return parked;
}
