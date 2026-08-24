# context — dev-cli-install-isolation

## 현재 상태
Phase 1~5 완료. 브랜치 `fix/isolate-dev-cli-install`, base `origin/main@f84be7bd`.

## 변경 파일

| 파일 | 성격 | 내용 |
|---|---|---|
| `scripts/globalInstallGuard.cjs` | 신규 | 전역 설치 안전 판정 (순수 함수) |
| `scripts/__tests__/globalInstallGuard.test.ts` | 신규 | 판정 테스트 7건 |
| `scripts/install-isolated.cjs` | 신규 | 런북 §2 자동화 |
| `scripts/install-local.cjs` | 동작 | 가드 연결 |
| `package.json` | 동작 | `cli:install:isolated` 등록 |

## 실측 기록 (2026-08-25 07:49)

- 격리 설치 → 격리 daemon(pid 96496) 기동 성공
- 같은 시각 전역 daemon(pid 12725, 세션 13개) **그대로 생존** — 교체 안 됨
- 전역 dist mtime 이 07:49:48 → 07:50:15 로 내가 아무것도 안 하는 사이 또 바뀜.
  다른 세션의 전역 재설치가 지금도 진행 중이라는 뜻이고, 이 PR 의 근거다.
- 정리: 격리 daemon 종료, 복사한 `access.key` 삭제, 격리 루트 제거

## 워크트리 셋업 함정 (중요)

`node_modules` 를 소스 저장소에서 심볼릭 링크하면 `@slopus/happy-wire` 가
**소스 저장소(구 커밋)** 로 해석된다. `packages/happy-cli/node_modules/@slopus/
happy-wire -> ../../../happy-wire` 가 링크를 따라 소스 쪽으로 가기 때문이다.

그 상태에서는 tsc 오류 4건과 unit 실패 38건이 나오는데, **전부 셋업 artifact 다.**
워크트리에서 `pnpm install --filter "@buzzni/happy-cli..." --frozen-lockfile` 을
제대로 돌리면 (7초) tsc 0, unit 2293/2293 전부 통과한다.

이전 PR 들의 "기준선과 동일" 비교는 같은 셋업끼리 대조했으므로 결론은 유효하지만,
앞으로는 심볼릭 링크 대신 실제 설치를 쓸 것.

## 검증
- tsc: 0 errors
- unit: 2293 passed / 0 failed (기준선도 동일)

## 남은 것
- 런북(`docs/runbooks/happy-cli-dev-e2e-verification.md`, aplus-dev-studio 저장소)
  §2 를 새 스크립트로 갱신해야 한다. 저장소가 달라 별도 PR 이다.
- §2.3 의 node-pty `build/` 복사 지시는 낡았다. 같은 PR 에서 고칠 것.
