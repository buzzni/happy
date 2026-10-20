---
기능: setup-token-auth-consistency
상태: 진행중(최종 정책·로컬 CI·릴리스)
마지막 갱신: 2026-10-21
---

# 토큰 값 기준 사용자 binding

사용자가 토큰 자체 비교와 기존 권한 검사 유지, 관련 main PR 생성을 승인했다. Desktop/Studio의 같은 기능 문서와 계약을 공유한다. Core credential custody 안에서 기존 signer·RPC·journal을 사용하며 DB·의존성·키를 추가하지 않는다. 새 capability와 요청 marker가 선택적 proof를 협상한다. 원문/고정 hash 대신 nonce-bound HMAC을 서명하고, 실제 값이 맞는 현재 scope의 desired 관리 슬롯만 실행에 사용할 수 있다. 구 계약과 machine-principal v2 권한·회수 계약은 유지한다.

## 검증과 재개

실제 값이 다른데 ID·세대가 같은 경우, 같은 값인데 관리 ID/세트가 다른 경우, 준비→spawn 사이 교체, resume·세션 중 교체의 proof 보존/강등 거부를 관련 테스트로 검증한다. synthetic token·subprocess fixture 검증이며 실제 Anthropic 인증/추론 성공은 주장하지 않는다. 원본 node_modules를 링크하되 worktree happy-wire는 이 checkout의 소스로 빌드해 연결했다. 다음 단계는 관련 테스트/타입/CLI 빌드, 실제 Studio signer 교차 확인, main PR·CI/리뷰 확인이다. CLI 발행·Desktop pin·운영 배포·main 머지는 승인 범위 밖이다.

## 구현 결과

- 관련 `aiCredentialSetupToken` 112개, `setupTokenBindingProof` 26개, `setupTokenAccountSwitch` 24개, `sessionEnv` 89개: 총 251개 통과. 새 관리 ID/같은 토큰, 준비 이후 변조, disabled/회수, 재개·교체의 proof 보존/강등 거부를 포함한다.
- 실제 CLI 빌드(global setup의 typecheck·pkgroll 포함)와 개발 CLI `--version` 통과. Studio signer/이 verifier의 합성 credential 교차 검사 12개 통과.
- root 의존성 링크에서 오래된 happy-wire build를 읽던 문제는 이 worktree의 wire를 빌드해 링크해 해결했다. 공유 의존성/원본 소스는 변경하지 않았다.
- lint 명령/설정이 없는 저장소여서 독립 lint 통과를 주장하지 않는다. `git diff --check` 통과. 다음은 main 대상 PR의 실제 CI·리뷰·mergeability 확인이다.

- 메타데이터 pending 상태의 같은 현재 토큰은 허용하고, 실행 중 세션 때문에 로컬에 보존된 회수 토큰은 desired 후보에서 배제하는 경계도 통과했다. PR: https://github.com/buzzni/happy/pull/888 (main 대상, CI 확인 중).

## 최종 정책과 후속 범위(2026-10-21)

**현재 PC ID의 등록·사용 권한 + 실제 토큰 일치 + 실행 환경 준비**가 사용자가 확정한 최종 정책이다. [프로세스 정본](https://github.com/buzzni/aplus-dev-studio-desktop/blob/main/docs/processes/setup-token-execution.md). 다른 사용자·조직·개인/disabled/회수 슬롯은 계속 배제한다. 새 PC에는 새 ID의 현재 grant가 필요하며 이전 PC의 grant/resume은 사용할 수 없다. 같은 사용자/조직의 desired journal에 과거 적용 PC ID가 남은 것만으로 새 유효 grant를 거부하지 않는다.

사용자는 로컬 CI 통과 후 세 저장소 main PR 머지와 필요한 Happy CLI 발행·Desktop pin 반영을 승인했다. 위 과거 외부 작업 제외 기록은 이 후속에서 대체된다. registry/latest와 main은 .347이므로 후보 버전은 **1.1.10-aplus.348**이다. 로컬 publish 없이 Actions 단일 publisher로 발행하며 registry 설치 smoke 후 Desktop pin을 변경한다.

회귀는 같은 물리 PC 재등록의 새 ID/이전 journal 허용, 이전 머신 grant/resume 거부, 현재 머신의 재개·회수·토큰 불일치 보존을 포함한다. group assignment의 과거 PC 필터는 사용자 token-proof 경로에서만 분리하고 legacy 실행/collector custody는 유지한다. runtime은 recorded binding도 현재 machine/company와 명시 비교한다.

후속 검증: 현재 PC 재등록·proof/resume 경계 포함 5파일 292개 통과, 실제 Studio signer → 현재 Happy verifier 교차 검사 10개 assertion 통과(합성 토큰·키). .348 prepared artifact의 guard --install-smoke 통과(13 bundled files, 실제 설치·CLI/Fastify/daemon smoke). 개발 의존성은 원본 링크를 사용하고 wire는 현재 worktree 빌드, 누락된 잠금 ajv 8.17.1과 발행용 saycode-cli 0.9.7만 worktree 전용 링크로 보완했다. 원본 의존성·소스는 변경하지 않았다. 전체 unit CI 결과와 main 머지/릴리스 정보는 완료 시 기록한다.

전체 로컬 unit 첫 실행: 687파일/11670개 통과, 6파일/24개 실패, 64개 기존 platform/opt-in skip. 원인은 source checkout postinstall 도구 누락, Node 26 deprecation 출력, .codex 아래 worktree가 공유 agent-state 허용 경로에 포함되는 host sandbox fixture였다. 도구 unpack 후 /tmp의 동일 source CI worktree, Node 22에서 MCP·native 도구·실제 OS sandbox가 통과했고 원격 화면 fixture의 남은 환경 차이를 확인 중이다. 전체 성공으로 기록하지 않는다. Studio 운영 승격 #5300의 deploy-prod run 39455109607 성공(서버 계약 선행).
