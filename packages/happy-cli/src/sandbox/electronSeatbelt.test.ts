import { describe, expect, it } from 'vitest';
import shellquote from 'shell-quote';
import { allowElectronInSeatbelt, ELECTRON_SEATBELT_RULES } from './electronSeatbelt';

const PROFILE = [
    '(version 1)',
    '(deny default (with message "CMD64_abc_END__tag_SBX"))',
    '',
    '(allow process-exec)',
    '(deny file-write* (regex "^/Users/x/\\.ssh") (with message "tag"))',
].join('\n');

function wrapped(profile: string, inner = 'cd /w && echo "$HOME" && electron .'): string {
    return shellquote.quote(['env', 'SANDBOX_RUNTIME=1', 'sandbox-exec', '-p', profile, '/bin/zsh', '-c', inner]);
}

describe('allowElectronInSeatbelt', () => {
    it('inserts the Electron rules right after (deny default) and keeps every other argument intact', () => {
        const input = wrapped(PROFILE);
        const output = allowElectronInSeatbelt(input);
        const tokens = shellquote.parse(output, (key) => `$${key}`) as string[];
        const profileIndex = tokens.indexOf('-p') + 1;
        const lines = tokens[profileIndex].split('\n');
        expect(lines[0]).toBe('(version 1)');
        expect(lines[1]).toBe('(deny default (with message "CMD64_abc_END__tag_SBX"))');
        expect(lines.slice(2, 2 + ELECTRON_SEATBELT_RULES.length)).toEqual(ELECTRON_SEATBELT_RULES);
        expect(lines.slice(2 + ELECTRON_SEATBELT_RULES.length).join('\n')).toBe(PROFILE.split('\n').slice(2).join('\n'));
        expect(tokens.slice(0, profileIndex)).toEqual(['env', 'SANDBOX_RUNTIME=1', 'sandbox-exec', '-p']);
        expect(tokens.slice(profileIndex + 1)).toEqual(['/bin/zsh', '-c', 'cd /w && echo "$HOME" && electron .']);
    });

    it('leaves every byte outside the profile untouched, including backticks and quotes in the inner command', () => {
        // shell-quote 의 parse→quote 왕복은 백틱마다 백슬래시를 하나 더 만든다. 프로필 인자만 바꿔야 한다.
        const inner = "node '/p/launcher.cjs' --append-system-prompt 'call `x` first' \"$HOME\"";
        const input = wrapped(PROFILE, inner);
        const output = allowElectronInSeatbelt(input);
        const tokens = shellquote.parse(output, (key) => `$${key}`) as string[];
        expect(tokens[tokens.length - 1]).toBe(shellquote.parse(input, (key) => `$${key}`).at(-1));
        const quotedProfile = shellquote.quote([PROFILE]);
        const at = input.indexOf(quotedProfile);
        expect(output.slice(0, at)).toBe(input.slice(0, at));
        expect(output.endsWith(input.slice(at + quotedProfile.length))).toBe(true);
    });

    it('returns the command unchanged when it is not a sandbox-exec wrapper', () => {
        expect(allowElectronInSeatbelt('electron .')).toBe('electron .');
        expect(allowElectronInSeatbelt('bwrap --ro-bind / / electron .')).toBe('bwrap --ro-bind / / electron .');
    });

    it('is idempotent', () => {
        const once = allowElectronInSeatbelt(wrapped(PROFILE));
        expect(allowElectronInSeatbelt(once)).toBe(once);
    });

    it('covers the operations Electron needs: rendezvous port, WindowServer, GPU helpers — and nothing process-wide', () => {
        const text = ELECTRON_SEATBELT_RULES.join('\n');
        expect(text).toContain('(allow mach-register (global-name-regex #"\\.MachPortRendezvousServer\\."))');
        expect(text).toContain('(allow mach-lookup (global-name-regex #"\\.MachPortRendezvousServer\\."))');
        expect(text).toContain('(global-name "com.apple.windowserver.active")');
        expect(text).toContain('(global-name "com.apple.CARenderServer")');
        expect(text).not.toContain('process-info');
    });
});
