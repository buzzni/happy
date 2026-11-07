# happy-server push 결과 보고(PushOutcome) Context

> 마지막 갱신: 2026-11-07 / 상태: 진행중(T1 시작 전)

## 현재 상태

정본 R3(Desktop `specs/happy-upstream-benchmark`)를 happy-server에 구현한다. 브랜치 `upstream-push-outcome`
(origin/main `3fbd89815` 기준), worktree `/Users/justin/workspace/happy-wt/upstream-push-outcome`.

## 결정 로그

- 2026-11-07: 핸들러는 dispatch를 기다려 응답한다. CLI가 fire-and-forget·15초 타임아웃으로 호출하므로 안전하고,
  Expo 전송에 8초 공용 마감을 둬 상한을 만든다(upstream과 같은 선택).
- 2026-11-07: `failed`·`partial` 로그는 `log({ level: 'error' })`가 아니라 `error()`(pino `logger.error`)로 낸다.
  `log()`는 `logger.info`라 merge 객체의 `level` 키는 JSON에 중복 키로만 붙고 실제 등급은 30(info)이다(직접 실행 확인).

## 열린 문제 (범위 밖)

- 저장소 전반에 `log({ module, level: 'error' }, …)` 관용구가 91곳 있고 모두 info 등급으로 기록된다.
  LOG_LEVEL=warn 이상이면 이 오류 로그가 사라진다. 별도 작업 후보.

## 다음 시작점

tasks.md T1.
