import { Fastify } from "../types";

// API 응답은 계정 데이터라 공유 캐시·브라우저 캐시에 남기지 않는다(CASA ZAP 10015, web-ui API 와 같은 정책).
// 미리보기 중계는 사용자 앱 응답을 그대로 전달하고, updates 계열은 소켓이라 건드리지 않는다.
const API_PATH = /^\/v[123]\//;
const PASSTHROUGH_PATH = /^\/v1\/(preview|updates|managed-updates)(\/|\?|$)/;

/**
 * API 응답의 기본 Cache-Control 을 no-store 로 둔다. 라우트가 직접 정한 값이 있으면 그 값이 이긴다.
 *
 * onSend·preSerialization 처럼 응답 직전에 도는 async 훅을 쓰지 않는다 — reply.send() 를 직접
 * 부르는 라우트에서 헤더 쓰기가 경합한다. 요청 시작 시점의 동기 훅으로 기본값만 걸어 둔다.
 */
export function enableNoStoreApiResponses(app: Fastify) {
    app.addHook('onRequest', (request, reply, done) => {
        const url = request.url;
        if (API_PATH.test(url) && !PASSTHROUGH_PATH.test(url)) {
            reply.header('Cache-Control', 'no-store');
        }
        done();
    });
}
