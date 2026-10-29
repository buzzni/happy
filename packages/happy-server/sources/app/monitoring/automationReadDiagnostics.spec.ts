import { describe, expect, it } from 'vitest';
import { AutomationReadDiagnostics, automationReadSource, isAutomationReadRoute } from './automationReadDiagnostics';

const request = { accountId: 'account', projectId: 'project', route: '/v1/projects/:projectId/automations', source: 'socket', status: 200 };
describe('automation read diagnostics', () => {
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
        expect(observer.observe(request, 1_000)).toEqual({ accountId: 'account', projectId: 'project', route: request.route, source: 'socket', status: 200, count: 30, windowMs: 10_000 });
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
    it('never includes request credentials or arbitrary fields in the sample', () => {
        const observer = new AutomationReadDiagnostics();
        const unsafe = { ...request, source: 'Bearer secret', authorization: 'secret', body: 'private' };
        let sample;
        for (let i = 0; i < 30; i++) sample = observer.observe(unsafe, 1_000);
        expect(sample?.source).toBe('unspecified');
        expect(JSON.stringify(sample)).not.toContain('secret');
        expect(sample).not.toHaveProperty('body');
    });
});
