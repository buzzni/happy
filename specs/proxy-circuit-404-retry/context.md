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

## 2026-08-01 — 리뷰 보강 2: headers 없는 오류에서 fail closed

`axios.isAxiosError` 는 `isAxiosError` 플래그만 확인하므로 손으로 만든
AxiosError 에는 `response.headers` 가 없을 수 있다. 이때
`Object.entries(undefined)` 가 throw 해 backoff 의 catch 안에서 원래 오류가
TypeError 로 바뀌어 삼켜졌다. headers 가 nullish 면 false 를 반환하도록
가드하고 (fail closed — 기존 4xx 분류 유지), 회귀 테스트를 추가했다.

검증: `vitest run --project unit src/utils/time.test.ts` 19 passed,
`pnpm run build` 통과.
