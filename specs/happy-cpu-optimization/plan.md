# Happy CPU Optimization Plan

## Phase 1. Baseline and Guardrails

목표: CPU 최적화 전에 현재 부하 경로와 회귀 기준을 고정한다.

검증:
- `happy daemon start-sync` idle CPU 관찰 명령 기록
- receive polling, capability detection, terminal output batching 후보별 기존 테스트 확인
- 테스트가 부족한 경로는 최소 단위 테스트 추가 계획 수립

## Phase 2. happy-cli Low-Risk Optimizations

목표: 기능 영향 없이 반복 작업을 줄인다.

작업 후보:
- `detectCLIAvailability()` 결과를 TTL 기반으로 캐싱
- `detectResumeSupport()` 결과를 credentials 파일 mtime 기반으로 캐싱
- session receive polling을 adaptive interval로 변경
- terminal idle timer reset을 throttle
- machine bash RPC 호출 중 같은 목적의 status/spec/resource 명령을 caller side에서 cache/coalesce할 수 있는지 A+ 코드와 함께 분리 검토

검증:
- machine metadata 변경 감지가 유지되는지 테스트
- reconnect/catch-up 메시지가 누락되지 않는지 테스트
- terminal idle timeout 동작이 유지되는지 테스트
- SSH 머신에서 `happy-cli daemon start-sync` 아래 short-lived shell process 생성률 비교

## Phase 3. Remote Terminal Throughput

목표: 대량 terminal output에서 encrypt/emit 횟수를 줄인다.

작업 후보:
- PTY output chunk를 짧은 시간 또는 byte threshold 기준으로 batching
- close/exit 전에 pending buffer flush
- audit bytesOut 값은 원본 byte 기준으로 유지

검증:
- chunk 순서와 내용 보존 테스트
- close 시 pending output flush 테스트
- idle timer가 batch 후에도 적절히 갱신되는지 테스트

## Phase 4. happy-server Keep-Alive, Preview, and RPC Review

목표: 서버 CPU와 Redis/socket adapter 부하를 줄인다. Prod 실측상 preview보다 session-alive 처리량이 더 크므로 keep-alive 경로를 우선한다.

주의: 이 phase는 Kubernetes `happy-server` pod CPU용이다. 사용자 clarification 이후의 1차 목표인 SSH 머신 CPU에는 직접 효과가 작으므로 Phase 2/6보다 뒤에 둔다.

작업 후보:
- session-alive ephemeral activity broadcast를 session별 상태 변화 또는 최소 interval 기준으로 throttle
- session-alive validation/cache path가 cache hit일 때 불필요한 async work를 줄임
- user-scoped recipient가 없을 때 session-alive ephemeral emit skip
- preview subdomain mode에서 prefix rewrite no-op 경로 skip
- JS/CSS rewrite 필요 여부를 content-type과 prefix로 더 좁힘
- RPC presence polling을 긴 timeout 요청에만 적용하거나 backoff 적용

검증:
- session activity online/thinking 상태가 UI에 유지되는지 테스트
- DB lastActiveAt 30초 debounce가 유지되는지 테스트
- preview HTML injection 유지 테스트
- path-prefix preview rewrite 회귀 테스트
- RPC target disconnect detection 회귀 테스트

## Phase 5. Measurement and Rollout Notes

목표: 변경 전후 측정값과 운영 토글을 남긴다.

검증:
- idle daemon CPU 재측정
- terminal 대량 출력 시 frame count 비교
- preview 큰 JS/CSS 요청 처리 시간 비교
- rollout/env toggle 필요 여부 결정

## Phase 6. SSH Machine Status and A+ Caller Reduction

목표: SSH 개발 머신의 system CPU와 process churn을 줄인다. Happy daemon 자체가 CPU를 태우는지보다, Happy의 generic bash RPC를 통해 호출되는 A+ 상태 확인 명령이 반복 생성되는지를 우선한다.

작업 후보:
- `/home/coder/.local/bin/saycode-status`의 `npm list -g --depth=0 --json` 호출을 package.json/version file 기반 조회 또는 TTL cache로 대체
- `packages/web-ui/src/lib/sync/runPreviewContainerRemote.ts` status polling이 여러 UI surface에서 동시에 같은 machine/project를 조회하지 않도록 공유 cache/in-flight 범위 재검토
- `packages/web-ui/server/specFileRemote.ts`의 spec list/read polling을 5초 고정 shell RPC 대신 content mtime/hash 기반 cache 또는 happy 전용 파일 API로 전환 검토
- `packages/web-ui/server/machineUnion.ts`의 machine resource fallback probe 빈도와 cache 조건 점검
- Happy bash RPC 자체는 arbitrary command 실행면이므로 semantics 변경보다 caller frequency reduction을 우선

검증:
- `top`/`uptime`/`vmstat`로 user/system/idle CPU 비교
- 10~30초 샘플에서 `saycode-status`, `npm list`, `docker ps`, `__APLUS_SERVICE_LISTEN` 생성 빈도 비교
- 기존 preview status와 planning/spec UI가 stale 표시 없이 동작하는지 focused 테스트
- agent session, terminal, PATH/nvm/brew bootstrap 동작 유지 확인

## Approval Gate

이 문서는 계획 단계 산출물이다. 코드 수정은 사용자 승인 후 진행한다.
