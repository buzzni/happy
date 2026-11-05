# bash-prefix-matcher context

- 상태: 구현 완료, PR 리뷰 대기. 발행(태그)·Desktop pin 상승은 별도 사용자 승인이다 — 이 PR은 버전을 올리지 않는다.
- Phase 0 실측(2026-11-05, origin/main f519d8de1): 바뀌기 전 `startsWith` 매처에서 `Bash(git add:*)` 뒤 `git addx`·`git add . && rm -rf /`·`git  add .`·역슬래시 주입 사례가 모두 통과함을 `bashPrefixMatcher.test.ts`의 RED(스텁이 `startsWith`)로 확인했다. 강화 뒤 같은 사례가 모두 거절되고, `permissionHandler.test.ts`의 통합 사례도 같은 결과다.
- 함정: `packages/happy-cli/node_modules/@slopus/happy-wire`가 `../../../happy-wire`(상대 링크)라, 워크트리에서 메인의 node_modules를 통째로 링크하면 메인의 낡은 happy-wire dist를 읽어 tsc가 실패한다. 워크트리의 happy-wire를 따로 빌드하고 링크를 그쪽으로 돌린다.
- 남은 일: 발행 → Desktop pin → Desktop Phase 2.
