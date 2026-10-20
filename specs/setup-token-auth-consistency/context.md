---
기능: setup-token-auth-consistency
상태: 진행중(검증)
마지막 갱신: 2026-10-20
---

# 토큰 값 기준 사용자 binding

사용자가 토큰 자체 비교와 기존 권한 검사 유지, 관련 main PR 생성을 승인했다. Desktop/Studio의 같은 기능 문서와 계약을 공유한다. Core credential custody 안에서 기존 signer·RPC·journal을 사용하며 DB·의존성·키를 추가하지 않는다. 새 capability와 요청 marker가 선택적 proof를 협상한다. 원문/고정 hash 대신 nonce-bound HMAC을 서명하고, 실제 값이 맞는 현재 scope의 desired 관리 슬롯만 실행에 사용할 수 있다. 구 계약과 machine-principal v2 권한·회수 계약은 유지한다.

## 검증과 재개

실제 값이 다른데 ID·세대가 같은 경우, 같은 값인데 관리 ID/세트가 다른 경우, 준비→spawn 사이 교체, resume·세션 중 교체의 proof 보존/강등 거부를 관련 테스트로 검증한다. synthetic token·subprocess fixture 검증이며 실제 Anthropic 인증/추론 성공은 주장하지 않는다. 원본 node_modules를 링크하되 worktree happy-wire는 이 checkout의 소스로 빌드해 연결했다. 다음 단계는 관련 테스트/타입/CLI 빌드, 실제 Studio signer 교차 확인, main PR·CI/리뷰 확인이다. CLI 발행·Desktop pin·운영 배포·main 머지는 승인 범위 밖이다.

## 구현 결과

- 관련 `aiCredentialSetupToken` 110개, `setupTokenBindingProof` 26개, `setupTokenAccountSwitch` 24개, `sessionEnv` 89개: 총 249개 통과. 새 관리 ID/같은 토큰, 준비 이후 변조, disabled/회수, 재개·교체의 proof 보존/강등 거부를 포함한다.
- 실제 CLI 빌드(global setup의 typecheck·pkgroll 포함)와 개발 CLI `--version` 통과. Studio signer/이 verifier의 합성 credential 교차 검사 12개 통과.
- root 의존성 링크에서 오래된 happy-wire build를 읽던 문제는 이 worktree의 wire를 빌드해 링크해 해결했다. 공유 의존성/원본 소스는 변경하지 않았다.
- lint 명령/설정이 없는 저장소여서 독립 lint 통과를 주장하지 않는다. `git diff --check` 통과. 다음은 main 대상 PR의 실제 CI·리뷰·mergeability 확인이다.
