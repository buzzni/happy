# proxy-circuit-404-retry

aplus web-ui proxy 가 합성한 세션 메시지 404 만 일시적 오류로 분류해,
살아 있는 Happy 세션이 종료되지 않게 한다.

## 요구사항

1. HTTP 404 이고 `x-aplus-circuit-breaker` 헤더 값이 정확히
   `session-messages-404`인 Axios 오류만 proxy circuit 오류다.
2. 위 오류는 non-retryable 또는 session-gone 으로 분류하지 않는다.
3. 다른 상태 코드나 다른 circuit 헤더 값은 기존 4xx 분류를 유지한다.
4. 실제 Axios 응답 헤더 형태에서도 동일하게 동작한다.
