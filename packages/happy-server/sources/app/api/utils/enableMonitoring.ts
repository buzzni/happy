import { db } from "@/storage/db";
import { Fastify } from "../types";
import { httpRequestsCounter, httpRequestDurationHistogram, getMetricsLabelsFromRequest } from "@/app/monitoring/metrics2";
import { log, warn, error } from "@/utils/log";

// 이보다 오래 걸린 요청만 접근 로그를 남긴다.
const SLOW_REQUEST_MS = 1000;

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

        // specs/happy-server-log-volume — Fastify 의 기본 요청 로그는
        // disableRequestLogging 으로 껐다. 정상 요청은 위 메트릭이 전량 집계하므로
        // 텍스트 로그로 중복할 이유가 없다. 조사할 가치가 있는 요청만 한 줄 남긴다.
        const durationMs = Math.round(duration * 1000);
        if (reply.statusCode >= 500) {
            error({ module: 'access' }, `${method} ${route} ${status} ${durationMs}ms`);
        } else if (durationMs > SLOW_REQUEST_MS) {
            warn({ module: 'access' }, `${method} ${route} ${status} ${durationMs}ms`);
        }
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
