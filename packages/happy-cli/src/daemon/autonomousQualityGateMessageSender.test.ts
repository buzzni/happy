import { describe, expect, it, vi } from 'vitest';
import { decodeBase64, decrypt } from '../api/encryption';
import { sendAutonomousQualityGateRepair } from './autonomousQualityGateMessageSender';

describe('sendAutonomousQualityGateRepair', () => {
    it('posts a daemon-authored encrypted user message into the existing session', async () => {
        const post = vi.fn(async (
            _url: string,
            _body: { messages: Array<{ localId: string; content: string }> },
            _options: { headers: Record<string, string>; timeout: number; signal?: AbortSignal },
        ) => undefined);
        const key = new Uint8Array(32).fill(7);
        const controller = new AbortController();

        await sendAutonomousQualityGateRepair({
            sessionId: 'session/one',
            message: 'repair this failure',
            token: 'machine-token',
            serverUrl: 'https://happy.example',
            encryption: { encryptionKey: key, encryptionVariant: 'legacy' },
            signal: controller.signal,
            timeoutMs: 1_234,
            post,
        });

        expect(post).toHaveBeenCalledOnce();
        const [url, body, options] = post.mock.calls[0];
        expect(url).toBe('https://happy.example/v3/sessions/session%2Fone/messages');
        expect(options.headers.Authorization).toBe('Bearer machine-token');
        expect(options.timeout).toBe(1_234);
        expect(options.signal).toBe(controller.signal);
        expect(body.messages).toHaveLength(1);
        expect(decrypt(key, 'legacy', decodeBase64(body.messages[0].content))).toEqual({
            role: 'user',
            content: { type: 'text', text: 'repair this failure' },
            meta: { sentFrom: 'daemon', source: 'autonomous-quality-gate' },
        });
    });
});
