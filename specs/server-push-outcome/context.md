# happy-server push 결과 보고(PushOutcome) Context

> 마지막 갱신: 2026-11-07 / 상태: 진행중(PR #1154 머지 대기 — tasks 전부 완료)

## 현재 상태

정본 R3(Desktop `specs/happy-upstream-benchmark`)를 happy-server에 구현한다. 브랜치 `upstream-push-outcome`
(origin/main `3fbd89815` 기준), worktree `/Users/justin/workspace/happy-wt/upstream-push-outcome`.

## 결정 로그

- 2026-11-07: 핸들러는 dispatch를 기다려 응답한다. CLI가 fire-and-forget·15초 타임아웃으로 호출하므로 안전하고,
  Expo 전송에 8초 공용 마감을 둬 상한을 만든다(upstream과 같은 선택).
- 2026-11-07: 티켓이 오지 않은 토큰도 실패로 센다(`failed = tokens - sent`). 실패 사유는 서로 다른 원인만 한 번씩 담는다.
- 2026-11-07: 교차 리뷰(codex gpt-6.1-sol) 5건 반영 — 예외 사유는 클래스 이름만, dispatch 10초 예산, 티켓 누락 사유 로그, SILENT 억제 집계, Prisma 지연 실행으로 죽어 있던 토큰 삭제 복구. 세부는 spec.md 결정 절.
- 2026-11-07: `failed`·`partial` 로그는 `log({ level: 'error' })`가 아니라 `error()`(pino `logger.error`)로 낸다.
  `log()`는 `logger.info`라 merge 객체의 `level` 키는 JSON에 중복 키로만 붙고 실제 등급은 30(info)이다(직접 실행 확인).

## 열린 문제 (범위 밖)

- 저장소 전반에 `log({ module, level: 'error' }, …)` 관용구가 91곳 있고 모두 info 등급으로 기록된다.
  LOG_LEVEL=warn 이상이면 이 오류 로그가 사라진다. 별도 작업 후보.

## 검증 상태

- 관련 테스트: `pushDispatch.spec.ts`(10) · `pushSend.spec.ts`(3) · `pushRoutes.spec.ts`(10) 통과.
- happy-server 전체 `pnpm test`: 149 파일 / 1973 통과(519 skip은 DB 필요 통합 테스트). `pnpm typecheck` 통과.

- PR https://github.com/buzzni/happy/pull/1154 — smoke CI 5종 통과, 리뷰봇 30분 무응답, origin/main 병합(force-push 금지라 rebase 대신 merge).

## 다음 시작점

머지는 지휘 세션 몫. 후속: CLI·Desktop이 응답 `push`를 읽어 표시(범위 밖), 배포 뒤 `push_outcomes_total` 확인.
