/**
 * Electron/Chromium GUI 앱이 sandbox-runtime 의 macOS seatbelt 안에서 뜨게 하는 추가 허용 규칙.
 *
 * sandbox-runtime 프로필은 `(deny default)` 에 mach-lookup 허용 목록만 열어 두고
 * mach-register 는 전혀 열지 않는다. 그래서 Electron 은 부팅 직후
 * `bootstrap_check_in <bundle>.MachPortRendezvousServer.<pid>` 에서 Permission denied (1100) 으로
 * 죽고, 그 다음엔 WindowServer·CARenderServer 등을 못 찾아 창을 못 연다. (`ps`·`pgrep` 이 막히는 것은 별개다 —
 * /bin/ps 는 setuid 라 seatbelt 안에서 exec 자체가 거부되고 pgrep 은 com.apple.sysmond 를 찾는다.)
 *
 * 프로필은 `sandbox-exec -p <profile>` 인자로 통째로 넘어가고 sandbox-runtime 은 규칙을 끼워
 * 넣을 진입점을 주지 않는다. 그래서 감싼 명령을 shell-quote 로 파싱해 프로필 인자를 찾고, 그 인자에
 * 해당하는 부분 문자열만 바꾼다(sandbox-runtime 이 같은 인용기로 인자별 인용하므로 원문에서 그대로 찾힌다).
 *
 * 규칙 목록은 2026-09-16 macOS 26.5 에서 seatbelt 거부 로그를 비워 가며 얻은 실측값이다.
 * 새 거부가 나오면 `/usr/bin/log show --predicate 'eventMessage CONTAINS "deny(1)"'` 로
 * 대상을 확인하고 여기에 추가한다. Chromium 자체 샌드박스는 seatbelt 안에서 중첩될 수 없으므로
 * 앱 쪽은 `--no-sandbox` 로 띄워야 한다 (환경변수 `SANDBOX_RUNTIME=1` 로 판별 가능).
 */
import shellquote from 'shell-quote';

export const ELECTRON_SEATBELT_RULES: readonly string[] = [
    '; Electron/Chromium GUI inside seatbelt (happy-cli)',
    '(allow mach-register (global-name-regex #"\\.MachPortRendezvousServer\\."))',
    '(allow mach-lookup (global-name-regex #"\\.MachPortRendezvousServer\\."))',
    '(allow mach-lookup',
    '  (global-name "com.apple.windowserver.active")',
    '  (global-name "com.apple.CARenderServer")',
    '  (global-name "com.apple.CoreServices.coreservicesd")',
    '  (global-name "com.apple.DiskArbitration.diskarbitrationd")',
    '  (global-name "com.apple.SystemConfiguration.configd")',
    '  (global-name "com.apple.SystemConfiguration.DNSConfiguration")',
    '  (global-name "com.apple.dock.server")',
    '  (global-name "com.apple.hiservices-xpcservice")',
    '  (global-name "com.apple.pasteboard.1")',
    '  (global-name "com.apple.tccd.system")',
    ')',
];

const DENY_DEFAULT_LINE = /^\(deny default\b/;

/**
 * `sandbox-exec -p <profile> ...` 형태의 감싼 명령이면 프로필의 `(deny default ...)` 줄 바로 뒤에
 * Electron 규칙을 끼워 넣는다. 그 형태가 아니거나 이미 들어 있으면 그대로 돌려준다.
 */
export function allowElectronInSeatbelt(wrappedCommand: string): string {
    if (!wrappedCommand.includes('sandbox-exec')) return wrappedCommand;
    // env 참조는 원문 그대로 보존한다 — sandbox-runtime 이 모든 인자를 리터럴로 인용했으므로
    // 다시 인용하면 같은 리터럴이 된다.
    const tokens = shellquote.parse(wrappedCommand, (key) => `$${key}`);
    if (!tokens.every((token): token is string => typeof token === 'string')) return wrappedCommand;
    const sandboxExecIndex = tokens.indexOf('sandbox-exec');
    const profileIndex = tokens.indexOf('-p', sandboxExecIndex) + 1;
    if (sandboxExecIndex < 0 || profileIndex <= 0 || profileIndex >= tokens.length) return wrappedCommand;

    const lines = tokens[profileIndex].split('\n');
    if (lines.includes(ELECTRON_SEATBELT_RULES[0])) return wrappedCommand;
    const denyDefaultIndex = lines.findIndex((line) => DENY_DEFAULT_LINE.test(line));
    if (denyDefaultIndex < 0) return wrappedCommand;

    // 전체 토큰을 다시 인용하지 않는다 — shell-quote 의 parse→quote 왕복은 백틱마다 백슬래시를
    // 하나 더 만들어 inner 명령이 바뀐다. 프로필 인자에 해당하는 부분 문자열만 바꾼다.
    const quotedProfile = shellquote.quote([tokens[profileIndex]]);
    const at = wrappedCommand.indexOf(quotedProfile);
    if (at < 0) return wrappedCommand;
    lines.splice(denyDefaultIndex + 1, 0, ...ELECTRON_SEATBELT_RULES);
    return wrappedCommand.slice(0, at)
        + shellquote.quote([lines.join('\n')])
        + wrappedCommand.slice(at + quotedProfile.length);
}
