import { describe, expect, it } from 'vitest';

import {
    MAX_AUTONOMOUS_FINGERPRINT_CONTENT_BYTES,
    MAX_AUTONOMOUS_FINGERPRINT_FILE_BYTES,
    planAutonomousFingerprintInputs,
    redactAutonomousGateText,
} from './autonomousQualityGateSafety';

describe('autonomous quality gate fingerprint safety', () => {
    it('includes source, tests, and verify configuration while excluding secret and unsafe paths', () => {
        const plan = planAutonomousFingerprintInputs([
            { path: 'src/app.ts', size: 120, binary: false },
            { path: 'tests/app.test.ts', size: 140, binary: false },
            { path: '.aplus/verify.json', size: 80, binary: false },
            { path: '.env.production', size: 40, binary: false },
            { path: 'certs/client.pem', size: 80, binary: false },
            { path: '.git/config', size: 90, binary: false },
            { path: '../outside.ts', size: 50, binary: false },
        ]);

        expect(plan.entries).toEqual([
            { path: '.aplus/verify.json', mode: 'content', maxBytes: 80 },
            { path: 'src/app.ts', mode: 'content', maxBytes: 120 },
            { path: 'tests/app.test.ts', mode: 'content', maxBytes: 140 },
        ]);
        expect(plan.excludedCount).toBe(4);
    });

    it('uses metadata only for binary and oversized files and caps aggregate content reads', () => {
        const plan = planAutonomousFingerprintInputs([
            { path: 'assets/logo.png', size: 1_000, binary: true },
            { path: 'src/huge.ts', size: MAX_AUTONOMOUS_FINGERPRINT_FILE_BYTES + 1, binary: false },
            { path: 'src/a.ts', size: MAX_AUTONOMOUS_FINGERPRINT_FILE_BYTES, binary: false },
            { path: 'src/b.ts', size: MAX_AUTONOMOUS_FINGERPRINT_FILE_BYTES, binary: false },
            { path: 'src/c.ts', size: 1, binary: false },
        ]);

        expect(plan.entries).toEqual([
            { path: 'assets/logo.png', mode: 'metadata', maxBytes: 0 },
            { path: 'src/a.ts', mode: 'content', maxBytes: MAX_AUTONOMOUS_FINGERPRINT_FILE_BYTES },
            { path: 'src/b.ts', mode: 'content', maxBytes: MAX_AUTONOMOUS_FINGERPRINT_FILE_BYTES },
            { path: 'src/c.ts', mode: 'metadata', maxBytes: 0 },
            { path: 'src/huge.ts', mode: 'metadata', maxBytes: 0 },
        ]);
        expect(plan.contentBytes).toBe(MAX_AUTONOMOUS_FINGERPRINT_CONTENT_BYTES);
    });
});

describe('autonomous quality gate output redaction', () => {
    it('redacts credential assignments, authorization headers, and common bare token formats', () => {
        const output = [
            'OPENAI_API_KEY=sk-live-secret-value',
            'Authorization: Bearer bearer-secret-value',
            '{"accessToken":"json-secret-value","safe":"visible"}',
            'push failed for ghp_123456789012345678901234567890123456',
        ].join('\n');

        const redacted = redactAutonomousGateText(output);

        expect(redacted).toContain('safe');
        expect(redacted).toContain('visible');
        expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(4);
        expect(redacted).not.toContain('sk-live-secret-value');
        expect(redacted).not.toContain('bearer-secret-value');
        expect(redacted).not.toContain('json-secret-value');
        expect(redacted).not.toContain('ghp_123456789012345678901234567890123456');
    });
});
