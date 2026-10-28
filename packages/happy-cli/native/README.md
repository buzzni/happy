# Browser host portability primitives

개발 중인 macOS/Windows 호스트의 OS 경계다. 설치기·서비스 등록·제품 지원을 제공하지
않으며 기존 Linux production 기동 검사를 변경하지 않는다. 생성된 `.node`는 Git에
넣지 않는다. 릴리스에는 별도의 플랫폼 빌드·서명·패키징·수락이 필요하다.

`browserHost.c`는 프로세스 안의 kernel lock, 정확한 생성 시각, kernel boot ID만
Node-API로 전달한다. 토큰·설정·프로필을 읽거나 실행 명령을 받지 않는다.
macOS는 flock/proc_pidinfo/sysctl, Windows는 LockFileEx/GetProcessTimes/
NtQuerySystemInformation을 사용한다. 조회 거부는 unknown 오류이며 PID만 같다는
이유로 세션을 재사용하거나 철회하지 않는다. Windows 코드는 실제 Windows 빌드와
실행을 통과하기 전 수락한 것으로 취급하지 않는다.

## 빌드와 검사

`packages/happy-cli`에서 대상 OS·아키텍처의 Node로 실행한다. 헤더·Windows import
library는 빌드 입력으로 준비하며 설치 중 내려받거나 컴파일하지 않는다.

macOS:

```sh
npm run build:browser-native-host -- /absolute/path/to/node/include/node
npm run test:browser-native-host
```

Windows Developer Command Prompt (대상 아키텍처 MSVC):

```text
npm run build:browser-native-host -- C:\node-headers\include\node native\win32-x64\browser-host.node C:\node-headers\x64\node.lib
npm run test:browser-native-host
```

ARM64는 해당 도구 체인·Node·node.lib를 쓰고 출력도 `native/win32-arm64`로 지정한다.
테스트는 실제 OS의 동시 잠금·소유 프로세스 종료·파일 링크·프로세스/부팅 식별을
검사한다. macOS Chrome 테스트는 임시 프로필과 상속 파이프만 사용하며
`SAYCODE_NATIVE_TEST_CHROME`으로 테스트용 Chrome 실행 파일을 지정할 수 있다.
Windows의 Chrome transport, pipe ACL, 서비스 수락은 이 테스트에 포함되지 않는다.

관련 일반 테스트는 `vitest run --project unit`에 파일을 명시한다. 전체 테스트나
제품 서버·실제 사용자의 로그인 프로필은 필요 없다. OS 조회·Chrome 시작이 거부되면
실측 실패로 남기며, mock·skip·보안 플래그 제거로 성공 판정을 만들지 않는다.

## 남은 production 경계

- 전용 서비스 신원, 보호 디렉터리와 IPC ACL, 원격 요청의 대상·권한 검증.
- 별도 OS 신원의 에이전트가 broker/admin secret·프로필·raw CDP에 접근하지 못하는 실측.
- CDP 단절 이후에도 유지되는 독립 네트워크 정책. 기존 Mac pf 실험만으로
  loopback·DNS·ICMP가 보호된다고 판단하지 않는다.
- 서비스 중복 실행·crash·재부팅·업그레이드·rollback, 공식 artifact·Extension adapter.

lock의 부모 디렉터리는 서비스가 소유해야 한다. 파일 자체의 no-follow·하드링크
검사는 부모 디렉터리/ACL 보호를 대체하지 않는다. `fromPipe`도 제공받은 descriptor의
출처나 브라우저 프로필 격리를 스스로 보증하지 않는다.
