# Browser host portability primitives

개발 중인 macOS/Windows 호스트의 OS 경계다. 설치기·서비스 등록·제품 지원을 제공하지
않으며 기존 Linux production 기동 검사를 변경하지 않는다. 생성된 `.node`는 Git에
넣지 않는다. 릴리스에는 별도의 플랫폼 빌드·서명·패키징·수락이 필요하다.

`browserHost.c`는 프로세스 안의 kernel lock, 정확한 생성 시각, kernel boot ID와
Mac의 열린 파일 descriptor에 대한 root 소유·쓰기권한·ACL 검사를 Node-API로 전달한다. 토큰·설정·프로필을 읽거나 실행 명령을 받지 않는다.
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
실제 `CdpDriver`로 로컬 임시 페이지 열기·내용 관측·탭 닫기까지 검사한다.
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

## 서비스 통합용 연결 경계

`CdpDriver.connectPipe`는 pipe와 해당 프로세스의 browser instance ID를 함께 받는다.
네트워크 endpoint와 동시에 설정할 수 없고 pipe 드라이버에 URL을 넣어 reconnect하면
거부한다. 동시 connect는 하나로 합치며 close 이후 늦게 도착한 연결은 폐기한다.

`openNativeBrowserSession`은 서비스가 제공한 descriptor·정확한 OS process owner·실제 effective UID와
독립 보호 서비스 응답을 확인한 뒤 드라이버를 연다. 시작 전후와 주기 검사에서 identity,
정책 epoch, 보호 서비스 generation, 차단 카운터를 비교한다. 조회 불명·timeout·재시작·
카운터 변화·PID 교체·pipe EOF는 CDP 연결을 즉시 닫고 소유 서비스에 종료를 요청한다.
종료 확인 실패는 `{ terminated: false }`로 남고 재연결하지 않는다. 종료 callback은
서비스가 소유한 원래 process handle/tree의 종료를 보증해야 하며 PID 재조회로 대체하지 않는다.

Mac 조회 adapter `createMacNativeBrowserProtection`은 고정 위치
`/Library/Application Support/SaycodeNative/bin/network-guard-status`만 실행한다.
각 상위 디렉터리와 실행 파일의 root 소유·쓰기권한·symlink·ACL을 확인하고, 빌드 계약의
Team ID와 helper signing identifier를 codesign으로 검증한 뒤 XPC 조회 helper를 호출한다.
설치 정책의 `serviceIdentifier`는 `com.saycode.nativeh.networkguard.status-check`여야 한다.
숫자 정밀도를 잃은 OS 카운터와 오류 응답은 거부한다. Mac 파일 검사에서는 열린 descriptor의
`fstatx_np`와 `filesec_query_property` 성공으로 ACL 부재를 확인하며, 조회 오류를 ACL 부재로
간주하지 않는다. ACL이 있는 경로는 허용하지 않는다.

위 adapter의 서명/상태 분기와 세션 중단은 단위 검사이며, 실제 설치된 Network Guard와
전용 서비스 계정에서의 수락은 아직 수행하지 않았다. 설치판 service entrypoint,
Windows WFP/IPC 보호, credential custody, 패키징은 계속 남은 production 경계다.

Mac effective UID는 `proc_pidinfo`에서 읽고 보호 대상 UID와 대조한다. 그 조회 전후에
동일한 boot/PID/creation lifetime인지 재확인한다. Windows에서는 process token의 TokenUser SID를
읽는다. 조회 실패는 unknown이며 Mac UID로 대체하지 않는다. Windows 실행 수락은 아직 남아 있다.


## Windows ACL·native broker 인증 (소스 후보)

Windows verifyServiceFile은 열린 handle의 owner/DACL/reparse/hardlink를 읽는다.
service SID, SYSTEM, Administrators만 쓰기를 허용하며 private 파일은 보호된 DACL과
외부 read 거부를 요구한다. 부모 디렉터리 보호·ACL 생성·서비스 신원 설정을 대체하지
않는다. 실제 Windows 테스트는 windowsServiceSecurity.native.test.ts이며 Mac skip은
Windows 빌드/수락 증거가 아니다.

Windows에서 Node가 연 파일의 descriptor는 `uv_get_osfhandle`로 변환한다. addon의
CRT `_get_osfhandle`을 직접 쓰면 CRT descriptor 테이블 차이로 프로세스가
fast-fail할 수 있다. Windows Build Tools 개발 프롬프트에서 addon을 빌드한 뒤
`node scripts/windows-browser-native.check.cjs native/win32-x64/browser-host.node`로
의존성 설치 없이 커널 boot/process SID, 잠금 경쟁·강제 종료 후 회수, 하드링크 및
synthetic credential ACL 거부를 확인한다. 이 검사는 임시 파일/자식 프로세스만
사용하며 서비스·WFP·별도 사용자·재부팅 수락을 대신하지 않는다.

Native broker 모드의 별도 인증은 src/browserRuntime/nativeBrokerAuthorization.ts에
있다. 신뢰된 issuer가 권한을 검사한 정확한 HTTP 작업을 abp-native-command로
서명해야 한다. 서비스 generation, machine/workspace, UUID requestId, method,
원문 path/query, body SHA-256, 최대 60초 수명이 필수다. generation은 시작마다
새로 생성하고 requestId는 dispatch 전에 소비한다. 응답 유실/실패는 자동 재실행
허가가 아니다. 발급자는 머신 관리 작업과 대화 등록·lineage에 각각 기존 권한
검사를 적용해야 하며 session-user attestation만으로 이 서명을 발급하면 안 된다.

production runtime은 Linux 경로와 명시적 macOS nativeService bootstrap을 구분한다.
macOS bootstrap은 보호 확인·전용 브라우저 시작 후 runtime UID로 불가역 전환하고
그 뒤에만 CDP/HTTP/SOCKS를 처리한다. issuer의 작업별 발급/daemon 전송,
OS별 서비스 설치·WFP 통합과 서명 installer는 아직 연결되지 않았다. 이 addon이나 broker 단위 테스트만으로 native 설치를
활성화하지 않는다. 실제 전용 identity/서비스/서명 패키지 수락 때 이 경계를 재검토한다.

## Windows 전용 서비스 custody 호스트

`windowsBrowserService.cs`는 .NET Framework ServiceBase로 SCM 전용 가상 계정
`NT SERVICE\SaycodeBrowserRuntime`에서 실행한다. 보호된 ProgramData 루트/상위
경로/실행 파일/상태 ACL을 검사한 뒤 서비스 전용 256비트 난수를 기존 runtime과 같은 64자리 hex agent.key로 최초 저장하고
재시작 시 재사용한다. root/system/관리자와 이 서비스 외의 private 접근을 거부한다.
상위 Windows 시스템 경로의 TrustedInstaller는 명시적으로 신뢰한다.

`*-status-v1` named pipe는 first-instance·원격 클라이언트 거부로 생성하며 local
Authenticated Users에는 version/principal/generation/runtimeReady만 제공한다.
응답 읽기 전 disconnect로 데이터가 사라지지 않도록 ACK 또는 연결 종료를 기다리고,
끊긴 클라이언트/timeout은 해당 요청만 정리한다. 임의 명령·토큰·키를 받거나 내보내지 않는다.
`runtimeReady`는 broker/worker/보호 계층이 연결되기 전까지 false다.

관리자 Windows에서 `scripts/windows-browser-service.check.ps1 -Source <windowsBrowserService.cs>`
는 경고 오류 빌드, 별도 Verification 서비스 설치·SID/IPC·재시작/강제 종료 후 custody·
파이프 선점/넓어진 ACL 거부를 검사하고 자신이 만든 서비스/디렉터리만 제거한다.
`-ClientProbeSeconds 50` 동안 비관리자 계정으로
`scripts/windows-browser-service-client.check.ps1`을 실행해 private 읽기 거부와
공개 상태·중도 연결 종료 회복을 확인한다. 기존 검증 디렉터리/서비스는 덮어쓰지 않는다.

이 호스트는 아직 Node broker/Chrome을 실행하지 않으며 key를 런타임에 연결하지 않는다.
전용 브라우저 프로세스/Job, WFP·부팅 보호, 설치 artifact 서명과 installer는 별도 미완료다.
제품용 원클릭 설치나 전체 isolation 수락을 이 검사로 표시하지 않는다.

## Windows WFP 정책 도구

`windowsBrowserFence.c`는 활성 관리자 토큰으로만 install/verify/remove를 허용한다.
전용 virtual service SID와 로컬 proxy port를 받고 고정 sublayer의 persistent block
6개를 트랜잭션으로 설치한다. IPv4는 정확한 127.0.0.1/TCP/proxy port만 차단에서
제외하고 IPv6 outbound 및 inbound accept는 차단한다. 기존 정책을 덮어쓰지 않고
SID/port·필터 목록/동작/조건/우선순위를 검증한 정책만 제거한다. 추가 필터도 거부한다.
BFE가 요청 우선순위 충돌 시 값을 올릴 수 있으므로 최소 요청값 이상만 허용한다.

Windows Developer Prompt 빌드:
```text
cl /nologo /std:c11 /W4 /WX /O2 native\windowsBrowserFence.c /Fe:windowsBrowserFence.exe /link Fwpuclnt.lib Advapi32.lib Rpcrt4.lib Uuid.lib
```
위 서비스 수락 스크립트에 `-Fence <absolute-exe> -NetworkProbeSource
<scripts/windows-browser-network-probe.cs>`를 추가하면 별도 SCM 테스트 workload로
정책 전/중/후의 실제 TCP와 UDP 수신을 비교한다. UDP Send 성공은 전달 증거가 아니므로
별도 수신 소켓에서 패킷 도착을 검사한다. 중복 설치와 다른 port 제거도 거부해야 한다.

범위: 서비스 SID가 직접 여는 소켓의 실제 Windows x64 수락이다. DNS Client 등
다른 신원의 시스템 서비스를 통한 간접 통신, raw ICMP/외부 NIC, BFE 재시작/OS reboot,
실제 Chrome·privilege 제한·worker Job·runtime monitor 통합은 아직 검증되지 않았다.
CLI `verified`는 필터 구조 조회이며 제품 전체 isolation/ready 증명이 아니다.


## macOS production bootstrap과 guardian

`macNativeRuntime.ts`는 고정 root 소유 설정, 보호된 runtime state(0700), IPC
디렉터리(0755), 프로세스 내부 kernel writer lock을 확인한다. root에서 실행하는
작은 `macBrowserGuardian.c`가 별도 브라우저 UID/GID/커널 그룹으로 Chrome을
실행한다. Chrome·guardian은 지정한 서명을 검사한다. Network Guard의 signed XPC
상태가 실제 정책 UID/epoch와 일치해야 시작하며, status 파일/구형 필터/일반 Chrome
경로로 대신 성공시키지 않는다. 원본 프로필이나 공개 CDP 포트를 사용하지 않는다.

`browser-guardian UID GID HOME RECOVERY_DIRECTORY EXECUTABLE [ARGS...]`는 root
전용이며 setuid binary가 아니다. production 복구 디렉터리는
`/Library/Application Support/SaycodeNative/guardian-state`(root:wheel 0700)이다.
root 소유 디렉터리·ACL·symlink 검사 후 `owner.lock`의 kernel flock을 잡고, `active`
기록을 exclusive create + file/directory fsync로 저장한 뒤 fork한다. 정상 종료와
원래 그룹의 drain, 새 UID 프로세스가 남지 않았음을 확인한 경우에만 기록을 지운다.
부모 runtime crash는 원래 그룹을 회수한다. guardian 자체 SIGKILL·그룹 이탈·관측
실패는 기록을 남기고 다음 시작을 거부한다. stale 기록을 자동 삭제하는 복구는 없다.
관리자가 종료와 보호 상태를 독립 확인하기 전에는 설치/재시작이 이를 지우면 안 된다.
원래 leader를 reap하지 않은 채 process group을 관측하므로 PID 재사용 대상으로
종료 신호를 보내지 않는다. 이 설계는 모든 OS 위임 프로세스의 kernel containment를
증명하지 않으며, 이를 확인하지 않은 전체 isolation 수락은 계속 미완료다.

소스 체크아웃에서:
```sh
npm run build:mac-browser-guardian
sudo node scripts/mac-browser-guardian.check.cjs native/darwin-arm64/browser-guardian UID GID /absolute/path/browser-host.node
npm run bundle:browser-native-runtime -- --out /absolute/new/output-directory
```
검사는 제공한 별도 테스트 UID/GID만 사용하며 루트 제어 EOF, exec 실패, 그룹 이탈,
runtime SIGKILL, custody·root 복귀 거부, guardian SIGKILL의 영속 차단, 중복 시작,
쓰기 가능한/symlink 복구 경로 거부를 실측한다. macOS arm64에서 8건 통과했다.
검증 스크립트가 만든 임시 기록 정리는 테스트 fixture에만 해당하며 제품 복구가 아니다.

`build-native-browser-runtime.mjs`는 현재 아키텍처의 두 Mach-O 입력을 검사하고
`dist/runtime.mjs`, `native/darwin-*/browser-host.node`, `bin/browser-guardian`과
각 파일의 size/SHA-256 manifest를 새 디렉터리에 쓴다. npm CLI 패키지와 독립된
OS 설치기 입력이다. 기존 output을 덮어쓰지 않으며 Windows 미완성 실행부를
패키징하지 않는다. Node·Chrome·Network Guard, OS installer/signing/launchd
provisioning 및 등록 후 인증된 설정 전송은 이 빌드에 포함되지 않는다. 따라서
이 묶음의 생성은 설치 지원/배포/실제 서비스 준비 완료의 증거가 아니다.

재검토: 실제 필터 교체, 별도 runtime 신원의 Chrome 기동, guardian 강제 종료 후
사람의 명시적 복구, OS 위임 통신, installer upgrade/rollback을 검증한 뒤 위 미완료
경계를 갱신한다. launchd KeepAlive로 종료 불명 상태를 반복 실행하지 않는다.

## 선택적 네트워크 보호

새 기본 설치는 보호된 runtime 설정의 `nativeService.networkProtection`을 `basic`으로
명시한다. 이 모드는 Guard를 조회하지 않지만 프로필/별도 신원/프로세스 수명/서명/작업
인증은 유지한다. 프록시의 origin 정책은 OS 네트워크 차단 보장이 아니다.
추가 보호 `guard`와 필드가 없는 과거 설정은 Guard 실패 시 실행을 거부한다.
모드는 세션 시작 시 고정되며 옵션 변경으로 살아 있는 보호 세션을 강등할 수 없다.
사용자 설정·설치기 연결은 별도이며 이 필드를 agent 요청으로 바꾸지 않는다.

## Mac 전용 계정 수명과 명시적 복구

root guardian의 상속 stdin/stdout에서 32-byte random nonce를 왕복하여 현재 원래
Chrome child의 UID·생성 시각을 확인한다. runtime 신원으로 권한을 낮춘 뒤 다른 UID의
proc_pidinfo를 직접 읽을 수 없는 경우에도 PID/UID 검사를 생략하지 않는다. 응답 초과,
불일치, EOF, timeout은 영구 실패이며 guardian 수명을 끝낸다.

제품 bootstrap은 `--dedicated-user-domain`을 사용한다. guardian은 200~499 UID,
`_saycodebrowser`로 시작하는 서비스 계정명, 지정 GID, `/usr/bin/false` shell,
고정 browser-profile home과 시작 전 UID 프로세스 부재를 확인한다. 설치기는 실제
Directory Services의 home도 이 경로로 등록해야 한다(HOME 환경변수만으로 부족).
원래 Chrome process group을 끝낸 뒤 고정 `/bin/launchctl bootout user/<uid>`로
전용 계정의 macOS 보조 서비스를 닫고 UID 전체의 잔류 부재를 재확인한다. 일반
primitive 호출에는 이 정리를 적용하지 않는다. 로그인 사용자 영역은 대상이 아니다.

확정할 수 없는 종료는 root 전용 active 기록을 유지한다. 자동 시작은 이를 지우지
않는다. 관리자가 중지 상태를 조사한 뒤 `browser-guardian --recover <uid> <gid>
<home> <recovery-directory>`를 호출하면 보호 디렉터리·배타 잠금·정확한 기록과 전용
계정을 검증하고 이전 guardian PID와 해당 UID 프로세스가 없을 때만 기록을 지운다.
PID 재사용·권한 불명·잔류 프로세스·변조 기록은 거부하며 프로세스를 임의로 죽이지 않는다.

전용 Chrome은 앱이 중지 중에 버전을 교체한다. Chrome 자체 업데이트용
MacAppCodeSignClone은 실행 파일의 hard link를 사용자 캐시에 만들어 강제 종료 후
단일-link 검사를 깨뜨리므로 해당 feature만 비활성화한다. sandbox, 서명, root 소유와
single-link 검사는 유지한다. Chrome 버전 또는 업데이트 소유권 변경 시 재검토한다.

실기 검사: `mac-browser-guardian.check.cjs`에 전용 계정 home을
`SAYCODE_GUARDIAN_DEDICATED_HOME`으로 전달하면 정상 종료/재시작과 관리자 복구를
검사한다. 별도로 `SAYCODE_NATIVE_SERVICE_ACCEPTANCE=1`은 사전 설치한
runtime-basic-verification 서비스의 실제 Chrome 연결·401·두 번의 종료/재시작·UID
잔류 부재를 검사한다. 테스트 전용 PC에서만 실행하며 설치나 launchd 등록은 하지 않는다.
이 검사는 실제 서명 task 발급·로그인 사이트 조작·Desktop 설치판 수락을 대체하지 않는다.
