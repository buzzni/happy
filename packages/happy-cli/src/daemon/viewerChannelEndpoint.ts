/**
 * The daemon end of the strict remote-screen channel (aplus-dev-studio specs/
 * e2ee-machine-control-boundary viewer-channel-strict-design.md §4-1~4-5, happy-wire
 * viewerChannel.ts).
 *
 * On a strict machine a relayed viewer tunnel does not reach websockify: it is attached
 * here (`attach`, as the tunnel's upstream — previewWsProxy.ts) and never touches a loopback
 * port, which the relay could otherwise reach in plaintext. This end answers the WebSocket
 * upgrade itself, on `VIEWER_CHANNEL_PATH` only.
 *
 * The first message is the open: a bound `browser-viewer:channel-open` sealed with the
 * machine key. It must name the viewer key and lease the tunnel was opened for, its nonce is
 * remembered (boundOpen.ts), and the lease is read again now — the slot may have changed hands
 * since the relay checked it. A refusal of an open the machine key opened is sealed to that
 * open; anything else gets a bare `{ ok: false }`, so the relay cannot word a reason the client
 * shows. Then the daemon connects to the screen's VNC port directly, picks a fresh daemon
 * nonce, and answers with the proof.
 *
 * Every message after that is one sealed binary frame, numbered from 1 in each direction; a
 * frame that does not open as the next one ends the channel — there is no reordering on a
 * tunnel bound to one daemon socket, and no resume: a new channel gets a full screen anyway.
 * VNC reads larger than a frame are split. Flow control is left to RFB itself, whose client
 * asks for each screen update.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import http, { type IncomingMessage } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
    bindRpcResponse,
    encodeViewerFrame,
    readViewerChannelOpenParams,
    readViewerFrame,
    viewerFrameAad,
    viewerFrameKeyInfo,
    viewerFrameNonce,
    viewerProofKeyInfo,
    VIEWER_CHANNEL_KEY_HASH,
    VIEWER_CHANNEL_KEY_LENGTH,
    VIEWER_CHANNEL_OPEN_METHOD,
    VIEWER_CHANNEL_PATH,
    VIEWER_CHANNEL_VERSION,
    VIEWER_FRAME_KIND,
    VIEWER_FRAME_MAX_PAYLOAD_BYTES,
    type ViewerChannelCaps,
    type ViewerClosedReason,
    type ViewerDirection,
} from '@slopus/happy-wire';
import { decodeBase64, encodeBase64, encryptWithDataKey } from '@/api/encryption';
import type { RpcNonceGuard } from '@/api/rpc/rpcNonceGuard';
import { logger } from '@/ui/logger';
import { admitBoundOpenNonce, readBoundOpen } from './boundOpen';
import type { TunnelUpstream } from './previewWsProxy';
import { createTunnelPair, type TunnelEnd } from './tunnelPair';

/** The screen a viewer key holds right now. */
export interface ViewerChannelTarget {
    vncPort: number;
    display: string;
    resize: ViewerChannelCaps['resize'];
}

/** What the relay opened the tunnel for: its viewer binding and port. */
export interface ViewerTunnelBinding {
    viewerKey: string;
    leaseId: string;
    port: number;
}

export interface ViewerChannelEndpointDeps {
    machineId: string;
    /** Opens bytes sealed with the machine key; null when they are not. */
    openSealed(bytes: Uint8Array): unknown;
    /** Seals a value with the machine key, base64. */
    sealBound(value: unknown): string;
    nonceGuard: RpcNonceGuard;
    /** The screen this binding still holds, read now; null when it no longer does. */
    resolveTarget(binding: ViewerTunnelBinding): Promise<ViewerChannelTarget | null>;
    connectVnc?(port: number): net.Socket;
    openDeadlineMs?: number;
    maxChannels?: number;
}

export interface ViewerChannelEndpoint {
    /** The upstream of one relayed viewer tunnel. */
    attach(binding: ViewerTunnelBinding): TunnelUpstream;
    /** Every channel ends with `daemon-stopping`. */
    closeAll(): void;
    readonly size: number;
}

/** A client that has not opened by now is not going to. */
const OPEN_DEADLINE_MS = 10_000;
const MAX_CHANNELS = 16;
const TAG_BYTES = 16;
/** One frame, or the open (a sealed bound request of a few hundred bytes, base64). */
const MAX_MESSAGE_BYTES = 2 + VIEWER_FRAME_MAX_PAYLOAD_BYTES + TAG_BYTES;

type Refusal = { code: string };

export function createViewerChannelEndpoint(deps: ViewerChannelEndpointDeps): ViewerChannelEndpoint {
    const openDeadlineMs = deps.openDeadlineMs ?? OPEN_DEADLINE_MS;
    const maxChannels = deps.maxChannels ?? MAX_CHANNELS;
    const connectVnc = deps.connectVnc ?? ((port: number) => net.connect({ host: '127.0.0.1', port }));
    const bindings = new WeakMap<Duplex, ViewerTunnelBinding>();
    const tunnels = new Set<TunnelEnd>();
    const closers = new Set<() => void>();

    const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
    const server = http.createServer((_request, response) => {
        response.writeHead(404).end();
    });
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const binding = bindings.get(socket);
        const path = new URL(request.url ?? '/', 'http://viewer').pathname;
        if (!binding || path !== VIEWER_CHANNEL_PATH) {
            socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            return;
        }
        sockets.handleUpgrade(request, socket, head, (ws) => runChannel(ws, binding));
    });

    function runChannel(ws: WebSocket, binding: ViewerTunnelBinding): void {
        let state: 'awaiting-open' | 'opening' | 'open' | 'closed' = 'awaiting-open';
        let vnc: net.Socket | null = null;
        let frames: ReturnType<typeof frameCrypto> | null = null;
        let outSeq = 0;
        let inSeq = 0;
        const deadline = setTimeout(() => end(), openDeadlineMs);
        deadline.unref();

        const end = (reason?: ViewerClosedReason) => {
            if (state === 'closed') return;
            const wasOpen = state === 'open';
            state = 'closed';
            clearTimeout(deadline);
            closers.delete(closeForStop);
            if (wasOpen && reason && frames && ws.readyState === ws.OPEN) {
                ws.send(frames.sealOut(++outSeq, VIEWER_FRAME_KIND.closed, Buffer.from(reason)));
            }
            ws.close();
            vnc?.destroy();
        };
        const closeForStop = () => end('daemon-stopping');
        closers.add(closeForStop);
        const refuse = (reply: { ok: false; sealed?: string }) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(reply));
            end();
        };

        ws.on('close', () => end());
        ws.on('error', () => end());
        ws.on('message', (data: RawData, isBinary: boolean) => {
            if (state === 'awaiting-open') {
                state = 'opening';
                void open(data, isBinary);
                return;
            }
            if (state !== 'open' || !isBinary || !frames || !vnc) {
                end();
                return;
            }
            const opened = frames.openIn(inSeq + 1, toBytes(data));
            if (!opened) {
                logger.debug('[VIEWER-CHANNEL] inbound frame did not open as the next one; closing');
                end();
                return;
            }
            inSeq++;
            if (opened.kind === 'close') end('client-closed');
            else vnc.write(opened.payload);
        });

        async function open(data: RawData, isBinary: boolean): Promise<void> {
            const sealed = isBinary ? null : readBase64(toBytes(data).toString('utf8'));
            const request = sealed ? deps.openSealed(sealed) : null;
            const reading = request ? readBoundOpen(request, { method: VIEWER_CHANNEL_OPEN_METHOD, machineId: deps.machineId, now: Date.now() }) : null;
            if (!reading || reading.kind !== 'bound') {
                refuse({ ok: false });
                return;
            }
            const refuseSealed = (refusal: Refusal) => refuse({ ok: false, sealed: deps.sealBound(bindRpcResponse(reading.nonce, refusal)) });
            const params = readViewerChannelOpenParams(reading.params);
            if (!params) {
                refuseSealed({ code: 'VIEWER_CHANNEL_MALFORMED' });
                return;
            }
            const replayed = admitBoundOpenNonce(deps.nonceGuard, reading, Date.now());
            if (replayed) {
                refuseSealed({ code: replayed.code });
                return;
            }
            if (params.viewerKey !== binding.viewerKey || params.leaseId !== binding.leaseId) {
                refuseSealed({ code: 'VIEWER_CHANNEL_LEASE_MISMATCH' });
                return;
            }
            const target = await deps.resolveTarget(binding).catch(() => null);
            if (state !== 'opening') return;
            if (!target) {
                refuseSealed({ code: 'VIEWER_CHANNEL_LEASE_GONE' });
                return;
            }
            const socket = connectVnc(target.vncPort);
            vnc = socket;
            socket.once('error', (error) => {
                if (state === 'opening') refuseSealed({ code: 'VIEWER_CHANNEL_VNC_UNAVAILABLE' });
                else logger.debug(`[VIEWER-CHANNEL] VNC connection error: ${error.message}`);
            });
            socket.once('connect', () => {
                if (state !== 'opening') {
                    socket.destroy();
                    return;
                }
                const channelKey = decodeBase64(params.channelKey);
                const daemonNonce = new Uint8Array(randomBytes(16));
                frames = frameCrypto(channelKey, daemonNonce, params.leaseId, params.channelId);
                const proofKey = deriveKey(channelKey, new Uint8Array(0), viewerProofKeyInfo(params.channelId));
                const caps: ViewerChannelCaps = { resize: target.resize, maxFrameBytes: VIEWER_FRAME_MAX_PAYLOAD_BYTES };
                const proof = encodeBase64(encryptWithDataKey({
                    viewerChannel: VIEWER_CHANNEL_VERSION,
                    nonce: reading.nonce,
                    channelId: params.channelId,
                    viewerKey: params.viewerKey,
                    leaseId: params.leaseId,
                    display: target.display,
                    daemonNonce: encodeBase64(daemonNonce),
                    caps,
                }, proofKey));
                state = 'open';
                clearTimeout(deadline);
                ws.send(JSON.stringify({ ok: true, proof }));
            });
            socket.on('data', (chunk: Buffer) => {
                if (state !== 'open' || !frames) return;
                for (let at = 0; at < chunk.length; at += VIEWER_FRAME_MAX_PAYLOAD_BYTES) {
                    ws.send(frames.sealOut(++outSeq, VIEWER_FRAME_KIND.rfb, chunk.subarray(at, at + VIEWER_FRAME_MAX_PAYLOAD_BYTES)));
                }
            });
            socket.once('close', () => end('vnc-closed'));
        }
    }

    return {
        attach(binding) {
            const { outer, inner } = createTunnelPair();
            if (tunnels.size >= maxChannels) {
                setImmediate(() => outer.emit('error', new Error(`Too many viewer channels (${maxChannels})`)));
                return outer;
            }
            tunnels.add(outer);
            outer.once('close', () => tunnels.delete(outer));
            bindings.set(inner, binding);
            server.emit('connection', inner);
            setImmediate(() => outer.emit('connect'));
            return outer;
        },
        closeAll() {
            for (const close of [...closers]) close();
            for (const tunnel of [...tunnels]) tunnel.destroy();
        },
        get size() {
            return tunnels.size;
        },
    };
}

function deriveKey(channelKey: Uint8Array, salt: Uint8Array, info: string): Uint8Array {
    return new Uint8Array(hkdfSync(VIEWER_CHANNEL_KEY_HASH, channelKey, salt, Buffer.from(info, 'utf8'), VIEWER_CHANNEL_KEY_LENGTH));
}

/** Per-direction keys of one channel; frames seal and open only under the expected sequence. */
function frameCrypto(channelKey: Uint8Array, daemonNonce: Uint8Array, leaseId: string, channelId: string) {
    const info = (dir: ViewerDirection) => viewerFrameKeyInfo(dir, leaseId, channelId);
    const inKey = deriveKey(channelKey, daemonNonce, info('in'));
    const outKey = deriveKey(channelKey, daemonNonce, info('out'));
    return {
        sealOut(seq: number, kind: number, payload: Buffer): Buffer {
            const cipher = createCipheriv('aes-256-gcm', outKey, viewerFrameNonce('out', seq));
            cipher.setAAD(viewerFrameAad(kind, info('out')));
            const sealed = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
            return Buffer.from(encodeViewerFrame(kind, sealed));
        },
        openIn(seq: number, frame: Buffer): { kind: 'rfb' | 'close'; payload: Buffer } | null {
            const read = readViewerFrame(new Uint8Array(frame), 'in');
            if (!read || read.kind === 'closed') return null;
            try {
                const decipher = createDecipheriv('aes-256-gcm', inKey, viewerFrameNonce('in', seq));
                decipher.setAAD(viewerFrameAad(VIEWER_FRAME_KIND[read.kind], info('in')));
                decipher.setAuthTag(read.sealed.subarray(read.sealed.length - TAG_BYTES));
                const payload = Buffer.concat([decipher.update(read.sealed.subarray(0, read.sealed.length - TAG_BYTES)), decipher.final()]);
                return { kind: read.kind, payload };
            } catch {
                return null;
            }
        },
    };
}

function toBytes(data: RawData): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data)) return Buffer.concat(data);
    return Buffer.from(data);
}

function readBase64(text: string): Uint8Array | null {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
    return decodeBase64(text);
}
