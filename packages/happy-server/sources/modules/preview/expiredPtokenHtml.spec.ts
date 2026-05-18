import { describe, it, expect } from 'vitest';
import { renderExpiredPtokenHtml, shouldServeExpiredHtml } from '@/modules/preview/expiredPtokenHtml';

describe('shouldServeExpiredHtml', () => {
    it('returns true when Accept includes text/html', () => {
        expect(shouldServeExpiredHtml('text/html')).toBe(true);
        expect(
            shouldServeExpiredHtml(
                'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            ),
        ).toBe(true);
        expect(shouldServeExpiredHtml('TEXT/HTML')).toBe(true);
    });

    it('returns false for JSON/curl callers', () => {
        expect(shouldServeExpiredHtml('application/json')).toBe(false);
        expect(shouldServeExpiredHtml('*/*')).toBe(false);
        expect(shouldServeExpiredHtml(undefined)).toBe(false);
        expect(shouldServeExpiredHtml('')).toBe(false);
    });
});

describe('renderExpiredPtokenHtml', () => {
    const baseParams = {
        machineId: 'mid-abc',
        port: 3000,
        reason: 'expired-or-invalid' as const,
    };

    it('embeds the machineId and port for the client mint payload', () => {
        const html = renderExpiredPtokenHtml(baseParams);
        // The inline JS posts these to /api/preview-mint-remote
        expect(html).toContain('"mid-abc"');
        expect(html).toContain('3000');
    });

    it('hits /api/preview-mint-remote (relative URL so it routes through web-ui)', () => {
        const html = renderExpiredPtokenHtml(baseParams);
        expect(html).toContain('/api/preview-mint-remote');
    });

    it('reads aplus-token + aplus-active-company from localStorage', () => {
        const html = renderExpiredPtokenHtml(baseParams);
        expect(html).toContain("localStorage.getItem('aplus-token')");
        expect(html).toContain("localStorage.getItem('aplus-active-company')");
    });

    it('uses sessionStorage to break infinite loop on repeat-failure within the same tab', () => {
        const html = renderExpiredPtokenHtml(baseParams);
        expect(html).toContain('sessionStorage');
        // The key name doesn't matter as long as it's used to gate the mint attempt
        expect(html).toMatch(/aplus[-_]preview[-_]mint/);
    });

    it('JSON-escapes the machineId so a hostile machineId cannot break out of the JS string', () => {
        const html = renderExpiredPtokenHtml({
            ...baseParams,
            machineId: 'evil"; alert(1); //',
        });
        // We use JSON.stringify for embedding — the double quote becomes \"
        // so the script literally reads `"evil\"; alert(1); //"` which the
        // browser parses as one string value, not as executable statements.
        expect(html).toContain('"evil\\"; alert(1); //"');
    });

    it('defends against </script> closing-tag injection in machineId', () => {
        const html = renderExpiredPtokenHtml({
            ...baseParams,
            machineId: '</script><script>alert(1)</script>',
        });
        // jsString() rewrites `</script` to `<\/script` inside the JSON literal
        // so an attacker-controlled string can't terminate the host <script>.
        expect(html).not.toContain('</script><script>alert(1)</script>');
    });

    it('returns a complete HTML document with korean-ui safety meta tags', () => {
        const html = renderExpiredPtokenHtml(baseParams);
        expect(html.startsWith('<!doctype html>')).toBe(true);
        expect(html).toContain('charset="utf-8"');
        expect(html.toLowerCase()).toContain('<title>');
    });

    it('explains the recovery action when reason=missing (no ptoken in URL)', () => {
        const html = renderExpiredPtokenHtml({ ...baseParams, reason: 'missing' });
        // Korean-language guidance per project locale
        expect(html).toMatch(/세션|프리뷰|만료|토큰/);
    });
});
