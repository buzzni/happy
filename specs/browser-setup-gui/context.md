# 진행 상태

2026-08-13: Phase 1~5 구현 완료. 브랜치 `feat/browser-setup-gui`.

## 완료

- `browserSetup.ts` — 실행 인자/프로필 디렉터리/설치 판정 (순수 함수 + 테스트 16개)
- `runPairing` 추출 (구조적 변경, 별도 커밋) — 앱과 CLI가 같은 페어링 경로 사용
- `apiMachine.ts` RPC 4개: status / install-chrome / launch / pair
- `ops.ts` 클라이언트 헬퍼 + `machine/[id].tsx` "브라우저 브리지" 섹션

## 실기 검증에서 나온 수정

이 Mac에서 primitives 를 직접 실행해 보니 `detectChrome()` 이 null 을
반환했다 — macOS 는 Chrome 이 /Applications 에 있고 PATH 에 없다. 머신
화면은 Mac 머신에도 뜨므로, 그대로 뒀으면 **Mac 사용자에게 apt 명령을
안내**할 뻔했다. `planChromeInstall` 에 platform 을 넣어 Linux 가 아니면
apt 명령 대신 데스크톱 안내를 돌려주도록 고쳤다(테스트로 Red 확인 후 수정).

## 검증 결과

- 브라우저 관련 CLI 스위트 78개 통과
- happy-cli / happy-app 양쪽 `tsc --noEmit` 통과
- 변이 테스트로 `--enable-unsafe-extension-debugging` 과 `--headless=new`
  회귀 테스트가 실제로 잡아내는지 확인

## RPC 계층 E2E (2026-08-13, Ubuntu 22.04 amd64 컨테이너)

esbuild 로 harness 를 단일 번들로 묶어 컨테이너에 넣고, **실제로 등록된
핸들러**(`ApiMachineClient.rpcHandlerManager.handlers`)를 호출했다 — 핸들러를
재구현한 게 아니다. 실제 bridge + control server + Chrome 151 을 띄우고
비-root 사용자로 실행해 sudo 없는 실제 서버 조건을 재현했다.

7/7 통과: 핸들러 등록, Chrome 탐지, 설치 no-op, 기동(CDP 응답),
두 번째 프로필의 포트·디렉터리 분리(9222/9223), 페어링 성공
(debuggerTier=true), 상태에 프로필 반영.

### E2E 가 잡은 결함 — 샌드박스

첫 실행은 3/7 실패였다. Chrome 이 뜨긴 하는데 CDP 가 끝내 응답하지 않았다.
원인은 `Failed to move to new namespace` — 커널이 비특권 user namespace 를
막으면 Chrome zygote 가 시작 직후 죽는다. **컨테이너만의 문제가 아니다**:
Ubuntu 23.10+ 는 이 설정이 기본이라 실제 서버에서도 같은 증상이 난다.

`--no-sandbox` 를 무조건 붙이는 건 보안 강등이라(이 프로필이 사용자의
로그인 세션을 들고 있다) 기본은 샌드박스 유지, CDP 가 응답하지 않을 때만
1회 재시도하고 `sandbox: false` 로 강등 사실을 UI 까지 올린다.

## 남은 것

- **UI 렌더는 여전히 미검증** — 앱 화면은 컨테이너로 못 돌린다. RPC
  계층까지만 실기 확인했다.
- 로그인 GUI 패널은 범위 밖(spec.md 참고).
- 프로필 이름은 UI 에서 'default' 고정 — 입력란은 아직 없다.
