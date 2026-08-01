# Plan — proxy-circuit-404-retry

- [x] Phase 1: proxy circuit 404 를 일반 재시도 대상으로 분류
      → 검증: `time.test.ts` 대상 테스트
- [x] Phase 2 (리뷰 보강): 상태 코드와 circuit 이름을 정확히 매칭
      → 검증: 401/410 및 다른 circuit 이름의 기존 분류 유지 테스트
- [x] Phase 3: 전체 CLI build/unit 검증 및 context 기록
