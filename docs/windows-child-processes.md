# Windows에서 자식 프로세스를 띄우는 규칙

- 상태: 적용됨 (`packages/happy-cli/src/utils/windowsHiddenConsole.ts`)
- 갱신: 2026-11-24

Happy가 Windows에서 프로그램을 띄울 때 콘솔 창이 화면에 뜨지 않게 하는 규칙이다.
Happy CLI뿐 아니라 Windows에서 도는 모든 패키지와 스크립트에 적용한다.

## 배경 (2026-11-24)

Saycode에서 AI 대화를 하는 동안 `cmd.exe` 창이 잠깐씩 떴다. 원인은 다음과 같다.

- 데몬과 데몬이 띄운 대화 세션은 `spawnHappyCLI(…, { detached: true })`로 시작한다.
  Windows에서 `detached: true`는 `DETACHED_PROCESS`다. 그렇게 시작된 프로세스에는 **콘솔이 아예 없다**.
  같이 준 `windowsHide: true`는 적용되지 않는다.
- 콘솔이 없는 프로세스가 콘솔 프로그램(`cmd.exe`, `powershell.exe`, `node.exe`, `git.exe`, `python.exe`, `.cmd`·`.bat` 파일 등)을
  `windowsHide` 없이 띄우면, Windows는 그 프로그램에 **새 콘솔 창을 보이게** 만든다.
- Happy CLI에는 `windowsHide`가 빠진 `spawn`·`execFile`·`exec` 호출이 약 190곳 있었다. 그중 하나만 대화 중에 실행돼도 창이 뜬다.

## 지금의 안전장치

CLI 진입점(`src/index.ts`)은 가장 먼저 `src/utils/windowsHiddenConsoleInstall.ts`를 불러온다.
이 모듈은 Windows에서 그 프로세스의 `child_process` 함수(`spawn`, `spawnSync`, `execFile`, `execFileSync`, `exec`, `execSync`, `fork`)에
다음 기본값을 건다. 이름으로 가져온 ESM import에도 적용된다(`syncBuiltinESMExports`).

- **콘솔 프로그램**에는 `windowsHide: true`를 기본으로 넣는다. 숨긴 콘솔을 받은 자식은 그 콘솔을 자기 자식에게 물려준다.
  그래서 Happy가 직접 고칠 수 없는 손자 프로세스도 창을 띄우지 않는다(예: `codex.exe`가 MCP 서버를 `cmd.exe`로 띄우는 경우).
- **GUI 프로그램**(실행 파일의 PE subsystem이 GUI, 예: 브라우저·편집기)에는 넣지 않는다.
  `windowsHide`를 주면 GUI 프로그램의 첫 창까지 숨겨지기 때문이다.
- `windowsHide`를 직접 준 호출은 그 값을 그대로 쓴다.
- `shell: true`, `exec`, `.cmd`·`.bat` 파일, 경로를 찾지 못한 이름은 콘솔 프로그램으로 본다.

이 장치는 실수를 막는 마지막 방어선이다. 아래 규칙은 그대로 지킨다.

## 규칙

1. **Windows에서 띄우는 콘솔 프로그램에는 `windowsHide: true`를 직접 준다.** 기본값에 기대지 않는다.
   진입점을 거치지 않는 코드(다른 bin, 별도 스크립트, 다른 패키지)에는 안전장치가 없다.
2. **창을 보여야 하는 GUI 프로그램**(사용자가 볼 브라우저 등)은 `windowsHide`를 주지 않거나 `windowsHide: false`를 명시한다.
3. **`shell: true`는 `cmd.exe`를 띄운다.** 셸이 꼭 필요할 때만 쓰고, 쓸 때도 `windowsHide: true`를 준다.
   Windows에서 `.cmd` 파일(npm 전역 명령의 `codex.cmd`, `pnpm.cmd` 등)을 실행해도 `cmd.exe`가 뜬다.
4. **콘솔 프로그램을 `detached: true`로 띄우지 않는다**(Windows).
   - 그 프로그램에 콘솔이 없어서, 그 아래에서 `windowsHide`를 빠뜨린 실행이 모두 창을 띄운다.
   - Windows PowerShell 5.1은 `DETACHED_PROCESS`로 시작하면 스크립트를 한 줄도 실행하지 않고 종료 코드 0으로 끝난다
     (Saycode Desktop 빠른 업데이트 사고, 2026-11-23).
   - `detached`가 꼭 필요하면(부모보다 오래 살아야 할 때) 그 프로세스가 콘솔 프로그램을 띄우는 모든 곳에
     `windowsHide: true`가 있어야 한다. 대화 세션처럼 그 아래 코드가 많은 프로세스라면 진입점에 이 안전장치가 있어야 한다.
5. **부모가 끝난 뒤에도 살아야 하는 도우미**는 분리 실행 대신 PowerShell을 한 번 거쳐 띄운다.
   `powershell -NoProfile -Command "Start-Process … -WindowStyle Hidden"`로 띄우면 숨긴 콘솔을 받고,
   libuv의 kill-on-close job에서도 벗어나 부모가 끝나도 계속 돈다.
6. **네이티브 실행기**(C#·C 등)에서 콘솔 프로그램을 만들 때는 `CREATE_NO_WINDOW`(`0x08000000`)를 준다.
   `native/windowsSessionLauncher.cs`가 그렇게 한다. ConPTY로 붙이는 경우는 예외다.

## 확인 방법

- 자동 테스트: `packages/happy-cli/src/utils/windowsHiddenConsole.test.ts`.
  콘솔 없이(`detached`) 뜬 프로세스가 `windowsHide` 없이 `cmd.exe`를 띄운다. 안전장치가 없으면 창이 보이고, 있으면 보이지 않아야 한다.
  Windows에서만 돈다.
- 실제 앱: 대화하는 동안 새 콘솔 창을 기록하는 감시기를 돌린다.
  보이는 최상위 창 중 클래스가 `ConsoleWindowClass` 또는 `CASCADIA_HOSTING_WINDOW_CLASS`인 창을 0.1~0.2초마다 열거하고,
  창 주인 프로세스와 부모 체인(`Win32_Process`의 `ParentProcessId`·`CommandLine`)을 남긴다.
  창이 하나라도 기록되면 그 체인에서 `windowsHide`가 빠진 실행을 찾는다.
- 새 `spawn`·`execFile`·`exec`를 추가하거나 리뷰할 때는 위 규칙 1~4를 확인한다.
