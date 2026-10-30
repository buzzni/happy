/** Owner operations only. Socket discovery is not caller/owner authority. */
import { createServer } from 'node:http';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OwnerContactRequestSchema, encodeOwnerRelayReply } from '@slopus/happy-wire';
import type { SessionOwnerContact } from './sessionOwnerContact';

export interface SessionOwnerContactLocal {
    environment: { SAYCODE_OWNER_CONTACT_SOCKET: string };
    close(): Promise<void>;
}
/** Called by the trusted host after bootstrap; never derives a source from env/HTTP.
 * Owns the supplied contact until close. No TCP fallback or credential export.
 * Provider sandbox filesystem access to this socket is a separate launch concern.
 */
export async function startSessionOwnerContactLocal(input: {
    enabled?: boolean;
    contact: SessionOwnerContact;
}): Promise<SessionOwnerContactLocal | null> {
    if (input.enabled !== true) return null;
    // Do not replace owner-only Unix permissions with an unverified Windows pipe ACL.
    if (process.platform === 'win32') throw new Error('owner-contact-local-unsupported');
    const call = input.contact.call.bind(input.contact);
    const revoke = input.contact.close.bind(input.contact);
    const directory = await mkdtemp(join(tmpdir(), 'h-oc-'));
    const socketPath = join(directory, 'contact.sock');
    let closing = false;
    let active = 0;
    let closeFlight: Promise<void> | undefined;
    const server = createServer(async (req, res) => {
        const fail = (status: number) => {
            if (!res.destroyed && !res.headersSent) res.writeHead(status, { 'content-type': 'application/json' })
                .end('{"error":"owner-contact-unavailable"}');
        };
        if (closing) { fail(503); return; }
        if (req.headers.origin !== undefined) { fail(403); return; }
        if (req.method !== 'POST' || req.url !== '/owner-contact-v1') { fail(404); return; }
        if (active >= 8) { fail(429); return; }
        active++;
        const timer = setTimeout(() => { res.destroy(); req.destroy(); }, 20_000);
        const clearDeadline = () => clearTimeout(timer);
        res.once('close', clearDeadline);
        try {
            let bytes = 0;
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
                bytes += chunk.length;
                if (bytes > 65536) { fail(413); return; }
                chunks.push(Buffer.from(chunk));
            }
            let request;
            try { request = OwnerContactRequestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
            catch { fail(400); return; }
            if (closing || res.destroyed) return;
            const reply = await call(request);
            if (closing || res.destroyed) return;
            // H1 validates the closed result union and the complete 128KiB response.
            const body = encodeOwnerRelayReply(reply);
            res.writeHead(200, { 'content-type': 'application/json' }).end(body);
        } catch { fail(503); }
        finally {
            clearDeadline(); res.removeListener('close', clearDeadline); active--;
        }
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    try {
        await chmod(directory, 0o700);
        if (Buffer.byteLength(socketPath) > 103) throw new Error('socket-path-too-long');
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); });
        });
        await chmod(socketPath, 0o600);
    } catch {
        closing = true;
        server.closeAllConnections(); server.close();
        try { revoke(); } finally { await rm(directory, { recursive: true, force: true }); }
        throw new Error('owner-contact-local-unavailable');
    }
    return {
        environment: { SAYCODE_OWNER_CONTACT_SOCKET: socketPath },
        close() {
            if (!closeFlight) {
                closing = true;
                closeFlight = (async () => {
                    try { revoke(); }
                    finally {
                        const stopped = new Promise<void>(resolve => server.close(() => resolve()));
                        server.closeAllConnections();
                        await stopped;
                        await rm(directory, { recursive: true, force: true });
                    }
                })();
            }
            return closeFlight;
        },
    };
}
