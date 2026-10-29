import { db } from "@/storage/db";
import { Fastify } from "../types";
import {
    automationReadRequestsCounter,
    httpRequestsCounter,
    httpRequestDurationHistogram,
    httpRequestPhaseDurationHistogram,
    eventLoopLagMaxMsSinceScrape,
    getMetricsLabelsFromRequest,
} from "@/app/monitoring/metrics2";
import { AutomationReadDiagnostics, automationReadSource, isAutomationReadRoute } from "@/app/monitoring/automationReadDiagnostics";
import { log, warn, error } from "@/utils/log";

// 이보다 오래 걸린 요청만 접근 로그를 남긴다.
const SLOW_REQUEST_MS = 1000;

/**
 * 요청 한 건의 시간을 네 구간으로 나눈다 (specs/platform-architecture-roadmap S4-1).
 *
 * - prehandler: onRequest ~ 전역 preHandler — 바디 수신·파싱·검증·전역 훅. 본문이 있는
 *   요청은 **클라이언트 업로드 시간**이 여기 들어가고(bodyLimit 100MB, 첨부 PUT),
 *   `onRequest: [app.authenticate, …]` 로 인증하는 라우트(managedControlRoutes)의 인증도
 *   여기다.
 * - handler: 전역 preHandler ~ 직렬화 직전 — `preHandler: app.authenticate` 인증 + 핸들러 +
 *   DB. `reply.raw` 에 직접 쓰는 라우트(preview 릴레이)는 preSerialization/onSend 가 돌지
 *   않아 전송 시간까지 여기 합산된다.
 * - serialize: 직렬화에 걸린 시간
 * - send: 소켓에 쓰기 시작한 뒤 응답이 끝날 때까지 — ingress 가 `proxy-buffering: off`
 *   이면 **클라이언트 다운로드 시간**이 포함된다.
 *
 * 대조군 /ready 가 가르는 것은 **프로세스 정지**다. /ready 는 인증·DB 가 없고 onRequest ~
 * preSerialization 사이에 매크로태스크 경계가 없어, 그 구간이 0 을 벗어나는 경우는 GC·CPU
 * 스로틀(cgroup)·시계 점프처럼 프로세스가 통째로 멈춘 때뿐이다. **이벤트 루프 굶주림은
 * 여기 잡히지 않는다** — 밀린 요청은 onRequest 가 찍히기 전에 대기를 다 소모한다(2026-10-21
 * 실험: 40ms 블록 부하에서 클라이언트 지연 0.5~1.5초, 서버 네 구간 합 70ms). 루프 굶주림은
 * `event_loop_lag_max_seconds`, 또는 ingress upstream 지연과 서버 총시간의 차이로 본다.
 *
 * 없는 구간은 0 으로 꾸미지 않고 다음 구간에 합산한다 — 직렬화를 건너뛰는 응답
 * (문자열·Buffer·스트림)은 preSerialization 이 돌지 않고, 라우팅·검증에서 끝난 요청은
 * preHandler 가 돌지 않는다(핸들러가 실행되지 않았으니 prehandler 가 전부다).
 */
type RequestPhases = { prehandler: number; handler: number; serialize: number; send: number };

function requestPhases(
    request: { preHandlerAt?: number; handlerDoneAt?: number; serializedAt?: number },
    end: number,
    start: number,
): RequestPhases {
    const serializedAt = request.serializedAt ?? end;
    const handlerDoneAt = request.handlerDoneAt ?? serializedAt;
    const preHandlerAt = request.preHandlerAt ?? handlerDoneAt;
    return {
        prehandler: Math.max(0, preHandlerAt - start),
        handler: Math.max(0, handlerDoneAt - preHandlerAt),
        serialize: Math.max(0, serializedAt - handlerDoneAt),
        send: Math.max(0, end - serializedAt),
    };
}

/**
 * 이 요청이 진행되는 동안 루프 지연 최대치가 갱신됐을 때만 그 값을 붙인다. 지연 히스토그램은
 * 스크레이프마다 리셋되므로 "since scrape" 값 자체는 수십 초 전 정지를 끌어올 수 있고,
 * 유휴 상태에서도 타이머 간격(resolution 20ms) 때문에 20ms 안팎이 찍힌다.
 */
function phaseBreakdown(phases: RequestPhases, loopLagMaxDuringRequestMs: number): string {
    return `(prehandler ${phases.prehandler}ms / handler ${phases.handler}ms / serialize ${phases.serialize}ms / send ${phases.send}ms; loop_lag_max_during_request ${loopLagMaxDuringRequestMs}ms)`;
}

function loopLagMaxDuringRequest(request: { loopLagMaxAtStartMs?: number }): number {
    const now = eventLoopLagMaxMsSinceScrape();
    const atStart = request.loopLagMaxAtStartMs ?? now;
    return now > atStart ? now : 0;
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
    const automationReads = new AutomationReadDiagnostics();
    // Add metrics hooks
    app.addHook('onRequest', async (request, reply) => {
        request.startTime = Date.now();
        request.loopLagMaxAtStartMs = eventLoopLagMaxMsSinceScrape();
    });

    // 요청을 네 구간(requestPhases)으로 나눈다. 총시간 하나로는 "핸들러가 느린 것"과
    // "응답을 다 내보내지 못한 것"을 구분할 수 없는데, 고쳐야 할 대상이 정반대다.
    // (2026-09-19 lookup 28초 조사: DB 1.25ms·직렬화 2.9ms 로 요청당 계산 비용이
    //  전부 기각됐는데 남은 후보를 기존 로그로는 가릴 수 없었다.)
    // 세 훅 모두 콜백 형태(동기)로 둔다. async 훅은 send 파이프라인에 마이크로태스크를
    // 끼워 넣어, 핸들러가 reply.send() 를 직접 부르는 라우트(/live, /ready, /health)에서
    // 헤더가 두 번 쓰이는 경합을 만든다(ERR_HTTP_HEADERS_SENT). 요청마다 프라미스를
    // 만들지 않는 이점도 있다 — 전 요청이 지나는 경로다.
    app.addHook('preHandler', (request, _reply, done) => {
        request.preHandlerAt = Date.now();
        done();
    });

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
        // 라우트 템플릿을 라벨로 쓴다. 404 는 템플릿이 없어 원시 경로가 들어가면 스캐너가
        // 보낸 경로마다 시리즈가 늘어나므로 하나의 라벨로 고정한다.
        const route = request.is404 ? 'not_found' : (request.routeOptions?.url || 'unknown');
        const status = reply.statusCode.toString();
        const labels = getMetricsLabelsFromRequest(request);

        // Increment request counter
        httpRequestsCounter.inc({ method, route, status, ...labels });
        if (isAutomationReadRoute(route, method)) {
            const source = automationReadSource(request.headers['x-happy-read-source']);
            automationReadRequestsCounter.inc({ route, status, source });
            const sample = automationReads.observe({ accountId: request.userId, projectId: (request.params as { projectId?: string })?.projectId, route, source, status: reply.statusCode }, end);
            if (sample) warn({ module: 'automation-read', ...sample }, 'Automation read burst (observation only)');
        }

        // Record request duration
        httpRequestDurationHistogram.observe({ method, route, status, ...labels }, duration);
        const phases = requestPhases(request, end, start);
        for (const phase of ['prehandler', 'handler', 'serialize', 'send'] as const) {
            httpRequestPhaseDurationHistogram.observe({ route, phase }, phases[phase] / 1000);
        }

        // specs/happy-server-log-volume — Fastify 의 기본 요청 로그는
        // disableRequestLogging 으로 껐다. 정상 요청은 위 메트릭이 전량 집계하므로
        // 텍스트 로그로 중복할 이유가 없다. 조사할 가치가 있는 요청만 한 줄 남긴다.
        const durationMs = Math.round(duration * 1000);
        if (reply.statusCode >= 500 || durationMs > SLOW_REQUEST_MS) {
            const line = `${method} ${route} ${status} ${durationMs}ms ${phaseBreakdown(phases, loopLagMaxDuringRequest(request))}`;
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
