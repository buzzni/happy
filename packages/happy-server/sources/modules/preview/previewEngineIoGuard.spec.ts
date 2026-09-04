import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
    shouldBypassEngineIoForPreviewSubdomain,
    wrapServerForPreviewSubdomainBypass,
} from '@/modules/preview/previewEngineIoGuard';

const MID = '12345678-1234-1234-1234-123456789abc';
const PREVIEW_HOST = `${MID}-30012.preview.saycode.ai`;

describe('shouldBypassEngineIoForPreviewSubdomain', () => {
    it('is true for /v1/updates on a preview-subdomain host', () => {
        expect(shouldBypassEngineIoForPreviewSubdomain('/v1/updates/?EIO=4&transport=polling', PREVIEW_HOST))
            .toBe(true);
    });

    it('is true for the bare /v1/updates path (no trailing slash or query)', () => {
        expect(shouldBypassEngineIoForPreviewSubdomain('/v1/updates', PREVIEW_HOST)).toBe(true);
    });

    it('is false on the studio root host (engine.io owns /v1/updates there)', () => {
        expect(shouldBypassEngineIoForPreviewSubdomain('/v1/updates/?EIO=4&transport=polling', 'saycode.ai'))
            .toBe(false);
    });

    it('is false for a preview-subdomain host on an unrelated path', () => {
        expect(shouldBypassEngineIoForPreviewSubdomain('/', PREVIEW_HOST)).toBe(false);
        expect(shouldBypassEngineIoForPreviewSubdomain('/v1/preview/x', PREVIEW_HOST)).toBe(false);
    });

    it('does not match a path that merely starts with the same prefix', () => {
        expect(shouldBypassEngineIoForPreviewSubdomain('/v1/updates-not-real', PREVIEW_HOST)).toBe(false);
    });

    it('is false for undefined url or host', () => {
        expect(shouldBypassEngineIoForPreviewSubdomain(undefined, PREVIEW_HOST)).toBe(false);
        expect(shouldBypassEngineIoForPreviewSubdomain('/v1/updates', undefined)).toBe(false);
    });
});

/**
 * engine.io's `attach()` (see engine.io/build/server.js) captures the
 * server's pre-existing `request` listeners via `.listeners('request')`,
 * then `.removeAllListeners('request')`s them, then installs its own single
 * listener that checks the path and either handles the request itself or
 * calls the captured listeners as a fallback. For `upgrade` there is no
 * capture/wipe — it just adds a co-equal listener that, on a non-matching
 * path, leaves the socket alone (given `destroyUpgrade:false`) for whichever
 * *other* listener (registered before or after) picks it up.
 *
 * These tests drive `wrapServerForPreviewSubdomainBypass` through the exact
 * same calls engine.io's attach() makes, against a plain EventEmitter
 * standing in for the real HTTP server, to verify the proxy produces the
 * correct routing without needing a real engine.io/socket.io instance.
 */
describe('wrapServerForPreviewSubdomainBypass', () => {
    function fakeReq(url: string, host: string) {
        return { url, headers: { host } } as import('node:http').IncomingMessage;
    }

    it('request: routes a preview-subdomain /v1/updates request to the pre-existing (Fastify) listener instead of engine.io', () => {
        const real = new EventEmitter();
        const fastify = vi.fn();
        real.on('request', fastify);

        const wrapped = wrapServerForPreviewSubdomainBypass(real as unknown as import('node:http').Server);
        const captured = wrapped.listeners('request');
        wrapped.removeAllListeners('request');
        const engineIo = vi.fn();
        wrapped.on('request', engineIo);

        expect(captured).toHaveLength(1);
        const req = fakeReq('/v1/updates/?EIO=4&transport=polling', PREVIEW_HOST);
        const res = {} as import('node:http').ServerResponse;
        real.emit('request', req, res);

        expect(fastify).toHaveBeenCalledWith(req, res);
        expect(engineIo).not.toHaveBeenCalled();
    });

    it('request: leaves a normal (non-preview) /v1/updates request for engine.io', () => {
        const real = new EventEmitter();
        const fastify = vi.fn();
        real.on('request', fastify);

        const wrapped = wrapServerForPreviewSubdomainBypass(real as unknown as import('node:http').Server);
        wrapped.listeners('request');
        wrapped.removeAllListeners('request');
        const engineIo = vi.fn();
        wrapped.on('request', engineIo);

        const req = fakeReq('/v1/updates/?EIO=4&transport=polling', 'saycode.ai');
        const res = {} as import('node:http').ServerResponse;
        real.emit('request', req, res);

        expect(engineIo).toHaveBeenCalledWith(req, res);
        expect(fastify).not.toHaveBeenCalled();
    });

    it('request: leaves a preview-subdomain request on an unrelated path for engine.io', () => {
        const real = new EventEmitter();
        const fastify = vi.fn();
        real.on('request', fastify);

        const wrapped = wrapServerForPreviewSubdomainBypass(real as unknown as import('node:http').Server);
        wrapped.listeners('request');
        wrapped.removeAllListeners('request');
        const engineIo = vi.fn();
        wrapped.on('request', engineIo);

        const req = fakeReq('/', PREVIEW_HOST);
        const res = {} as import('node:http').ServerResponse;
        real.emit('request', req, res);

        expect(engineIo).toHaveBeenCalledWith(req, res);
        expect(fastify).not.toHaveBeenCalled();
    });

    it('upgrade: does not invoke engine.io for a preview-subdomain /v1/updates upgrade, leaving it for a later listener', () => {
        const real = new EventEmitter();
        const wrapped = wrapServerForPreviewSubdomainBypass(real as unknown as import('node:http').Server);
        const engineIo = vi.fn();
        wrapped.on('upgrade', engineIo);
        // Registered after, directly on the real server — mirrors
        // previewWebSocketRelay's own registration order in api.ts.
        const relay = vi.fn();
        real.on('upgrade', relay);

        const req = fakeReq('/v1/updates?EIO=4&transport=websocket', PREVIEW_HOST);
        const socket = {} as import('node:net').Socket;
        const head = Buffer.alloc(0);
        real.emit('upgrade', req, socket, head);

        expect(engineIo).not.toHaveBeenCalled();
        expect(relay).toHaveBeenCalledWith(req, socket, head);
    });

    it('upgrade: invokes engine.io for a normal (non-preview) /v1/updates upgrade', () => {
        const real = new EventEmitter();
        const wrapped = wrapServerForPreviewSubdomainBypass(real as unknown as import('node:http').Server);
        const engineIo = vi.fn();
        wrapped.on('upgrade', engineIo);

        const req = fakeReq('/v1/updates?EIO=4&transport=websocket', 'saycode.ai');
        const socket = {} as import('node:net').Socket;
        const head = Buffer.alloc(0);
        real.emit('upgrade', req, socket, head);

        expect(engineIo).toHaveBeenCalledWith(req, socket, head);
    });

    it('passes through unrelated events and methods to the real server unchanged', () => {
        const real = new EventEmitter();
        const wrapped = wrapServerForPreviewSubdomainBypass(real as unknown as import('node:http').Server);
        const closeCb = vi.fn();
        wrapped.on('close', closeCb);
        real.emit('close');
        expect(closeCb).toHaveBeenCalled();
    });
});
