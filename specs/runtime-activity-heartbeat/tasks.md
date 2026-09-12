# tasks

- [x] T01. daemon state activity payload의 backward-compatible schema를 정한다.
- [x] T02. encrypted daemon heartbeat의 실패 회귀 테스트를 먼저 작성한다.
- [x] T03. runtime activity provider를 heartbeat producer에 주입한다.
- [x] T04. terminal registry count의 실패 테스트를 먼저 작성한다.
- [x] T05. daemon terminal session count를 제공한다.
- [x] T06. live tracked child와 terminal session count를 집계한다.
- [x] T07. automation runner와 active server lease count를 집계한다.
- [x] T08. activity count와 측정 시각을 encrypted daemon state에 보고한다.
- [x] T09. 관련 unit test를 통과시킨다.
- [x] T10. `packages/happy-cli` typecheck를 통과시킨다.
- [x] T11. `git diff --check`를 통과시킨다.
- [x] T12. Linux/Windows CLI smoke CI를 통과시킨다.
- [x] T13. 구현 PR과 version bump/tag/publish mutation을 분리한다.
- [x] T14. preflight 사이 새 activity가 시작되면 teardown 직전 재검증으로
  handoff를 유예하고 회귀 테스트로 고정한다.
