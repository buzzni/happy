/**
 * viewer-channel-strict-design.md §4-2~4-5 — the daemon end of the strict remote-screen
 * channel, driven the way the relay drives it: a real `ws` client over an in-memory tunnel,
 * and a real loopback TCP server standing in for VNC.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import net, { type AddressInfo } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import {
    bindRpcRequest,
    readBoundRpcResponse,
    readViewerChannelOpenReply,
    readViewerChannelProof,
    readViewerFrame,
    encodeViewerFrame,
    viewerFrameAad,
    viewerFrameKeyInfo,
    viewerFrameNonce,
    viewerProofKeyInfo,
    VIEWER_CHANNEL_OPEN_METHOD,
    VIEWER_FRAME_KIND,
    type ViewerDirection,
} from '@slopus/happy-wire';
import { decodeBase64, decryptWithDataKey, encodeBase64, encrypt, tryDecrypt } from '@/api/encryption';
import { createBoundOpenNonceGuard } from './boundOpen';
import { PreviewWsProxy } from './previewWsProxy';
import { createTunnelPair } from './tunnelPair';
import { createViewerChannelEndpoint, type ViewerChannelEndpoint } from './viewerChannelEndpoint';

const machineId = 'machine-1';
const machineKey = new Uint8Array(randomBytes(32));
const viewerKey = `bv1_${'A'.repeat(32)}`;
const leaseId = 'a'.repeat(64);
const display = ':99';
const TAG = 16;

let vnc: { port: number; received: Buffer[]; sockets: net.Socket[]; connections: number; stop: () => Promise<void> };
let endpoint: ViewerChannelEndpoint;
let resolveTargetResult: { vncPort: number; display: string; resize: 'remote' | 'scale' } | null;

async function startVnc(): Promise<typeof vnc> {
    const state = { received: [] as Buffer[], sockets: [] as net.Socket[], connections: 0 };
    const server = net.createServer((socket) => {
        state.connections++;
        state.sockets.push(socket);
        socket.on('data', (chunk) => state.received.push(chunk));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    return {
        ...state,
        get received() { return state.received; },
        get sockets() { return state.sockets; },
        get connections() { return state.connections; },
        port: (server.address() as AddressInfo).port,
        stop: () => new Promise<void>((resolve) => {
            for (const socket of state.sockets) socket.destroy();
            server.close(() => resolve());
        }),
    };
}

function newEndpoint(options: { openDeadlineMs?: number; maxChannels?: number } = {}): ViewerChannelEndpoint {
    return createViewerChannelEndpoint({
        machineId,
        openSealed: (bytes) => {
            const opened = tryDecrypt(machineKey, 'dataKey', bytes);
            return opened.ok ? opened.value : null;
        },
        sealBound: (value) => encodeBase64(encrypt(machineKey, 'dataKey', value)),
        nonceGuard: createBoundOpenNonceGuard(),
        resolveTarget: async () => resolveTargetResult,
        ...options,
    });
}

/** What the relay does: carry a browser's WebSocket into the tunnel's upstream. */
async function connect(path = '/v1/viewer-channel', binding = { viewerKey, leaseId, port: 6080 }): Promise<WebSocket> {
    const upstream = endpoint.attach(binding) as unknown as NodeJS.ReadWriteStream;
    await once(upstream as any, 'connect');
    const { outer: browserSocket, inner: relaySide } = createTunnelPair();
    relaySide.pipe(upstream as any);
    (upstream as any).pipe(relaySide);
    const ws = new WebSocket(`ws://viewer${path}`, { createConnection: () => browserSocket as any, perMessageDeflate: false });
    ws.binaryType = 'nodebuffer';
    return ws;
}

const nextMessage = (ws: WebSocket) => new Promise<{ data: Buffer; isBinary: boolean }>((resolve, reject) => {
    ws.once('message', (data, isBinary) => resolve({ data: data as Buffer, isBinary }));
    ws.once('close', () => reject(new Error('closed')));
});

function openRequest(overrides: { nonce?: string; params?: Record<string, unknown> } = {}) {
    const channelKey = new Uint8Array(randomBytes(32));
    const channelId = randomBytes(16).toString('base64');
    const nonce = overrides.nonce ?? randomBytes(16).toString('base64');
    const params = { viewerChannel: 1, channelKey: encodeBase64(channelKey), channelId, viewerKey, leaseId, ...overrides.params };
    const sealed = encodeBase64(encrypt(machineKey, 'dataKey', bindRpcRequest({
        method: VIEWER_CHANNEL_OPEN_METHOD, scope: machineId, params, issuedAt: Date.now(), nonce,
    })));
    return { channelKey, channelId, nonce, sealed };
}

/** The client side of an opened channel: checks the proof and seals and opens frames as the web will. */
function clientChannel(open: ReturnType<typeof openRequest>, proof: string) {
    const proofKey = new Uint8Array(hkdfSync('sha256', open.channelKey, new Uint8Array(0), Buffer.from(viewerProofKeyInfo(open.channelId)), 32));
    const read = readViewerChannelProof(decryptWithDataKey(decodeBase64(proof), proofKey), {
        nonce: open.nonce, channelId: open.channelId, viewerKey, leaseId, display,
    });
    if (!read.ok) throw new Error(read.code);
    const key = (dir: ViewerDirection) => new Uint8Array(hkdfSync(
        'sha256', open.channelKey, decodeBase64(read.daemonNonce), Buffer.from(viewerFrameKeyInfo(dir, leaseId, open.channelId)), 32,
    ));
    const keys = { in: key('in'), out: key('out') };
    return {
        caps: read.caps,
        seal(seq: number, kind: number, payload: Buffer): Buffer {
            const cipher = createCipheriv('aes-256-gcm', keys.in, viewerFrameNonce('in', seq));
            cipher.setAAD(viewerFrameAad(kind, viewerFrameKeyInfo('in', leaseId, open.channelId)));
            const sealed = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
            return Buffer.from(encodeViewerFrame(kind, sealed));
        },
        open(seq: number, frame: Buffer): { kind: string; payload: Buffer } {
            const read = readViewerFrame(new Uint8Array(frame), 'out');
            if (!read) throw new Error('unreadable frame');
            const decipher = createDecipheriv('aes-256-gcm', keys.out, viewerFrameNonce('out', seq));
            decipher.setAAD(viewerFrameAad(VIEWER_FRAME_KIND[read.kind], viewerFrameKeyInfo('out', leaseId, open.channelId)));
            decipher.setAuthTag(read.sealed.subarray(read.sealed.length - TAG));
            const payload = Buffer.concat([decipher.update(read.sealed.subarray(0, read.sealed.length - TAG)), decipher.final()]);
            return { kind: read.kind, payload };
        },
    };
}

async function openChannel() {
    const ws = await connect();
    await once(ws, 'open');
    const open = openRequest();
    ws.send(open.sealed);
    const reply = readViewerChannelOpenReply((await nextMessage(ws)).data.toString('utf8'));
    if (!reply?.ok) throw new Error(`open refused: ${JSON.stringify(reply)}`);
    return { ws, open, channel: clientChannel(open, reply.proof) };
}

function sealedRefusal(open: ReturnType<typeof openRequest>, text: string): unknown {
    const reply = readViewerChannelOpenReply(text);
    if (!reply || reply.ok || !reply.sealed) return reply;
    const opened = tryDecrypt(machineKey, 'dataKey', decodeBase64(reply.sealed));
    const bound = readBoundRpcResponse(opened.ok ? opened.value : null, open.nonce);
    return bound.ok ? bound.result : bound;
}

const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
};

describe('viewer channel endpoint', () => {
    beforeEach(async () => {
        vnc = await startVnc();
        resolveTargetResult = { vncPort: vnc.port, display, resize: 'remote' };
        endpoint = newEndpoint();
    });
    afterEach(async () => {
        endpoint.closeAll();
        await vnc.stop();
    });

    it('opens with a proof of this open and screen, then carries RFB sealed both ways', async () => {
        const { ws, channel } = await openChannel();
        expect(channel.caps).toEqual({ resize: 'remote', maxFrameBytes: 64 * 1024 });
        await waitFor(() => vnc.connections === 1);

        ws.send(channel.seal(1, VIEWER_FRAME_KIND.rfb, Buffer.from('RFB 003.008\n')));
        await waitFor(() => Buffer.concat(vnc.received).toString() === 'RFB 003.008\n');

        vnc.sockets[0].write(Buffer.from('RFB 003.008\n'));
        const message = await nextMessage(ws);
        expect(message.isBinary).toBe(true);
        expect(message.data.includes(Buffer.from('RFB'))).toBe(false);
        expect(channel.open(1, message.data)).toEqual({ kind: 'rfb', payload: Buffer.from('RFB 003.008\n') });
        ws.close();
    });

    it('splits a VNC read larger than one frame into frames in order', async () => {
        const { ws, channel } = await openChannel();
        await waitFor(() => vnc.connections === 1);
        const big = randomBytes(64 * 1024 + 10);
        const frames: Buffer[] = [];
        ws.on('message', (data) => frames.push(data as Buffer));
        vnc.sockets[0].write(big);
        await waitFor(() => frames.reduce((n, frame) => n + frame.length - 2 - TAG, 0) === big.length);
        expect(Buffer.concat(frames.map((frame, i) => channel.open(i + 1, frame).payload))).toEqual(big);
        ws.close();
    });

    it('refuses a replayed open with a sealed reason, without reaching VNC', async () => {
        const first = await openChannel();
        first.ws.close();
        await waitFor(() => vnc.connections === 1);

        const ws = await connect();
        await once(ws, 'open');
        ws.send(first.open.sealed);
        const text = (await nextMessage(ws)).data.toString('utf8');
        expect(sealedRefusal(first.open, text)).toEqual({ code: 'RPC_REQUEST_REPLAYED' });
        await once(ws, 'close');
        expect(vnc.connections).toBe(1);
    });

    it('refuses an open naming another lease than the tunnel was opened for', async () => {
        const ws = await connect();
        await once(ws, 'open');
        const open = openRequest({ params: { leaseId: 'b'.repeat(64) } });
        ws.send(open.sealed);
        expect(sealedRefusal(open, (await nextMessage(ws)).data.toString('utf8'))).toEqual({ code: 'VIEWER_CHANNEL_LEASE_MISMATCH' });
        expect(vnc.connections).toBe(0);
    });

    it('refuses an open whose screen is no longer this viewer\'s', async () => {
        resolveTargetResult = null;
        const ws = await connect();
        await once(ws, 'open');
        const open = openRequest();
        ws.send(open.sealed);
        expect(sealedRefusal(open, (await nextMessage(ws)).data.toString('utf8'))).toEqual({ code: 'VIEWER_CHANNEL_LEASE_GONE' });
        expect(vnc.connections).toBe(0);
    });

    it('answers an open it cannot read with a bare refusal a relay could not have worded', async () => {
        const ws = await connect();
        await once(ws, 'open');
        ws.send(encodeBase64(new Uint8Array(randomBytes(64))));
        expect(JSON.parse((await nextMessage(ws)).data.toString('utf8'))).toEqual({ ok: false });
        await once(ws, 'close');
        expect(vnc.connections).toBe(0);
    });

    it('closes the channel and the VNC connection on a replayed or skipped input frame', async () => {
        for (const seq of [[1, 1], [2]]) {
            const { ws, channel } = await openChannel();
            const before = vnc.sockets.length;
            await waitFor(() => vnc.sockets.length === before + 1 || vnc.connections > before);
            for (const s of seq) ws.send(channel.seal(s, VIEWER_FRAME_KIND.rfb, Buffer.from('x')));
            await once(ws, 'close');
            const socket = vnc.sockets[vnc.sockets.length - 1];
            await waitFor(() => socket.destroyed || socket.readableEnded);
        }
    });

    it('ends the VNC connection when the user closes, and says why when VNC goes away', async () => {
        const closing = await openChannel();
        await waitFor(() => vnc.connections === 1);
        closing.ws.send(closing.channel.seal(1, VIEWER_FRAME_KIND.close, Buffer.alloc(0)));
        await once(closing.ws, 'close');
        await waitFor(() => vnc.sockets[0].destroyed || vnc.sockets[0].readableEnded);

        const { ws, channel } = await openChannel();
        await waitFor(() => vnc.connections === 2);
        vnc.sockets[1].destroy();
        const message = await nextMessage(ws);
        expect(channel.open(1, message.data)).toEqual({ kind: 'closed', payload: Buffer.from('vnc-closed') });
    });

    it('closes a channel that does not open in time', async () => {
        endpoint.closeAll();
        endpoint = newEndpoint({ openDeadlineMs: 50 });
        const ws = await connect();
        await once(ws, 'open');
        await once(ws, 'close');
        expect(vnc.connections).toBe(0);
    });

    it('answers only the channel path', async () => {
        const ws = await connect('/websockify');
        const [, response] = await once(ws, 'unexpected-response') as [unknown, { statusCode: number }];
        expect(response.statusCode).toBe(404);
        expect(vnc.connections).toBe(0);
    });

    it('turns away tunnels beyond its channel limit', async () => {
        endpoint.closeAll();
        endpoint = newEndpoint({ maxChannels: 1 });
        await connect();
        const upstream = endpoint.attach({ viewerKey, leaseId, port: 6080 }) as any;
        const [error] = await once(upstream, 'error');
        expect((error as Error).message).toMatch(/viewer channels/);
    });

    it('opens through the preview tunnel the relay drives, carrying only sealed bytes', async () => {
        const toBrowser: string[] = [];
        let browserEnd: ReturnType<typeof createTunnelPair>['outer'] | null = null;
        const proxy = new PreviewWsProxy({
            emit: (event: string, payload: any) => {
                if (event === 'proxy-ws-data') {
                    toBrowser.push(payload.dataB64);
                    browserEnd?.write(Buffer.from(payload.dataB64, 'base64'));
                } else browserEnd?.end();
            },
        } as any);
        const { outer, inner } = createTunnelPair();
        browserEnd = inner;
        let opened: Promise<unknown> | null = null;
        inner.on('data', (chunk: Buffer) => {
            // The first bytes are the upgrade request: the relay sends them with the open, the rest as data.
            if (!opened) {
                opened = proxy.open({ tunnelId: 't', port: 6080, dataB64: chunk.toString('base64') }, () => endpoint.attach({ viewerKey, leaseId, port: 6080 }));
                return;
            }
            void opened.then(() => proxy.data({ tunnelId: 't', dataB64: chunk.toString('base64') }));
        });
        const ws = new WebSocket('ws://viewer/v1/viewer-channel', { createConnection: () => outer as any, perMessageDeflate: false });
        ws.binaryType = 'nodebuffer';
        await once(ws, 'open');
        const open = openRequest();
        ws.send(open.sealed);
        const reply = readViewerChannelOpenReply((await nextMessage(ws)).data.toString('utf8'));
        expect(reply?.ok).toBe(true);
        const channel = clientChannel(open, (reply as { proof: string }).proof);
        await waitFor(() => vnc.connections === 1);
        vnc.sockets[0].write(Buffer.from('RFB 003.008\n'));
        expect(channel.open(1, (await nextMessage(ws)).data)).toEqual({ kind: 'rfb', payload: Buffer.from('RFB 003.008\n') });
        expect(toBrowser.some((b64) => Buffer.from(b64, 'base64').includes(Buffer.from('RFB 003')))).toBe(false);
        ws.close();
        proxy.closeAll();
    });
});
