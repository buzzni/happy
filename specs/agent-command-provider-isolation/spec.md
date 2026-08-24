# Agent 명령 direct-entry provider 격리 Spec

> 작성일: 2026-08-24 / 상태: 승인됨
> 사용자가 provider 오염 사고의 재발 방지 구현과 PR 생성을 명시적으로 요청했다.

## 목표

`happy agent ...`가 설치형 wrapper뿐 아니라 개발·테스트가 사용하는 source/dist 직접 진입점에서도
항상 bundled `@buzzni/saycode-cli`로 라우팅되게 한다. 어떤 `agent` 인자 오류도 Claude/Codex 같은
provider 런타임 시작이나 기존 Happy session metadata 변경으로 이어지지 않아야 한다.

## 배경

- 설치형 `bin/happy.mjs`는 이미 첫 인자 `agent`를 bundled Saycode CLI로 위임한다.
- `packages/happy-cli/src/index.ts`에는 같은 분기가 없어 `tsx src/index.ts agent ...` 또는
  `node dist/index.mjs agent ...`가 기본 Claude 명령으로 fallthrough했다.
- 2026-08-24 개발 smoke의 `agent whoami --json`이 이 경로를 밟아 기존 Codex session id로 Claude
  프로세스를 재연결했고, session flavor가 Claude로 바뀌면서 Desktop이 `claude-sonnet-5`를 Codex에
  전송했다.
- `agent whoami`는 원래 JSON을 stdout에 출력하며 `--json`은 지원하지 않는다. 잘못된 옵션은
  Saycode CLI의 비영(非零) 종료로 끝나야지 provider 시작으로 해석되면 안 된다.

## 요구사항

- R1. Given source/dist 직접 진입점의 첫 인자가 `agent`일 때, When CLI가 실행되면, Then 기본
  Claude 파싱 전에 bundled `@buzzni/saycode-cli`의 `agent` 명령으로 위임한다.
- R2. Given `agent` 하위 명령이 성공하거나 인자 오류로 실패할 때, Then Happy 인증·daemon 보장·
  Claude/Codex/Gemini provider 시작 경로를 호출하지 않는다.
- R3. Given `agent` 뒤에 임의 인자가 있을 때, Then 순서와 값을 바꾸지 않고 Saycode CLI에 전달한다.
- R4. Given 현재 세션 식별용 environment가 있을 때, Then 동일 environment를 위임 프로세스에
  전달해 `whoami`와 제어 명령이 현재 세션을 식별할 수 있게 한다.
- R5. Given bundled Saycode 명령이 종료할 때, Then 그 exit status를 direct entrypoint의 status로
  반환하고 status가 없으면 실패(1)로 취급한다.
- R6. 기존 `doctor`, `auth`, provider 명령 및 설치형 wrapper의 동작은 변경하지 않는다.

## 비목표

- `--json` 옵션을 Saycode CLI에 새로 추가하는 것.
- provider별 모델 호환성 테이블이나 Desktop 모델 선택 로직을 변경하는 것.
- 사고로 이미 오염된 session metadata를 자동 탐지·소급 복구하는 것.
- 자연어 sub-agent routing, lifecycle, project link 등 별도 기능을 함께 변경하는 것.
- Happy CLI 버전 bump, npm release 또는 Desktop runtime pin 갱신.

## 제약

- 새 외부 의존성, 서버 API, 데이터 schema, capability 또는 권한을 추가하지 않는다.
- bundled dependency의 manifest `bin.saycode`를 기준으로 entrypoint를 해석한다.
- provider stdout을 오염시키지 않도록 별도 진단 로그를 추가하지 않는다.

## 완료 기준

- [x] direct-entry `agent` 위임과 exit status를 검증하는 단위 테스트가 통과한다.
- [x] 실제 build 산출물의 `node dist/index.mjs agent whoami`가 JSON과 exit 0을 반환한다.
- [x] unsupported `--json`이 provider를 시작하지 않고 Saycode CLI exit 2로 끝난다.
- [x] Happy CLI typecheck, build, 전체 unit suite가 통과한다(214파일/2,236테스트).
- [ ] 변경 범위가 이 spec과 구현·테스트 파일에 한정된 PR이 생성된다.
