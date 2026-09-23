# Context

- 2026-09-23: 1·2단계 구현 완료 (브랜치 `fix/redis-restore-session-timeout`).
  - 세 가지 뮤테이션(재연결 제거, commandTimeout 제거, restore 시한 제거)을 각각
    테스트가 잡는 것을 확인했다.
  - restore 시한은 `null` 이 아니라 reject 로 끝낸다. adapter 의 선언 타입이
    `Promise<Session>` 이고, adapter 자신도 "세션 없음" 을 reject 로 알린다.
  - happy-server typecheck exit 0, vitest 119 files / 1525 tests 통과.
- 남은 일: 배포 후 관측(plan 3). Redis 멈춤의 근본 원인(sentinel tilt 반복 등)은 별건이다.
- 2026-09-23 셀프 리뷰 반영:
  - ioredis 가 시한 초과로 실패시킨 명령을 재연결 후 다시 보내는 것을 재현했다
    (`event_handler.js` 가 prevCommandQueue 를 거르지 않고 resend). resend 를 껐다.
  - 멈춤 재연결을 `redis_client_errors_total{code="STALL"}` 로 센다.
  - 테스트의 명령 시한을 100ms 에서 250ms 로 올렸다. 부하가 걸린 CI 에서 정상
    연결을 멈춤으로 오판하는 flake 를 막기 위해서다. 5회 반복 실행해 안정을 확인했다.
  - 확인만 하고 고치지 않은 것: adapter 폴링 루프는 에러를 삼키고 계속 돌고
    offset 을 유지한다. terminal 백엔드는 실패를 `tolerate` 로 감싸 두었다.
  - vitest 119 files / 1526 tests 통과, typecheck exit 0. resend 뮤테이션을 테스트가 잡는 것을 확인했다.
- 2026-09-23 23:14 추가 관측: 재연결이 풀린 뒤에도 버스가 죽어 있었다(peers 0, lag 61분,
  `rpc_calls_total{method="bash",result="not_available"}` 가 한쪽 파드에서만 증가).
  23:20~23:22 에 prod 파드를 하나씩 삭제했고, peers 1 / lag 0~2ms 로 복구된 것을 확인했다.
  PR 의 commandTimeout 이 있으면 멈춘 XREAD 가 5초에 실패하고 폴링 루프가 다시 돈다.

