# context — daemon-handoff-confirm-startup

## 현재 상태
Phase 1~5 완료. 브랜치 `fix/handoff-confirm-daemon-started`, base `origin/main@f84be7bd`.

## 변경 파일

| 파일 | 성격 | 내용 |
|---|---|---|
| `src/utils/spawnHappyCLI.ts` | 동작 | `startDetachedHappyCLI` 신설, `captureSpawnOutputStdio` 공용화 |
| `src/utils/spawnHappyCLI.test.ts` | 테스트 | 재현 + 계약 테스트 7건 추가 |
| `src/daemon/run.ts` | 동작 | handoff 가 종료 코드로 확인, 지역 헬퍼 제거 |
| `src/main.ts` | 동작 | `start-sync` 출력 캡처 |
| `src/daemon/ensureDaemonRunning.ts` | 동작 | `start-sync` 출력 캡처 |
| `src/daemon/ensureDaemonRunning.test.ts` | 테스트 | 부분 mock 에 새 export 추가 |

## 이번에 밟은 함정

`vi.mock('@/utils/spawnHappyCLI', () => ({...}))` 는 모듈 전체를 대체하므로,
소비자가 새로 쓰기 시작한 export 를 나열하지 않으면 **런타임에서 터진다.**
새 export 를 모듈에 추가할 때는 그 모듈을 부분 mock 하는 테스트를 반드시 함께
확인할 것. 이번에도 전체 스위트 대조를 안 했으면 놓쳤다.

## 검증 기준선 (이 환경)
`origin/main` detached 워크트리와 1:1 대조.
- tsc: 4 errors (기준선과 동일, 전부 `@slopus/happy-wire` 사전 존재)
- unit: 38 failed / 2216 passed — 실패 목록 완전 동일

## 남은 것 / 후속 판단거리
- `start-sync` 사망 원인 미규명. R4 가 다음 재발 때 `daemon-start-sync.log` 에
  증거를 남긴다. 그 로그가 쌓이면 5초 예산이나 번들 디바운스를 판단할 근거가 생긴다.
- 번들 재설치 빈도(개발 워크트리의 반복 `cli:install`)는 그대로다. 이 handoff
  경로를 계속 반복해서 밟게 만드는 근본 동인이다.
