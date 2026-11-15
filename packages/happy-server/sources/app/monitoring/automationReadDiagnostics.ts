const sources = new Set(['initial', 'socket', 'poll', 'manual']);
export function automationReadSource(value: unknown): string {
    return typeof value === 'string' && sources.has(value) ? value : 'unspecified';
}
export function isAutomationReadRoute(route: string, method: string): boolean {
    return method === 'GET' && /^\/v1\/projects\/:projectId\/(automation-target|automations|automation-runs|session-followups)$/.test(route);
}
type Request = { accountId?: string; projectId?: string; route: string; source: unknown; status: number; client?: unknown };
interface Window {
    start: number; count: number; lastLog: number;
    routes: Map<string, number>; sources: Map<string, number>; clients: Map<string, number>;
    projects: Set<string>; projectCountCapped: boolean;
}

function increment(counts: Map<string, number>, key: string) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
}

function diagnosticClient(value: unknown): string {
    // Do not copy arbitrary header text into diagnostics. Only known client/version identities.
    return typeof value === 'string' && value.length <= 96
        && /^(desktop(?:-rpc|-metadata)?|saycode-web|ios|android|cli-(?:daemon|coding-session|control-plane))\/(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]{1,32})?|development)$/.test(value)
        ? value : 'unknown';
}

/** Observation only; not a cluster-wide rate limiter or an authorization gate. */
export class AutomationReadDiagnostics {
    private accounts = new Map<string, Window>();
    observe(request: Request, now: number) {
        const { accountId, projectId, route, status } = request;
        if (!accountId || !isAutomationReadRoute(route, 'GET')) return null;
        let window = this.accounts.get(accountId);
        if (!window) {
            if (this.accounts.size >= 1_024) {
                for (const [id, entry] of this.accounts) if (now - entry.start >= 10_000 && now - entry.lastLog >= 60_000) this.accounts.delete(id);
                if (this.accounts.size >= 1_024) return null;
            }
            window = { start: now, count: 0, lastLog: -Infinity, routes: new Map(), sources: new Map(), clients: new Map(), projects: new Set(), projectCountCapped: false };
            this.accounts.set(accountId, window);
        }
        if (now - window.start >= 10_000) {
            window.start = now; window.count = 0;
            window.routes.clear(); window.sources.clear(); window.clients.clear(); window.projects.clear(); window.projectCountCapped = false;
        }
        window.count++;
        increment(window.routes, route);
        increment(window.sources, automationReadSource(request.source));
        const client = diagnosticClient(request.client);
        increment(window.clients, window.clients.has(client) || window.clients.size < 16 ? client : 'other');
        if (projectId && !window.projects.has(projectId)) {
            if (window.projects.size < 256) window.projects.add(projectId);
            else window.projectCountCapped = true;
        }
        if (window.count < 30 || now - window.lastLog < 60_000) return null;
        window.lastLog = now;
        // Select fields explicitly; never copy headers, query strings or bodies.
        return {
            accountId, projectId, route, status, source: automationReadSource(request.source), count: window.count, windowMs: 10_000,
            // This is a partial, process-local window at sample time, not a completed cluster-wide total.
            windowElapsedMs: now - window.start,
            countsByRoute: Object.fromEntries(window.routes), countsBySource: Object.fromEntries(window.sources), countsByClient: Object.fromEntries(window.clients),
            projectCount: window.projects.size, projectCountCapped: window.projectCountCapped,
        };
    }
}
