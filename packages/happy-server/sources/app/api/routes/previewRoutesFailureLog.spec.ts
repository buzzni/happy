import { describe, expect, it } from 'vitest';
import { describePreviewRelayFailure } from '@/app/api/routes/previewRoutes';

const ctx = {
    method: 'HEAD',
    machineId: 'c93c0067-f7b4-4b23-84b4-18ae57eff8f4',
    port: 30023,
    userId: 'cmpawdinb0000322g3cko0b6j',
    path: '/assets/index.js',
    candidates: 1,
};

describe('describePreviewRelayFailure', () => {
    it('reports a missing daemon socket as machine-offline 502', () => {
        const failure = describePreviewRelayFailure(
            { kind: 'machine-offline' },
            { ...ctx, candidates: 0 },
        );

        expect(failure.status).toBe(502);
        expect(failure.reason).toBe('machine-offline');
    });

    it('reports a refused upstream connection as its own reason, still 502', () => {
        const failure = describePreviewRelayFailure(
            { kind: 'daemon-error', code: 'CONNECTION_REFUSED', message: 'connect ECONNREFUSED 127.0.0.1:30023' },
            ctx,
        );

        // 502 is unchanged on purpose — web-ui's checkPortReachable() polls
        // for exactly 502/504 to mean "dev server not listening yet".
        expect(failure.status).toBe(502);
        expect(failure.reason).toBe('daemon:CONNECTION_REFUSED');
    });

    it('keeps the daemon status mapping for invalid input and timeouts', () => {
        const status = (code: string) =>
            describePreviewRelayFailure({ kind: 'daemon-error', code, message: 'x' }, ctx).status;

        expect(status('INVALID_PORT')).toBe(400);
        expect(status('INVALID_PATH')).toBe(400);
        expect(status('TIMEOUT')).toBe(504);
        expect(status('UPSTREAM_ERROR')).toBe(502);
        expect(status('SOMETHING_NEW')).toBe(502);
    });

    it('separates a failed cross-replica lookup from a genuinely offline machine', () => {
        // Both answer 502 (checkPortReachable contract), but conflating them in
        // the log is what made the 2026-08-07 cluster-bus outage read as mass
        // daemon disconnects. The reason token has to differ.
        const degraded = describePreviewRelayFailure(
            { kind: 'lookup-degraded' },
            { ...ctx, candidates: 0 },
        );
        const offline = describePreviewRelayFailure(
            { kind: 'machine-offline' },
            { ...ctx, candidates: 0 },
        );

        expect(degraded.status).toBe(502);
        expect(degraded.reason).toBe('lookup-degraded');
        expect(degraded.reason).not.toBe(offline.reason);
        expect(degraded.logLine).toContain('reason=lookup-degraded');
    });

    it('carries every field an operator needs to tell the two causes apart', () => {
        const line = describePreviewRelayFailure(
            { kind: 'daemon-error', code: 'CONNECTION_REFUSED', message: 'connect ECONNREFUSED 127.0.0.1:30023' },
            ctx,
        ).logLine;

        expect(line).toContain('reason=daemon:CONNECTION_REFUSED');
        expect(line).toContain('method=HEAD');
        expect(line).toContain('machine=c93c0067-f7b4-4b23-84b4-18ae57eff8f4');
        expect(line).toContain('port=30023');
        expect(line).toContain('user=cmpawdinb0000322g3cko0b6j');
        expect(line).toContain('path=/assets/index.js');
        expect(line).toContain('connect ECONNREFUSED 127.0.0.1:30023');
    });

    it('reports the candidate socket count so a stale-socket relay is visible', () => {
        const line = describePreviewRelayFailure(
            { kind: 'daemon-error', code: 'UPSTREAM_ERROR', message: 'boom' },
            { ...ctx, candidates: 2 },
        ).logLine;

        expect(line).toContain('candidates=2');
    });

    it('never emits a ptoken, even if one reaches it through the path', () => {
        // buildPreviewUpstreamPath already strips it; this is the backstop for
        // specs/happy-server-log-volume Requirement 4.
        const line = describePreviewRelayFailure(
            { kind: 'machine-offline' },
            { ...ctx, path: '/index.html?ptoken=secret-signed-value&a=1' },
        ).logLine;

        expect(line).not.toContain('secret-signed-value');
        expect(line).not.toContain('ptoken');
        expect(line).toContain('a=1');
    });

    it('stays one line when the request path carries an encoded newline', () => {
        // Fastify URI-decodes `params['*']`, so `%0A` in the preview URL reaches
        // buildPreviewUpstreamPath as a literal newline. Emitting it verbatim
        // would let any authenticated user forge a second log line attributed to
        // a machine that is not theirs — which defeats the whole point of this
        // line existing.
        const line = describePreviewRelayFailure(
            { kind: 'machine-offline' },
            { ...ctx, path: '/foo\npreview relay failed reason=machine-offline machine=VICTIM' },
        ).logLine;

        expect(line).not.toContain('\n');
        expect(line).toContain('path=/foo\\npreview');
    });

    it('stays one line when the daemon error message carries a newline', () => {
        const line = describePreviewRelayFailure(
            { kind: 'daemon-error', code: 'UPSTREAM_ERROR', message: 'boom\r\npreview relay failed machine=VICTIM' },
            ctx,
        ).logLine;

        expect(line).not.toContain('\n');
        expect(line).not.toContain('\r');
        expect(line).toContain('detail=boom\\r\\npreview');
    });
});
