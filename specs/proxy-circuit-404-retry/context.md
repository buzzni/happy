# Context — proxy-circuit-404-retry

## 2026-08-01 — PR #115 리뷰

현재 `isProxyCircuitBreakerError` 는 `x-aplus-circuit-breaker` 헤더에 문자열이
있기만 하면 상태 코드와 값에 관계없이 true 를 반환한다. 이 함수가 전역
backoff 기본 분류기에 사용되므로, 401 같은 영구 오류나 향후 다른 circuit
응답까지 무한 재시도로 바뀔 수 있다.

승인된 후속 작업은 web-ui 의 실제 합성 응답 계약인
`404 + x-aplus-circuit-breaker: session-messages-404`만 예외로 좁히고,
나머지 4xx 분류가 유지되는 회귀 테스트를 추가하는 것이다.

## 완료

- `isProxyCircuitBreakerError`가 상태 코드 404와 정확한 circuit 이름을 모두
  확인하도록 변경했다.
- `AxiosHeaders`와 일반 헤더 객체를 모두 대소문자 무관하게 처리한다.
- 401/410, 다른 circuit 이름, 실제 `AxiosHeaders` 형태의 회귀 테스트를
  추가했다.

검증:

- `pnpm run build` — 통과
- `vitest run --project unit src/utils/time.test.ts` — 18 passed
- 전체 unit — 151 files / 1426 tests passed
