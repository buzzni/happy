# context

## 상태: 구현 완료

### 변경 파일

- `packages/happy-cli/src/daemon/daemonStateOwnership.ts` (신규) — 소유권 판정 순수 함수
- `packages/happy-cli/src/daemon/daemonStateOwnership.test.ts` (신규)
- `packages/happy-cli/src/daemon/controlClient.test.ts` (신규)
- `packages/happy-cli/src/daemon/run.ts` — heartbeat 가 추출한 함수를 사용
- `packages/happy-cli/src/daemon/controlClient.ts` — crashed 마킹을 CAS 로
- `packages/happy-cli/src/persistence.ts` — `readDaemonStateSnapshot`, `writeDaemonStateIfUnchanged`
- `packages/happy-cli/src/persistence.test.ts` — CAS 실파일 테스트 3건

### 테스트

`vitest run --project unit`: 1979 pass / 3 fail.
실패 3건은 변경 전 `origin/main` 에서도 동일하게 실패하는 기존 결함이다.

- `scripts/__tests__/cli-version.test.ts`
- `src/claude/utils/sessionProtocolMapper.test.ts`
- `src/daemon/automations/serverAutomationCache.test.ts`

`tsc --noEmit` 오류 수도 변경 전후 모두 14건으로 동일 (전부 `@slopus/happy-wire`
빌드 산출물 관련 기존 오류, 변경 파일과 무관).

### 남은 관찰 (이번 범위 밖)

진단 중 `~/.happy/daemon.state.json` 을 읽었을 때 새 JSON 뒤에 이전 내용의 꼬리가
남은 형태를 한 번 관측했다. 소스상 유일한 writer 는 truncate 하는 `writeFileSync`
이므로 설명되지 않으며, 이후 10회 연속 읽기에서는 재현되지 않았다. 재현되면
temp+rename 원자적 쓰기로 바꾸는 별도 이슈로 다룬다.
