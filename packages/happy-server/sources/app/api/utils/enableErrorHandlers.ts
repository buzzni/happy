import { log } from "@/utils/log";
import { Fastify } from "../types";
import { FastifyError } from "fastify";
import { createErrorLogThrottle } from "@/utils/errorLogThrottle";

export interface EnableErrorHandlersOptions {
    skipNotFoundHandler?: boolean;
}

/**
 * 같은 종류의 5xx 가 쏟아질 때 창당 한 줄로 묶기 위한 키.
 *
 * 코드(또는 이름)만 쓴다 — 2026-08-06 처럼 pool 이 고갈되면 **모든**
 * 라우트가 동시에 P2024 를 내므로, 라우트를 키에 넣으면 라우트 수만큼
 * 곱해져 rate-limit 이 무력해진다. 대신 첫 발생 로그가 그 시점의
 * method/url 을 그대로 담고 있어 진단은 가능하다.
 */
function throttleKey(error: FastifyError): string {
    return error.code || error.name || 'unknown';
}

/**
 * 4xx 는 억제하지 않는다 — 원래 드물고 개별 진단 가치가 높다.
 * statusCode 를 모르면 5xx 로 본다 (미분류 예외).
 */
function isServerError(statusCode: number | undefined): boolean {
    return statusCode === undefined || statusCode >= 500;
}

function suppressedSuffix(suppressed: number): string {
    return suppressed > 0 ? ` [직전 창에서 동일 에러 ${suppressed}건 억제]` : '';
}

export function enableErrorHandlers(app: Fastify, options: EnableErrorHandlersOptions = {}) {
    // specs/error-log-flood-guard — 두 로깅 지점이 각자 창을 갖는다.
    // 한쪽만 막으면 절반만 줄어든다.
    const handlerThrottle = createErrorLogThrottle();
    const hookThrottle = createErrorLogThrottle();

    // Global error handler
    app.setErrorHandler(async (error: FastifyError, request, reply) => {
        const method = request.method;
        const url = request.url;
        const userAgent = request.headers['user-agent'] || 'unknown';
        const ip = request.ip || 'unknown';

        const admission = isServerError(error.statusCode)
            ? handlerThrottle.admit(throttleKey(error))
            : { allowed: true, suppressed: 0 };

        // Log the error with comprehensive context
        if (admission.allowed) {
            log({
                module: 'fastify-error',
                level: 'error',
                method,
                url,
                userAgent,
                ip,
                statusCode: error.statusCode || 500,
                errorCode: error.code,
                stack: error.stack
            }, `Unhandled error: ${error.message}${suppressedSuffix(admission.suppressed)}`);
        }

        // Return appropriate error response
        const statusCode = error.statusCode || 500;

        if (statusCode >= 500) {
            // Internal server errors - don't expose details
            return reply.code(statusCode).send({
                error: 'Internal Server Error',
                message: 'An unexpected error occurred',
                statusCode
            });
        } else {
            // Client errors - can expose more details
            return reply.code(statusCode).send({
                error: error.name || 'Error',
                message: error.message || 'An error occurred',
                statusCode
            });
        }
    });

    // Catch-all route for debugging 404s. Skipped when caller will register
    // its own (e.g. SPA fallback for self-hosted webapp).
    if (!options.skipNotFoundHandler) {
        app.setNotFoundHandler((request, reply) => {
            log({ module: '404-handler' }, `404 - Method: ${request.method}, Path: ${request.url}, Headers: ${JSON.stringify(request.headers)}`);
            reply.code(404).send({ error: 'Not found', path: request.url, method: request.method });
        });
    }

    // Error hook for additional logging
    app.addHook('onError', async (request, reply, error) => {
        const method = request.method;
        const url = request.url;
        const duration = (Date.now() - (request.startTime || Date.now())) / 1000;
        const statusCode = reply.statusCode || error.statusCode || 500;

        const admission = isServerError(statusCode)
            ? hookThrottle.admit(throttleKey(error))
            : { allowed: true, suppressed: 0 };
        if (!admission.allowed) return;

        log({
            module: 'fastify-hook-error',
            level: 'error',
            method,
            url,
            duration,
            statusCode,
            errorName: error.name,
            errorCode: error.code
        }, `Request error: ${error.message}${suppressedSuffix(admission.suppressed)}`);
    });

    // Handle uncaught exceptions in routes
    app.addHook('preHandler', async (request, reply) => {
        // Store original reply.send to catch errors in response serialization
        const originalSend = reply.send.bind(reply);
        reply.send = function (payload: any) {
            try {
                return originalSend(payload);
            } catch (error: any) {
                log({
                    module: 'fastify-serialization-error',
                    level: 'error',
                    method: request.method,
                    url: request.url,
                    stack: error.stack
                }, `Response serialization error: ${error.message}`);
                throw error;
            }
        };
    });
}