import { Fastify } from "../types";
import { log, debug } from "@/utils/log";
import { auth } from "@/app/auth/auth";

export function enableAuthentication(app: Fastify) {
    app.decorate('authenticate', async function (request: any, reply: any) {
        try {
            const authHeader = request.headers.authorization;
            // specs/happy-server-log-volume — 성공 경로는 매 요청 실행되는 hot
            // path 다. info 로 남기면 요청당 6줄이 되고, pino-pretty 가 동기
            // in-process 스트림이라 그 비용이 이벤트 루프에 그대로 얹힌다.
            // 토큰은 어떤 레벨에서도 남기지 않는다.
            debug({ module: 'auth-decorator' }, `Auth check - path: ${request.url}, has header: ${!!authHeader}`);
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                log({ module: 'auth-decorator' }, `Auth failed - missing or invalid header`);
                return reply.code(401).send({ error: 'Missing authorization header' });
            }

            const token = authHeader.substring(7);
            const verified = await auth.verifyToken(token);
            if (!verified) {
                log({ module: 'auth-decorator' }, `Auth failed - invalid token`);
                return reply.code(401).send({ error: 'Invalid token' });
            }

            debug({ module: 'auth-decorator' }, `Auth success - user: ${verified.userId}`);
            request.userId = verified.userId;
        } catch (error) {
            return reply.code(401).send({ error: 'Authentication failed' });
        }
    });
}