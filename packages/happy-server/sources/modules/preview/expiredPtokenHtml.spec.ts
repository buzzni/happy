import { describe, it, expect } from 'vitest';
import { renderExpiredPtokenHtml, shouldServeExpiredHtml } from '@/modules/preview/expiredPtokenHtml';

const NAVIGATION = { method: 'GET', accept: 'text/html', secFetchDest: 'document', secFetchMode: 'navigate' };

describe('shouldServeExpiredHtml', () => {
    it('serves the page to a top-level or iframe navigation', () => {
        expect(shouldServeExpiredHtml(NAVIGATION)).toBe(true);
        expect(shouldServeExpiredHtml({ ...NAVIGATION, secFetchDest: 'iframe' })).toBe(true);
        expect(shouldServeExpiredHtml({
            ...NAVIGATION,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        })).toBe(true);
        expect(shouldServeExpiredHtml({ ...NAVIGATION, accept: 'TEXT/HTML' })).toBe(true);
    });

    it('still serves a browser navigation that sends no Sec-Fetch headers', () => {
        // Older browsers and non-browser navigations do not send them; the
        // Accept header is what we had before and stays the fallback.
        expect(shouldServeExpiredHtml({ method: 'GET', accept: 'text/html' })).toBe(true);
    });

    it('returns false for JSON/curl callers', () => {
        expect(shouldServeExpiredHtml({ method: 'GET', accept: 'application/json' })).toBe(false);
        expect(shouldServeExpiredHtml({ method: 'GET', accept: '*/*' })).toBe(false);
        expect(shouldServeExpiredHtml({ method: 'GET' })).toBe(false);
        expect(shouldServeExpiredHtml({ method: 'GET', accept: '' })).toBe(false);
    });

    it('never serves a self-reloading page to a subresource', () => {
        // A script or stylesheet that receives this HTML would execute the
        // re-mint in the *preview app's* origin and reload it under the app,
        // and an image would just render as garbage. Only a navigation can
        // act on it.
        for (const dest of ['script', 'style', 'image', 'font', 'empty', 'audio', 'video', 'object']) {
            expect(shouldServeExpiredHtml({ ...NAVIGATION, secFetchDest: dest })).toBe(false);
        }
        expect(shouldServeExpiredHtml({ ...NAVIGATION, secFetchDest: 'empty', secFetchMode: 'cors' })).toBe(false);
    });

    it('never serves it in answer to a mutation', () => {
        // The page reloads the URL it was served for. Doing that after a POST
        // would re-issue the mutation the moment the token is refreshed.
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            expect(shouldServeExpiredHtml({ ...NAVIGATION, method })).toBe(false);
        }
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

    it('uses sessionStorage to break an infinite mint loop', () => {
        const html = renderExpiredPtokenHtml(baseParams);
        expect(html).toContain('sessionStorage');
        // The key name doesn't matter as long as it's used to gate the mint attempt
        expect(html).toMatch(/aplus[-_]preview[-_]mint/);
    });

    /**
     * Runs the page's own inline script against stub browser globals. The
     * recovery budget is a behaviour, not a string in the source, and this is
     * the only way to show that two restarts really do both recover.
     */
    function runMintScript(html: string, env: { storage: Map<string, string>; now: number }) {
        const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));
        const statusEl = { textContent: '' };
        const minted: unknown[] = [];
        const sessionStorage = {
            getItem: (k: string) => env.storage.get(k) ?? null,
            setItem: (k: string, v: string) => { env.storage.set(k, v); },
        };
        const localStorage = { getItem: () => 'aplus-token-value' };
        const fetchStub = (_url: string, init: { body: string }) => {
            minted.push(JSON.parse(init.body));
            return Promise.resolve({ status: 200, json: () => Promise.resolve({ token: 'fresh' }) });
        };
        const fakeDate = { now: () => env.now };
        new Function(
            'document', 'sessionStorage', 'localStorage', 'fetch', 'location', 'URL', 'Date',
            script,
        )(
            { getElementById: () => statusEl },
            sessionStorage,
            localStorage,
            fetchStub,
            { href: 'https://preview.example/app', replace: () => { /* navigation */ } },
            URL,
            fakeDate,
        );
        return {
            status: () => statusEl.textContent,
            attempted: () => minted.length > 0,
            mintBody: () => minted[0] as Record<string, unknown>,
        };
    }

    it('sends the token it is replacing so the re-mint can stay bound', () => {
        // Without this the re-mint has no way to know the session it is
        // recovering was bound, and would come back unbound whenever the
        // policy is off — losing the ACL and runtime checks it already had.
        const env = { storage: new Map<string, string>(), now: 1_000_000 };
        const run = runMintScript(
            renderExpiredPtokenHtml({ ...baseParams, previousToken: 'prev.token-value' }),
            env,
        );
        expect(run.mintBody()).toMatchObject({ previousToken: 'prev.token-value' });
    });

    it('omits the field entirely when there was no previous token', () => {
        const env = { storage: new Map<string, string>(), now: 1_000_000 };
        const run = runMintScript(renderExpiredPtokenHtml(baseParams), env);
        expect(run.mintBody()).not.toHaveProperty('previousToken');
    });

    it('escapes the previous token so it cannot break out of the script', () => {
        const html = renderExpiredPtokenHtml({ ...baseParams, previousToken: '</script><script>alert(1)</script>' });
        expect(html).not.toContain('</script><script>alert(1)</script>');
    });

    it('recovers from a second dev-server restart in the same tab', () => {
        // A once-per-tab latch answers the second restart with a dead page
        // that only a manual reopen fixes. Both restarts here are ordinary
        // and both have to re-mint.
        const env = { storage: new Map<string, string>(), now: 1_000_000 };
        const first = runMintScript(renderExpiredPtokenHtml(baseParams), env);
        expect(first.attempted()).toBe(true);

        env.now += 5 * 60_000;
        const second = runMintScript(renderExpiredPtokenHtml(baseParams), env);
        expect(second.attempted()).toBe(true);
    });

    it('gives up once the budget is spent inside one window', () => {
        const env = { storage: new Map<string, string>(), now: 1_000_000 };
        const attempts = [0, 1, 2, 3, 4].map(() => runMintScript(renderExpiredPtokenHtml(baseParams), env));

        expect(attempts.slice(0, 3).every((run) => run.attempted())).toBe(true);
        expect(attempts[3].attempted()).toBe(false);
        expect(attempts[4].attempted()).toBe(false);
        expect(attempts[3].status()).toMatch(/반복/);
    });

    it('lets the budget age out so a later restart is not held against it', () => {
        const env = { storage: new Map<string, string>(), now: 1_000_000 };
        for (let i = 0; i < 3; i += 1) runMintScript(renderExpiredPtokenHtml(baseParams), env);
        expect(runMintScript(renderExpiredPtokenHtml(baseParams), env).attempted()).toBe(false);

        env.now += 61_000;
        expect(runMintScript(renderExpiredPtokenHtml(baseParams), env).attempted()).toBe(true);
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
