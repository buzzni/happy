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

## 남은 것

- **실기 E2E 미검증**: 실제 Linux 머신에서 버튼 4개를 눌러 본 적은 없다.
  순수 로직과 타입은 검증했지만, RPC 왕복과 UI 렌더는 미확인.
- 로그인 GUI 패널은 범위 밖(spec.md 참고).
- 프로필 이름은 UI 에서 'default' 고정 — 입력란은 아직 없다.
