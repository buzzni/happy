/**
 * specs/db-pool-socket-timeout
 *
 * 앱이 쓰는 Prisma 풀에만 socket_timeout 을 주입한다. DATABASE_URL 자체를
 * 바꾸지 않는 이유는 컨테이너가 같은 URL 로 `prisma migrate deploy` 를 먼저
 * 실행하기 때문이다 — 큰 테이블의 마이그레이션이 타임아웃으로 끊기면 이후
 * 배포가 영구히 막힌다.
 */
export function buildAppDatabaseUrl(
    rawUrl: string | undefined,
    socketTimeoutSeconds: number
): string | undefined {
    if (!rawUrl) {
        return undefined;
    }
    if (!Number.isFinite(socketTimeoutSeconds) || socketTimeoutSeconds <= 0) {
        return rawUrl;
    }

    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        // 파싱 실패로 기동을 막지 않는다.
        return rawUrl;
    }

    // 운영자가 명시한 값이 우선한다.
    if (parsed.searchParams.has('socket_timeout')) {
        return rawUrl;
    }

    parsed.searchParams.set('socket_timeout', String(socketTimeoutSeconds));
    return parsed.toString();
}
