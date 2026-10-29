const sources = new Set(['initial', 'socket', 'poll', 'manual']);
export function automationReadSource(value: unknown): string {
    return typeof value === 'string' && sources.has(value) ? value : 'unspecified';
}
export function isAutomationReadRoute(route: string, method: string): boolean {
    return method === 'GET' && /^\/v1\/projects\/:projectId\/(automation-target|automations|automation-runs|session-followups)$/.test(route);
}
type Request = { accountId?: string; projectId?: string; route: string; source: unknown; status: number };
type Window = { start: number; count: number; lastLog: number };

/** Observation only; not a cluster-wide rate limiter or an authorization gate. */
export class AutomationReadDiagnostics {
    private accounts = new Map<string, Window>();
    observe(request: Request, now: number) {
        const { accountId, projectId, route, status } = request;
        if (!accountId || !isAutomationReadRoute(route, 'GET')) return null;
        let window = this.accounts.get(accountId);
        if (!window) {
            if (this.accounts.size >= 1_024) {
                for (const [id, entry] of this.accounts) if (now - Math.max(entry.start, entry.lastLog) >= 60_000) this.accounts.delete(id);
                if (this.accounts.size >= 1_024) return null;
            }
            window = { start: now, count: 0, lastLog: -Infinity };
            this.accounts.set(accountId, window);
        }
        if (now - window.start >= 10_000) { window.start = now; window.count = 0; }
        window.count++;
        if (window.count < 30 || now - window.lastLog < 60_000) return null;
        window.lastLog = now;
        // Select fields explicitly; never copy headers, query strings or bodies.
        return { accountId, projectId, route, status, source: automationReadSource(request.source), count: window.count, windowMs: 10_000 };
    }
}
