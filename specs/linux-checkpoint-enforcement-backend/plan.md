# 구현 계획 (v4)

> 근거 문서: [spec.md](./spec.md) v4

## 아키텍처 영향

| 항목 | 내용 |
|------|------|
| 관련 모듈/레이어 | `checkpoint/checkpointExclusionPolicy.ts`(게이트+프로브 주입), `checkpoint/checkpointSessionComposition.ts` 또는 `codex/codexAppServerClient.ts`(R4 순서), `sandbox/dependencyPreflight.ts`(재사용), Linux integration 테스트, CI |
| 새 외부 의존성 | 없음. daemon 호스트의 `bubblewrap`·`socat`·`ripgrep`은 OS 패키지 전제조건 |
| 모듈 경계/공개 API 변경 | **없음**(R6, 호환성 강제). ADR은 "Linux를 연다"는 결정 자체와 R4 순서 변경을 기록하는 용도로 happy `docs/adr/`에 1건 |
| 데이터 스키마 변경 | 없음 |

## 접근 방식

Linux integration 테스트를 먼저 쓰고(Red) 게이트를 테스트 로컬에서 우회해 실제 bwrap으로
실측한 뒤, 그 결과로 R4 방식과 잔여 위험을 확정한다. 이번 Codex 리뷰가 잡은 것(Codex
sandbox 인자 생성이 workspace 생성보다 앞선다, mount-point cleanup은 freeze 전에 이미 돈다,
R5-a는 보장 축소, MCP bash_stream은 호스트 실행)은 전부 "코드 순서"를 읽어야만 보이는
것이라, Phase 0은 운영과 같은 호출 순서를 보존한 테스트여야 의미가 있다.

기각한 대안:
- Happy 자체 Landlock 레이어 — 원본 보호가 apply 게이트로 성립, v1 과잉. 별도 스펙.
- `protection.status` qualifier / 새 reason 값 — Desktop 파서가 키 개수·닫힌 enum을
  검사하고 원격 daemon이 버전 미고정이라 daemon-first로는 불가. 별도 스펙(Desktop 선행).
- R5-a(Linux에서 workspace deny 생략) — ignored·용량 제한·passthrough의 write-time 차단까지
  잃는 ADR-059 보장 축소. 폐기.
- freeze 직전 `cleanupAfterCommand` 추가 호출 — 정상 경로에 이미 있음. 재현 근거 없이는 추가 안 함.

## 단계 (Phases)

- [x] **Phase 0: Linux 스파이크 (Red 먼저)** — 완료 2026-09-05, 결과는 context.md 표 — 산출물은 테스트 파일과 context.md 실측표만,
      임시 우회는 테스트 로컬(`platform: 'darwin'` 주입 등)에 한정하고 머지하지 않음.
      Ubuntu 컨테이너(`--platform linux/amd64`, `apt install bubblewrap socat ripgrep`)에서:
      1. (R4) 운영 순서(wrap → beforeTurn)로 일반 파일 쓰기 — **실패 재현 예상**. 성공하면
         왜 성공했는지(allowWrite에 상위 경로가 있었는지) 기록.
      2. (R3) 열거된 excluded 파일 write → EPERM.
      3. (R5) glob 전용 신규 secret → workspace에 있고 apply `conflict`, pending `turn-apply`.
         gitignore된 신규 secret → 원본 미반영 + pending 없음도 기록.
      4. (R7) 정상 completeTurn 후 changed paths에 mount-point 없음, fingerprint 성공.
      5. (R8) passthrough symlink 읽기 OK / 쓰기 실패.
      6. (R2) `bwrap` 제거 후 capability `unavailable`; userns 비활성(`sysctl
         kernel.unprivileged_userns_clone=0` 또는 24.04 apparmor 제한)에서 spawn 실패
         메시지가 원인을 말하는지.
      7. provider smoke: `checkpointProvider.integration.test.ts`를 Linux에서 실제 계정으로
         — **필수**(Linux 광고 조건). native Write 경로가 실제로 workspace에만 쓰는지 관찰.
      8. (R8 추가) passthrough symlink를 지우고 실제 dir로 바꾼 뒤 apply 결과, 그리고
         `extraWritePaths`에 원본 경로를 넣은 중첩 케이스에서 원본 ro 유지.
      → 검증: 7개 결과가 context.md 표에 있고 R4 방식(a/b)이 택일됨.
- [x] **Phase 1: R4 순서 수정** — `d63f5e89`, 방식 (a) `reserve()` → 택일한 방식 구현. macOS integration 테스트 무회귀 확인.
      → 검증: `checkpointSessionComposition.test.ts` 또는 `codexAppServerClient` 테스트 + macOS integration(로컬)
- [x] **Phase 2: 게이트 확장 + 프로브 (R1, R2)** — `136ed6f3` → `resolveCheckpointProtectionCapability`에
      `checkDependencies` 결과 주입, `linux` 분기, daemon 수명 캐시. 매트릭스 테스트
      darwin / linux-ok / linux-missing-dep / win32. → 검증: unit + `tsc --noEmit`
- [x] **Phase 3: Linux integration 테스트 정식 편입** — `38b53564`. CI는 happy-cli vitest 자체를 안 돌리므로 job 추가 대신 컨테이너 스크립트(`scripts/checkpoint-linux-sandbox-check/`)로 대체 → Phase 0 테스트를 우회 없이 통과,
      vitest `integration-empty`에 등록, CI ubuntu job에 apt 설치 추가. Ubuntu 24.04 러너의
      userns 제한이면 skip-with-reason. → 검증: CI 초록 또는 컨테이너 실행 기록
- [x] **Phase 4: ADR·문서** — ADR `docs/adr/2026-09-05-linux-checkpoint-protection.md`(Proposed, R8 필터 승인 반영). 후속 항목은 아래 목록 → happy `docs/adr/2026-09-XX-linux-checkpoint-protection.md`
      (Linux 개방 결정, R4 순서, 알려진 한계). context.md 완료 요약. Desktop ADR-059 갱신·
      MCP `bash_stream` 경계·Desktop 파서 관용화를 후속 이슈로. → 검증: 문서 리뷰

## 파일 배치 선언

수정 3~4개 / 신규 2개.

- 수정 `checkpoint/checkpointExclusionPolicy.ts` — 게이트 분기 + 프로브 주입
- 수정 `checkpoint/checkpointExclusionPolicy.test.ts` — 플랫폼 매트릭스
- 수정 R4: (a)면 `checkpoint/checkpointSessionComposition.ts` + `checkpoint/checkpointTurnWorkspace.ts`(prepare의 `mkdir(recursive:false)` 완화), (b)면 `codex/codexAppServerClient.ts` — Phase 0 결과로 택일
- 수정 `.github/workflows/*.yml` — ubuntu job apt 설치
- 신규 `checkpoint/checkpointSandbox.linux.integration.test.ts` — 기대값(ENOENT vs conflict)이
  달라 macOS 파일과 분리
- 신규 `docs/adr/2026-09-XX-linux-checkpoint-protection.md`

## 리스크와 대응

- **R4를 (a)(b) 어느 쪽으로 해도 macOS 회귀** → macOS integration 테스트를 Phase 1 게이트로.
- **provider smoke가 계정·환경 때문에 못 돌 때** → Linux `protected`를 광고하지 않는다
  (게이트를 열지 않고 Phase 0~1 산출물만 머지). 사용자에게 보고.
- **컨테이너에서 bwrap userns가 안 뜸** → `--privileged`/`seccomp=unconfined`로 돌리되
  대표성 한계를 기록. CI는 skip-with-reason.
- **잔여물이 실제로 남는 경로 발견** → 재현 케이스를 R7 테스트에 추가하고 그때 cleanup 호출 검토.

## 승인 대기 중인 추가 작업 (스코프 확장 제안)

- [x] (승인 2026-09-05, `f3c16a99`) **R8 필터 — Linux에서 workspace deny 목록 중 glob 항목과 passthrough symlink 항목만
      srt에 넘기지 않는다** — 필요해진 이유: Phase 0 실측에서 srt Linux의 symlink 교체 방어가
      passthrough symlink에 `/dev/null` bind를 시도해 **bwrap이 기동조차 못 한다**(readOnlyPassthroughPaths가
      있으면 Linux protected 턴 불가). glob 항목은 Linux에서 무효인데 `ws/**` 잔여물만 남긴다.
      두 항목 모두 제외해도 보장은 줄지 않는다(passthrough 대상은 `/` ro-bind로 read-only, glob은
      원래 미강제). 실측: R8b 테스트 통과(읽기 OK·쓰기 거부·symlink 교체 시 원본 불변·`**` 없음).
      **spec R3("deny 목록 불변")와 충돌하므로 사용자 승인 뒤 R3 문구를 함께 고친다.** 수정 지점은
      `checkpointSessionComposition.ts#sandboxConfigFor`(platform 인자 기반) + composition 단위 테스트.
- [ ] (후속, 별도 스펙) Happy MCP `bash_stream` 호스트 실행 경계 — 사용자 결정 (1)에 따라 이 스펙 밖.
- [ ] (후속) provider smoke를 실제 Linux 머신 + 계정으로 실행 — 컨테이너에 계정이 없어 미실행.
      **이것이 끝나기 전에는 Linux `protected`를 실사용에 광고하지 않는다**(DoD).
- [ ] (후속, Desktop 저장소) ADR-059 line 37/59 갱신.
