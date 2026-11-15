import { describe, expect, it } from 'vitest';
import { AutomationReadDiagnostics, automationReadSource, isAutomationReadRoute } from './automationReadDiagnostics';

const request = { accountId: 'account', projectId: 'project', route: '/v1/projects/:projectId/automations', source: 'socket', status: 200 };
describe('automation read diagnostics', () => {
    it('summarizes the current partial window across routes, clients, sources and unique projects', () => {
        const observer = new AutomationReadDiagnostics();
        for (let i = 0; i < 29; i++) observer.observe({ ...request, projectId: `p-${i % 3}`, client: 'desktop/0.1.88' }, 1_000);
        const sample = observer.observe({ ...request, projectId: 'last', client: 'desktop/0.1.89',
            route: '/v1/projects/:projectId/automation-runs', source: 'poll' }, 1_500);
        expect(sample).toMatchObject({ count: 30, windowMs: 10_000, windowElapsedMs: 500,
            countsByRoute: { [request.route]: 29, '/v1/projects/:projectId/automation-runs': 1 },
            countsBySource: { socket: 29, poll: 1 },
            countsByClient: { 'desktop/0.1.88': 29, 'desktop/0.1.89': 1 }, projectCount: 4, projectCountCapped: false });
        observer.observe(request, 1_600);
        expect(sample?.count).toBe(30);
        for (let i = 0; i < 29; i++) observer.observe({ ...request, client: 'desktop/0.1.89' }, 62_000);
        const next = observer.observe({ ...request, client: 'desktop/0.1.89' }, 62_000);
        expect(next).toMatchObject({ countsByClient: { 'desktop/0.1.89': 30 }, countsByRoute: { [request.route]: 30 }, projectCount: 1 });
        expect(next?.countsByRoute).not.toHaveProperty('/v1/projects/:projectId/automation-runs');
        expect(sample?.countsBySource).toEqual({ socket: 29, poll: 1 });
    });

    it('bounds diagnostic cardinality and excludes arbitrary client text', () => {
        const observer = new AutomationReadDiagnostics();
        for (let i = 0; i < 30; i++) observer.observe(request, 1_000);
        // Accumulate a new window while the previous sample is still in cooldown.
        for (let i = 0; i < 300; i++) expect(observer.observe({ ...request, projectId: `q-${i}`, client: `desktop/0.2.${i}` }, 60_000)).toBeNull();
        const capped = observer.observe({ ...request, projectId: 'overflow', client: 'Bearer private' }, 61_000);
        expect(capped).toMatchObject({ projectCount: 256, projectCountCapped: true });
        expect(Object.keys(capped!.countsByClient).length).toBeLessThanOrEqual(17);
        expect(JSON.stringify(capped)).not.toContain('private');
    });
    it('accepts only bounded source and route values', () => {
        expect(automationReadSource('socket')).toBe('socket');
        expect(automationReadSource('Bearer secret')).toBe('unspecified');
        expect(automationReadSource(['manual'])).toBe('unspecified');
        expect(isAutomationReadRoute(request.route, 'GET')).toBe(true);
        expect(isAutomationReadRoute('/v1/projects/real-id/automations', 'GET')).toBe(false);
        expect(isAutomationReadRoute(request.route, 'POST')).toBe(false);
    });
    it('samples a burst by authenticated account across projects and applies a one-minute cooldown', () => {
        const observer = new AutomationReadDiagnostics();
        for (let i = 0; i < 29; i++) expect(observer.observe({ ...request, projectId: `p-${i}` }, 1_000)).toBeNull();
        expect(observer.observe(request, 1_000)).toEqual({ accountId: 'account', projectId: 'project', route: request.route, source: 'socket', status: 200, count: 30, windowMs: 10_000,
            windowElapsedMs: 0, countsByRoute: { [request.route]: 30 }, countsBySource: { socket: 30 }, countsByClient: { unknown: 30 }, projectCount: 30, projectCountCapped: false });
        for (let i = 0; i < 100; i++) expect(observer.observe(request, 2_000)).toBeNull();
        for (let i = 0; i < 29; i++) expect(observer.observe(request, 62_000)).toBeNull();
        expect(observer.observe(request, 62_000)?.count).toBe(30);
    });
    it('keeps accounts separate and ignores unauthenticated requests', () => {
        const observer = new AutomationReadDiagnostics();
        for (let i = 0; i < 30; i++) expect(observer.observe({ ...request, accountId: undefined }, 1_000)).toBeNull();
        for (let i = 0; i < 29; i++) expect(observer.observe(request, 1_000)).toBeNull();
        expect(observer.observe({ ...request, accountId: 'another-account' }, 1_000)).toBeNull();
        expect(observer.observe(request, 1_000)?.accountId).toBe('account');
    });
    it('bounds tracked accounts and admits new accounts after stale entries expire', () => {
        const observer = new AutomationReadDiagnostics();
        for (let i = 0; i < 1_024; i++) observer.observe({ ...request, accountId: `account-${i}` }, 1_000);
        for (let i = 0; i < 30; i++) expect(observer.observe(request, 1_000)).toBeNull();
        // Existing accounts still produce samples while new accounts are not tracked.
        for (let i = 0; i < 28; i++) observer.observe({ ...request, accountId: 'account-0' }, 1_000);
        expect(observer.observe({ ...request, accountId: 'account-0' }, 1_000)?.count).toBe(30);
        for (let i = 0; i < 29; i++) expect(observer.observe(request, 61_000)).toBeNull();
        expect(observer.observe(request, 61_000)?.accountId).toBe('account');
    });
    it('reclaims expired low-rate windows without losing active log cooldowns', () => {
        const observer = new AutomationReadDiagnostics();
        for (let i = 0; i < 1_024; i++) {
            for (let j = 0; j < 30; j++) observer.observe({ ...request, accountId: `account-${i}` }, 1_000);
        }
        for (let i = 0; i < 1_024; i++) observer.observe({ ...request, accountId: `account-${i}` }, 31_000);
        // A 10-second window has expired, but a prior sample still needs its cooldown.
        for (let i = 0; i < 30; i++) expect(observer.observe(request, 46_000)).toBeNull();
        // Keep polling so no entry has been completely idle for a minute.
        for (let i = 0; i < 1_024; i++) observer.observe({ ...request, accountId: `account-${i}` }, 61_000);
        for (let i = 0; i < 29; i++) expect(observer.observe(request, 76_000)).toBeNull();
        expect(observer.observe(request, 76_000)?.accountId).toBe('account');
    });
    it('never includes request credentials or arbitrary fields in the sample', () => {
        const observer = new AutomationReadDiagnostics();
        const unsafe = { ...request, source: 'Bearer secret', client: 'Bearer secret', authorization: 'secret', body: 'private' };
        let sample;
        for (let i = 0; i < 30; i++) sample = observer.observe(unsafe, 1_000);
        expect(sample?.source).toBe('unspecified');
        expect(sample?.countsByClient).toEqual({ unknown: 30 });
        expect(JSON.stringify(sample)).not.toContain('secret');
        expect(sample).not.toHaveProperty('body');
    });
});
