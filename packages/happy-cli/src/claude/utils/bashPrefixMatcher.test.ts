import { describe, expect, it } from 'vitest';
import cases from './bashPrefixMatcher.cases.v1.json';
import {
    BASH_PREFIX_MATCHER_CAPABILITY,
    bashPrefixAllows,
    isPlainBashCommand,
} from './bashPrefixMatcher';

type GeneratedCase = { head: string; fill: string; count: number };
type CommandCase = { name: string; command?: string; generate?: GeneratedCase; plain: boolean };

function commandOf(item: { command?: string; generate?: GeneratedCase }): string {
    if (item.generate) return item.generate.head + item.generate.fill.repeat(item.generate.count);
    return item.command ?? '';
}

describe('isPlainBashCommand (spec desktop-permission-prefix-grant R3)', () => {
    it.each((cases.plainCommand.cases as CommandCase[]).map((item) => [item.name, item] as const))('%s', (_name, item) => {
        expect(isPlainBashCommand(commandOf(item))).toBe(item.plain);
    });

    it('refuses a non-string without throwing', () => {
        for (const value of [undefined, null, 12, ['git', 'add'], {}]) {
            expect(isPlainBashCommand(value as never)).toBe(false);
        }
    });

    it('answers a five megabyte command at once instead of scanning it', () => {
        const started = performance.now();
        expect(isPlainBashCommand('git add ' + 'a'.repeat(5 * 1024 * 1024))).toBe(false);
        expect(performance.now() - started).toBeLessThan(50);
    });
});

describe('bashPrefixAllows (spec desktop-permission-prefix-grant R7)', () => {
    it.each((cases.matcher.cases as { name: string; prefix: string; command: string; allow: boolean }[])
        .map((item) => [item.name, item] as const))('%s', (_name, item) => {
        expect(bashPrefixAllows(item.prefix, item.command)).toBe(item.allow);
    });

    it('refuses every compound or injected shape of every dangerous command under every offered prefix', () => {
        const { prefixes, shapes, dangerous } = cases.compoundInjection;
        let checked = 0;
        for (const prefix of prefixes) {
            for (const shape of shapes) {
                for (const danger of dangerous) {
                    const command = shape.split('{p}').join(prefix).split('{d}').join(danger);
                    expect(bashPrefixAllows(prefix, command), JSON.stringify(command)).toBe(false);
                    checked += 1;
                }
            }
        }
        expect(checked).toBe(prefixes.length * shapes.length * dangerous.length);
    });

    it('refuses a non-string prefix or command without throwing', () => {
        expect(bashPrefixAllows(undefined as never, 'git add .')).toBe(false);
        expect(bashPrefixAllows('git add', undefined as never)).toBe(false);
    });
});

describe('BASH_PREFIX_MATCHER_CAPABILITY', () => {
    it('names the matcher generation Desktop looks for (R7 iv)', () => {
        expect(BASH_PREFIX_MATCHER_CAPABILITY).toEqual({ bashPrefixMatcher: 'plain-v1' });
    });
});
