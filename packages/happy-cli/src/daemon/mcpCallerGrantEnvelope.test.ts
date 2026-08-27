import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { encodeBase64, libsodiumEncryptForPublicKey } from '@/api/encryption';
import {
    injectMcpCallerGrant,
    McpCallerGrantEnvelopeConsumer,
    prepareMcpChildEnvironment,
} from './mcpCallerGrantEnvelope';

const PROJECT_CONTEXT = { projectId: 'P-1' };

function grant(input: {
    machineId?: string;
    projectId?: string | null;
    now?: number;
    exp?: number;
    nonce?: string;
} = {}): string {
    const now = input.now ?? 1_000;
    const payload = Buffer.from(JSON.stringify({
        version: 1,
        userId: 'U-1',
        machineId: input.machineId ?? 'M-1',
        projectId: input.projectId === undefined ? 'P-1' : input.projectId,
        iat: now,
        exp: input.exp ?? now + 10_000,
        nonce: input.nonce ?? 'N-1',
    })).toString('base64url');
    return `${payload}.opaque-server-signature`;
}

function envelope(token: string, publicKey: Uint8Array): string {
    return encodeBase64(libsodiumEncryptForPublicKey(new TextEncoder().encode(token), publicKey));
}

describe('McpCallerGrantEnvelopeConsumer', () => {
    it('resume child용 envelope를 검증하고 project-aware MCP env를 만든다', () => {
        const keyPair = tweetnacl.box.keyPair();
        const consumer = new McpCallerGrantEnvelopeConsumer({
            machineId: 'M-1', secretKey: keyPair.secretKey, now: () => 2_000,
        });

        const result = prepareMcpChildEnvironment({
            environmentVariables: {
                SAFE: 'value',
                HAPPY_APLUS_MCP_CALLER_GRANT: 'stale-grant',
            },
            mcpCallerGrantEnvelope: envelope(grant(), keyPair.publicKey),
            mcpConfigProjectId: 'P-1',
            expectedConnectors: ['gmail', 'knoi'],
            lifecycle: 'resume',
            trustedConfigUrl: 'https://saycode.ai/api/me/mcp-config',
        }, consumer);

        expect(result).toEqual({
            ok: true,
            environmentVariables: {
                SAFE: 'value',
                HAPPY_APLUS_MCP_CALLER_GRANT: grant(),
                HAPPY_APLUS_MCP_CONFIG_URL: 'https://saycode.ai/api/me/mcp-config?project_id=P-1',
                HAPPY_APLUS_EXPECTED_CONNECTORS: '["gmail","knoi"]',
                HAPPY_APLUS_MCP_INITIAL_LIFECYCLE: 'resume',
            },
        });
    });

    it('resume child용 envelope가 잘못되면 축소 권한 env를 만들지 않는다', () => {
        const keyPair = tweetnacl.box.keyPair();
        const consumer = new McpCallerGrantEnvelopeConsumer({
            machineId: 'M-1', secretKey: keyPair.secretKey, now: () => 2_000,
        });

        expect(prepareMcpChildEnvironment({
            environmentVariables: { SAFE: 'value' },
            mcpCallerGrantEnvelope: envelope(grant({ projectId: 'P-2' }), keyPair.publicKey),
            mcpConfigProjectId: 'P-1',
            trustedConfigUrl: 'https://saycode.ai/api/me/mcp-config',
        }, consumer)).toEqual({ ok: false, reason: 'wrong-project' });
    });

    it('caller의 HAPPY_APLUS env를 제거하고 daemon URL과 복호화 grant만 주입한다', () => {
        expect(injectMcpCallerGrant({
            SAFE: 'value',
            HAPPY_APLUS_MCP_CALLER_GRANT: 'client-supplied-grant',
            HAPPY_APLUS_MCP_CONFIG_URL: 'https://attacker.test/collect',
            HAPPY_APLUS_EXPECTED_CONNECTORS: '["attacker"]',
            HAPPY_APLUS_OTHER: 'caller-controlled',
            HAPPY_BROWSER_VIEWER_KEY: 'bv1_attacker',
        }, undefined, 'https://saycode.ai/api/me/mcp-config', 'P-1', ['gmail'], 'spawn')).toEqual({
            SAFE: 'value',
            HAPPY_APLUS_MCP_CONFIG_URL: 'https://saycode.ai/api/me/mcp-config?project_id=P-1',
            HAPPY_APLUS_EXPECTED_CONNECTORS: '["gmail"]',
            HAPPY_APLUS_MCP_INITIAL_LIFECYCLE: 'spawn',
        });
        expect(injectMcpCallerGrant({
            SAFE: 'value',
            HAPPY_APLUS_MCP_CALLER_GRANT: 'client-supplied-grant',
            HAPPY_APLUS_MCP_CONFIG_URL: 'https://attacker.test/collect',
        }, 'decrypted-grant', 'https://saycode.ai/api/me/mcp-config', 'P-1')).toEqual({
            SAFE: 'value',
            HAPPY_APLUS_MCP_CONFIG_URL: 'https://saycode.ai/api/me/mcp-config?project_id=P-1',
            HAPPY_APLUS_MCP_CALLER_GRANT: 'decrypted-grant',
        });
    });

    it('daemon process key로 암호화된 grant를 한 번만 복호화한다', () => {
        const keyPair = tweetnacl.box.keyPair();
        const consumer = new McpCallerGrantEnvelopeConsumer({
            machineId: 'M-1',
            secretKey: keyPair.secretKey,
            now: () => 2_000,
        });
        const encrypted = envelope(grant(), keyPair.publicKey);

        expect(consumer.consume(encrypted, PROJECT_CONTEXT)).toEqual({ ok: true, grant: grant() });
        expect(consumer.consume(encrypted, PROJECT_CONTEXT)).toEqual({ ok: false, reason: 'replayed' });
    });

    it('다른 process key로 암호화됐거나 malformed인 envelope를 거부한다', () => {
        const daemon = tweetnacl.box.keyPair();
        const other = tweetnacl.box.keyPair();
        const consumer = new McpCallerGrantEnvelopeConsumer({
            machineId: 'M-1', secretKey: daemon.secretKey, now: () => 2_000,
        });

        expect(consumer.consume(envelope(grant(), other.publicKey), PROJECT_CONTEXT)).toEqual({
            ok: false, reason: 'invalid-envelope',
        });
        expect(consumer.consume('not-base64', PROJECT_CONTEXT)).toEqual({
            ok: false, reason: 'invalid-envelope',
        });
    });

    it('다른 machine, 만료, 과도한 수명의 grant를 cache에 넣지 않고 거부한다', () => {
        const keyPair = tweetnacl.box.keyPair();
        const consumer = new McpCallerGrantEnvelopeConsumer({
            machineId: 'M-1', secretKey: keyPair.secretKey, now: () => 2_000,
        });

        expect(consumer.consume(
            envelope(grant({ machineId: 'M-2' }), keyPair.publicKey),
            PROJECT_CONTEXT,
        )).toEqual({
            ok: false, reason: 'wrong-machine',
        });
        expect(consumer.consume(
            envelope(grant({ projectId: 'P-2' }), keyPair.publicKey),
            { projectId: 'P-1' },
        )).toEqual({ ok: false, reason: 'wrong-project' });
        expect(consumer.consume(
            envelope(grant({ exp: 1_999 }), keyPair.publicKey),
            PROJECT_CONTEXT,
        )).toEqual({
            ok: false, reason: 'expired',
        });
        expect(consumer.consume(
            envelope(grant({ exp: 90_000_000 }), keyPair.publicKey),
            PROJECT_CONTEXT,
        )).toEqual({
            ok: false, reason: 'invalid-grant',
        });
    });

    it('활성 replay cache가 가득 차면 기존 항목을 eviction하지 않고 새 grant를 거부한다', () => {
        const keyPair = tweetnacl.box.keyPair();
        const consumer = new McpCallerGrantEnvelopeConsumer({
            machineId: 'M-1', secretKey: keyPair.secretKey, now: () => 2_000, maxEntries: 1,
        });
        const first = envelope(grant({ nonce: 'N-1' }), keyPair.publicKey);
        const second = envelope(grant({ nonce: 'N-2' }), keyPair.publicKey);

        expect(consumer.consume(first, PROJECT_CONTEXT).ok).toBe(true);
        expect(consumer.consume(second, PROJECT_CONTEXT)).toEqual({ ok: false, reason: 'capacity' });
        expect(consumer.consume(first, PROJECT_CONTEXT)).toEqual({ ok: false, reason: 'replayed' });
    });
});
