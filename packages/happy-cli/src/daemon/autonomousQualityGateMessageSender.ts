import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { encodeBase64, encrypt } from '../api/encryption';

interface MessageSenderInput {
    sessionId: string;
    message: string;
    token: string;
    serverUrl: string;
    encryption: {
        encryptionKey: Uint8Array;
        encryptionVariant: 'legacy' | 'dataKey';
    };
    post?: (
        url: string,
        body: { messages: Array<{ localId: string; content: string }> },
        options: { headers: Record<string, string>; timeout: number },
    ) => Promise<unknown>;
}

export async function sendAutonomousQualityGateRepair(input: MessageSenderInput): Promise<void> {
    const content = encodeBase64(encrypt(
        input.encryption.encryptionKey,
        input.encryption.encryptionVariant,
        {
            role: 'user',
            content: { type: 'text', text: input.message },
            meta: { sentFrom: 'daemon', source: 'autonomous-quality-gate' },
        },
    ));
    const post = input.post ?? axios.post;
    await post(
        `${input.serverUrl}/v3/sessions/${encodeURIComponent(input.sessionId)}/messages`,
        { messages: [{ localId: randomUUID(), content }] },
        {
            headers: {
                Authorization: `Bearer ${input.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': 'cli-daemon/autonomous-quality-gate',
            },
            timeout: 60_000,
        },
    );
}
