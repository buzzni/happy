# Context

- 2026-09-23: 1·2단계 구현 완료 (브랜치 `fix/redis-restore-session-timeout`).
  - 세 가지 뮤테이션(재연결 제거, commandTimeout 제거, restore 시한 제거)을 각각
    테스트가 잡는 것을 확인했다.
  - restore 시한은 `null` 이 아니라 reject 로 끝낸다. adapter 의 선언 타입이
    `Promise<Session>` 이고, adapter 자신도 "세션 없음" 을 reject 로 알린다.
  - happy-server typecheck exit 0, vitest 119 files / 1525 tests 통과.
- 남은 일: 배포 후 관측(plan 3). Redis 멈춤의 근본 원인(sentinel tilt 반복 등)은 별건이다.
