# Plan

1. [Done] restoreSession 시한 — `createIsolatedRedisAdapter.ts` → 검증: 멈춘 restore 가 3초에 reject, 빠른 결과는 그대로
2. [Done] Redis 명령 시한 + 멈춤 감지 후 재연결 — `createRedisClient.ts` → 검증: 응답을 멈추는 가짜 RESP 서버로 명령 실패·연결 교체·정상 연결 유지
3. [ ] prod 배포 후 확인 — `restoreSession exceeded` / `redis connection stopped answering` 로그와 재연결 폭풍 부재
