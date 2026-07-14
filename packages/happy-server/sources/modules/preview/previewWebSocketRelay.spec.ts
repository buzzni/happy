import { describe, it, expect } from 'vitest';
import {
    parsePreviewUpgradeRequest,
    parsePreviewUpgradeUrl,
    openPreviewWsTunnel,
    serializeUpgradeRequest,
    stripPreviewAuthCookie,
} from '@/modules/preview/previewWebSocketRelay';

describe('parsePreviewUpgradeUrl', () => {
    it('parses machineId, port, subPath, and query', () => {
        const parsed = parsePreviewUpgradeUrl('/v1/preview/mac-1/6080/websockify?ptoken=abc&x=1');
        expect(parsed).not.toBeNull();
        expect(parsed!.machineId).toBe('mac-1');
        expect(parsed!.port).toBe(6080);
        expect(parsed!.subPath).toBe('/websockify');
        expect(parsed!.query.get('ptoken')).toBe('abc');
        expect(parsed!.query.get('x')).toBe('1');
    });

    it('defaults subPath to / when absent', () => {
        const parsed = parsePreviewUpgradeUrl('/v1/preview/mac-1/6080');
        expect(parsed!.subPath).toBe('/');
    });

    it('returns null for non-preview paths', () => {
        expect(parsePreviewUpgradeUrl('/v1/updates')).toBeNull();
        expect(parsePreviewUpgradeUrl('/socket.io/')).toBeNull();
        expect(parsePreviewUpgradeUrl('/v1/preview/mac-1/notaport/ws')).toBeNull();
    });

    it('rejects out-of-range ports', () => {
        expect(parsePreviewUpgradeUrl('/v1/preview/mac-1/0/ws')).toBeNull();
        expect(parsePreviewUpgradeUrl('/v1/preview/mac-1/70000/ws')).toBeNull();
    });
});

describe('openPreviewWsTunnel', () => {
    it('falls back to another live daemon socket when the first one is stale', async () => {
        const socket = (id: string, response: unknown) => ({
            id,
            timeout: () => ({ emitWithAck: async () => {
                if (response instanceof Error) throw response;
                return response;
            } }),
        });
        const stale = socket('stale', new Error('timeout'));
        const fresh = socket('fresh', { ok: true });

        await expect(openPreviewWsTunnel(
            [stale, fresh],
            { tunnelId: 'tunnel-1', port: 40002, dataB64: '' },
            10,
        )).resolves.toBe(fresh);
    });
});

describe('parsePreviewUpgradeRequest', () => {
    it('maps a root path on an isolated preview host to the matching upstream', () => {
        const parsed = parsePreviewUpgradeRequest(
            '/_expo/ws?platform=web',
            '6b8a8c22-9439-4d4f-b4c6-9e7f13027818-40002.preview.saycode.ai',
        );
        expect(parsed).toMatchObject({
            machineId: '6b8a8c22-9439-4d4f-b4c6-9e7f13027818',
            port: 40002,
            subPath: '/_expo/ws',
        });
        expect(parsed!.query.get('platform')).toBe('web');
    });

    it('ignores unrelated hosts and upgrade paths', () => {
        expect(parsePreviewUpgradeRequest('/socket.io/', 'saycode.ai')).toBeNull();
    });
});

describe('stripPreviewAuthCookie', () => {
    it('keeps app cookies but does not expose the relay token upstream', () => {
        expect(stripPreviewAuthCookie(
            ['Host', 'preview', 'Cookie', 'theme=dark; happy_preview_machine-1_40002=secret; app=1'],
            'machine-1',
            40002,
        )).toEqual(['Host', 'preview', 'Cookie', 'theme=dark; app=1']);
    });
});

describe('serializeUpgradeRequest', () => {
    it('rebuilds a valid HTTP upgrade request with Host rewritten to loopback', () => {
        const rawHeaders = [
            'Host', 'preview.example.com',
            'Upgrade', 'websocket',
            'Connection', 'Upgrade',
            'Sec-WebSocket-Key', 'dGhlIHNhbXBsZQ==',
            'Sec-WebSocket-Version', '13',
        ];
        const bytes = serializeUpgradeRequest('GET', '/websockify', 6080, rawHeaders, Buffer.alloc(0));
        const text = bytes.toString('utf-8');

        expect(text.startsWith('GET /websockify HTTP/1.1\r\n')).toBe(true);
        expect(text).toContain('Host: 127.0.0.1:6080\r\n');
        expect(text).toContain('Upgrade: websocket\r\n');
        expect(text).toContain('Sec-WebSocket-Key: dGhlIHNhbXBsZQ==\r\n');
        expect(text.endsWith('\r\n\r\n')).toBe(true);
    });

    it('appends any upgrade head bytes after the header block', () => {
        const bytes = serializeUpgradeRequest('GET', '/ws', 3000, ['Host', 'x'], Buffer.from('EARLYBYTES'));
        const text = bytes.toString('utf-8');
        expect(text).toContain('\r\n\r\nEARLYBYTES');
    });
});
