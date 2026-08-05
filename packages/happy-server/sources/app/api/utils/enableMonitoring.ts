import { db } from "@/storage/db";
import { Fastify } from "../types";
import { httpRequestsCounter, httpRequestDurationHistogram, getMetricsLabelsFromRequest } from "@/app/monitoring/metrics2";
import { log } from "@/utils/log";

function sendProcessStatus(reply: { send: (payload: unknown) => void }) {
    reply.send({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'happy-server'
    });
}

async function sendHealth(reply: { code: (statusCode: number) => { send: (payload: unknown) => void }; send: (payload: unknown) => void }) {
    try {
        // Keep the dependency check intentionally small. This is a single
        // connection liveness probe, not a DB health audit.
        await db.$queryRaw`SELECT 1`;
        sendProcessStatus(reply);
    } catch (error) {
        log({ module: 'health', level: 'error' }, `Health check failed: ${error}`);
        reply.code(503).send({
            status: 'error',
            timestamp: new Date().toISOString(),
            service: 'happy-server',
            error: 'Database connectivity failed'
        });
    }
}

export function enableMonitoring(app: Fastify) {
    // Add metrics hooks
    app.addHook('onRequest', async (request, reply) => {
        request.startTime = Date.now();
    });

    app.addHook('onResponse', async (request, reply) => {
        const duration = (Date.now() - (request.startTime || Date.now())) / 1000;
        const method = request.method;
        // Use routeOptions.url for the route template, fallback to parsed URL path
        const route = request.routeOptions?.url || request.url.split('?')[0] || 'unknown';
        const status = reply.statusCode.toString();
        const labels = getMetricsLabelsFromRequest(request);

        // Increment request counter
        httpRequestsCounter.inc({ method, route, status, ...labels });

        // Record request duration
        httpRequestDurationHistogram.observe({ method, route, status, ...labels }, duration);
    });

    app.get('/live', async (_request, reply) => {
        sendProcessStatus(reply);
    });

    // specs/readiness-probe-decoupling — readiness MUST NOT depend on the
    // database. It shares Prisma's pool with the app, so a stalled DB used to
    // fail this probe, drop the pod from the Service endpoints and turn a
    // partial degradation into a full outage (2026-08-05). Deep dependency
    // checks live on /health, which alerting consumes instead.
    app.get('/ready', async (_request, reply) => {
        sendProcessStatus(reply);
    });

    app.get('/health', async (_request, reply) => {
        await sendHealth(reply);
    });
}
