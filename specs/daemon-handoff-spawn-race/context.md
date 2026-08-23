# context — daemon-handoff-spawn-race

## 현재 상태
Phase 1~5 완료. 브랜치 `fix/daemon-handoff-spawn-race`, base `origin/main@8f0466d2`.

## 변경 파일

| 파일 | 성격 | 내용 |
|---|---|---|
| `src/utils/spawnHappyCLI.ts` | 동작 | `spawnDetachedHappyCLI` 신설 (R1, R2) |
| `src/utils/spawnHappyCLI.test.ts` | 테스트 | spawn 대기/unref/error/타임아웃/동기 throw 6건 |
| `src/daemon/handoff.ts` | 동작 | 재시도 + `'replacement-not-started'` (R4) |
| `src/daemon/handoff.test.ts` | 테스트 | 재시도/소진/throw 3건 + 기존 시그니처 갱신 |
| `src/daemon/run.ts` | 동작 | 호출부 연결, stdio 로그 파일, 실패 시 exit(1) (R3, R5) |
| `src/daemon/controlClient.ts` | 동작 | 로그 문구 정정 (R6) |

## 검증 기준선 (이 환경)
`origin/main` detached 워크트리와 1:1 대조.
- tsc: 1 error (기준선과 동일, `stripSaycodeOwnedPromptBlocks` 사전 존재)
- unit: 22 failed / 2148 passed — 실패 목록 완전 동일

주의: 이 환경의 `@slopus/happy-wire` 는 빌드 여부에 따라 tsc 오류 수가 크게
달라진다(미빌드 시 45건). 절대 수치로 판단하지 말고 항상 같은 시점의 기준선과
대조할 것.

## 남은 것 / 후속 판단거리
- teardown 순서 재설계(spawn 먼저 → 확인 → teardown)는 두 daemon 간 조정이
  필요해 이번 범위 밖. spec 비목표 참조.
- 번들 교체가 95분에 6회 일어난 원인(반복 재설치)은 미조사.
- D1 인과는 정황 증거다. 재발 시 `daemon-handoff-replacement.log` 가 이번엔
  증거를 남긴다.
