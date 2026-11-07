---
기능: cli-usage-limits-snapshot
상태: 진행중(T6 — PR)
마지막 갱신: 2026-11-07
---

# context

## 현재 상태
origin/main 5b53b48a4(H4 포함)에서 분기. T1~T4 완료.
검증: `pnpm typecheck` 통과. 깨끗한 env(`env -i`)로 unit 프로젝트 `src/claude` 전체 79개 파일 1450건 중 1449 통과 — 실패 1건(`claudeRemoteLauncherContextUsage` 녹화 재생)은 부하 78에서만, 단독 2회 통과·rate_limit 이벤트와 usage 메서드가 없는 녹화라 무관.

## 결정 로그
- 2026-11-07 창 `resetsAt`은 ISO 문자열 — 정본 R8 "unix초→ISO". upstream(epoch ms)과 다르다. 포크에 `usageLimits`를 읽는 코드가 없어(`git grep`) 호환 부담 없음. `capturedAt`은 다른 agentState 시각 필드처럼 epoch ms.
- 2026-11-07 같은 내용 재게시 없음 — 정본 R8 "변화 없으면 생략". upstream은 `capturedAt` 신선도 때문에 5분마다 재게시하지만 따르지 않는다. `capturedAt`은 "마지막으로 값이 바뀌어 게시된 시각"이다.
- 2026-11-07 seed는 SDK 실험 메서드 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })`(0.3.308에 있음, typeof로 확인). 곁질문 채널을 거치지 않는다(R8-d).
- 2026-11-07 변화 판정은 직전 패치가 아니라 이 query가 게시한 패치들의 병합 결과와 필드별 비교. 직전 패치 비교는 seed가 든 첫 패치 뒤 같은 창 재보고를 "변화"로 봐 다시 게시했다(claudeRemote 테스트로 발견). 키 순서가 이벤트·seed마다 달라 JSON 통째 비교도 틀린다.
- 2026-11-07 launcher는 가장 최근에 시작한 query의 패치만 게시한다(`usageLimitsQueries`). 계정 전환 뒤 이전 query의 seed가 늦게 끝나면 떠난 계정의 창이 새 계정 스냅샷을 덮었다. launcher 테스트는 가드를 빼면 실패함을 확인.
- 2026-11-07 모르는 `status`의 이벤트는 버리고(`{}`), 문자열이 아닌 `rateLimitType`은 unbound로 읽는다 — 새 CLI가 낸 값이 상태에 그대로 들어가지 않게.
- 2026-11-07 교차 리뷰(codex gpt-6.1-sol, high) 6건(major 3·minor 3) 모두 반영:
  - unbound 재적용 비멱등(사용률을 낮추는 unbound가 재시도 때 다른 창을 고름) → unbound 사용률은 합성 `plan` 창에만, 실제 창엔 상태·재설정 시각만.
  - launcher 지역 카운터는 local→remote 재진입 때 이전 launcher의 늦은 패치를 못 막음 → `session.client` 기준 모듈 WeakMap. 재진입 테스트는 지역 카운터 변이에서 실패 확인.
  - 창 없는 성공 seed가 `replace`를 안 실음 → 답을 받았으면 `replace`, 창·이벤트가 없어도 게시.
  - 사용률만 있는 이벤트가 seed의 재설정 시각을 버림 → 두 필드 따로 보충.
  - `resetsAt: 1e20`이 `toISOString` RangeError로 메시지 루프를 깸 → 표현 불가 날짜는 `null`.
  - "한도 미지원" 테스트가 availability 가드를 검증 못 함 → `false`+창 있는 입력 추가.
- 2026-11-07 `rate_limit_info.unifiedWindows`는 SDK 타입에 없고 포크 tracker만 방어적으로 읽는다 — 스냅샷은 수집하지 않음(spec 범위 밖).

## 열린 문제
- (범위 밖) `claudeRemoteLauncherContextUsage` 녹화 재생 테스트가 높은 부하(load 78)에서 한 번 실패, 단독 재실행은 통과. 이 변경과 무관.

## 다음 시작점
T6 — PR 생성·리뷰봇·CI.
