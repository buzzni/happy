import { db } from "@/storage/db";
import { Fastify } from "../types";
import { httpRequestsCounter, httpRequestDurationHistogram, getMetricsLabelsFromRequest } from "@/app/monitoring/metrics2";
import { log, warn, error } from "@/utils/log";

// 이보다 오래 걸린 요청만 접근 로그를 남긴다.
const SLOW_REQUEST_MS = 1000;

/**
 * 느린 요청의 시간이 어디서 갔는지 한 줄로 보여준다.
 *
 * - handler: onRequest ~ 직렬화 직전 (인증·DB·응답 객체 구성)
 * - serialize: 직렬화에 걸린 시간
 * - send: 소켓에 쓰기 시작한 뒤 응답이 끝날 때까지 — ingress 가
 *   `proxy-buffering: off` 이면 여기에 **클라이언트 다운로드 시간**이 포함된다.
 *
 * 직렬화를 건너뛰는 응답(문자열·Buffer·스트림)은 preSerialization 이 돌지 않으므로
 * 그 시간은 handler 로 합산한다 — 없는 구간을 0 으로 꾸며 총합이 어긋나지 않게.
 */
function phaseBreakdown(
    request: { handlerDoneAt?: number; serializedAt?: number },
    end: number,
    start: number,
): string {
    const serializedAt = request.serializedAt ?? end;
    const handlerDoneAt = request.handlerDoneAt ?? serializedAt;
    const handlerMs = Math.max(0, handlerDoneAt - start);
    const serializeMs = Math.max(0, serializedAt - handlerDoneAt);
    const sendMs = Math.max(0, end - serializedAt);
    return `(handler ${handlerMs}ms / serialize ${serializeMs}ms / send ${sendMs}ms)`;
}

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

    // 느린 요청을 세 구간으로 나눈다. 총시간 하나로는 "핸들러가 느린 것"과
    // "응답을 다 내보내지 못한 것"을 구분할 수 없는데, 고쳐야 할 대상이 정반대다.
    // (2026-09-19 lookup 28초 조사: DB 1.25ms·직렬화 2.9ms 로 요청당 계산 비용이
    //  전부 기각됐는데 남은 후보를 기존 로그로는 가릴 수 없었다.)
    // 콜백 형태(동기)로 둔다. async 훅은 send 파이프라인에 마이크로태스크를 끼워
    // 넣어, 핸들러가 reply.send() 를 직접 부르는 라우트(/live, /ready, /health)에서
    // 헤더가 두 번 쓰이는 경합을 만든다(ERR_HTTP_HEADERS_SENT). 요청마다 프라미스를
    // 만들지 않는 이점도 있다 — 이 훅은 전 요청이 지나는 경로다.
    app.addHook('preSerialization', (request, _reply, payload, done) => {
        request.handlerDoneAt = Date.now();
        done(null, payload);
    });

    app.addHook('onSend', (request, _reply, payload, done) => {
        request.serializedAt = Date.now();
        done(null, payload);
    });

    app.addHook('onResponse', async (request, reply) => {
        const end = Date.now();
        const start = request.startTime ?? end;
        const duration = (end - start) / 1000;
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
        if (reply.statusCode >= 500 || durationMs > SLOW_REQUEST_MS) {
            const line = `${method} ${route} ${status} ${durationMs}ms ${phaseBreakdown(request, end, start)}`;
            if (reply.statusCode >= 500) {
                error({ module: 'access' }, line);
            } else {
                warn({ module: 'access' }, line);
            }
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
