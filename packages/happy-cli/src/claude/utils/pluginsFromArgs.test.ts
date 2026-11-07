import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pluginsFromArgs } from './pluginsFromArgs';

const cwd = resolve('fixture session');

describe('pluginsFromArgs', () => {
    it('reads both forms, in order, relative to the session path', () => {
        const absolute = resolve('absolute plugin');
        expect(pluginsFromArgs(['--plugin-dir', './my plugin', `--plugin-dir=${absolute}`, '--plugin-dir=../other=plugin'], cwd)).toEqual([
            { type: 'local', path: resolve(cwd, 'my plugin') },
            { type: 'local', path: absolute },
            { type: 'local', path: resolve(cwd, '../other=plugin') },
        ]);
    });

    it('stops at `--` and ignores other flags', () => {
        expect(pluginsFromArgs(['--model', 'opus', '--plugin-dir', 'kept', '--', '--plugin-dir', 'not-a-flag'], cwd)).toEqual([
            { type: 'local', path: resolve(cwd, 'kept') },
        ]);
    });

    it.each([[undefined], [[]], [['--model', 'opus']], [['--', '--plugin-dir', 'x']]])(
        'is undefined without an explicit option: %j', (args) => {
            expect(pluginsFromArgs(args, cwd)).toBeUndefined();
        },
    );

    it.each([
        [['--plugin-dir']],
        [['--plugin-dir', '--dangerously-skip-permissions']],
        [['--plugin-dir', '']],
        [['--plugin-dir=']],
        [['--plugin-dir=bad\0path']],
        [['--plugin-dir', 'bad\0path']],
    ])('rejects a missing, empty or NUL path: %j', (args) => {
        expect(() => pluginsFromArgs(args, cwd)).toThrow('--plugin-dir requires');
    });

    it('does not change the arguments it reads', () => {
        const args = ['--plugin-dir', 'a', '--plugin-dir=b'];
        pluginsFromArgs(args, cwd);
        expect(args).toEqual(['--plugin-dir', 'a', '--plugin-dir=b']);
    });
});
