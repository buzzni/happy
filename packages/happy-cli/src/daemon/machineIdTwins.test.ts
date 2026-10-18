import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findMachineIdTwins, listMachineIdTwins } from './machineIdTwins';

describe('findMachineIdTwins', () => {
    it('names every other home whose settings carry the same machine id', () => {
        expect(findMachineIdTwins({
            homeDir: '/u/.happy_remote2',
            machineId: 'm-1',
            siblings: [
                { dir: '/u/.happy_remote2', settingsJson: '{"machineId":"m-1"}' },
                { dir: '/u/.happy_remote2_backup', settingsJson: '{"machineId":"m-1"}' },
                { dir: '/u/.happy', settingsJson: '{"machineId":"m-2"}' },
                { dir: '/u/.happy_broken', settingsJson: '{not json' },
                { dir: '/u/.happy_empty', settingsJson: null },
            ],
        })).toEqual(['/u/.happy_remote2_backup']);
    });
});

describe('listMachineIdTwins', () => {
    let root: string;
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('reads only .happy* siblings of the daemon home', () => {
        root = mkdtempSync(join(tmpdir(), 'twins-'));
        for (const [name, id] of [['.happy_remote2', 'm-1'], ['.happy_remote2_backup', 'm-1'], ['.happy', 'm-2'], ['other', 'm-1']] as const) {
            mkdirSync(join(root, name));
            writeFileSync(join(root, name, 'settings.json'), JSON.stringify({ machineId: id }));
        }
        expect(listMachineIdTwins(join(root, '.happy_remote2'), 'm-1')).toEqual([join(root, '.happy_remote2_backup')]);
    });

    it('skips symlinked homes, non-file settings and oversized settings instead of reading them', () => {
        root = mkdtempSync(join(tmpdir(), 'twins-'));
        mkdirSync(join(root, '.happy_remote2'));
        writeFileSync(join(root, '.happy_remote2', 'settings.json'), JSON.stringify({ machineId: 'm-1' }));
        mkdirSync(join(root, 'elsewhere'));
        writeFileSync(join(root, 'elsewhere', 'settings.json'), JSON.stringify({ machineId: 'm-1' }));
        symlinkSync(join(root, 'elsewhere'), join(root, '.happy_link'));
        mkdirSync(join(root, '.happy_dir_settings', 'settings.json'), { recursive: true });
        mkdirSync(join(root, '.happy_big'));
        writeFileSync(join(root, '.happy_big', 'settings.json'), JSON.stringify({ machineId: 'm-1', pad: 'x'.repeat(70 * 1024) }));
        expect(listMachineIdTwins(join(root, '.happy_remote2'), 'm-1')).toEqual([]);
    });

    it('looks next to the real home when HAPPY_HOME_DIR is a symlink', () => {
        root = mkdtempSync(join(tmpdir(), 'twins-'));
        for (const name of ['.happy_remote2', '.happy_remote2_backup']) {
            mkdirSync(join(root, 'real', name), { recursive: true });
            writeFileSync(join(root, 'real', name, 'settings.json'), JSON.stringify({ machineId: 'm-1' }));
        }
        mkdirSync(join(root, 'links'));
        symlinkSync(join(root, 'real', '.happy_remote2'), join(root, 'links', '.happy'));
        expect(listMachineIdTwins(join(root, 'links', '.happy'), 'm-1')).toEqual([join(root, 'real', '.happy_remote2_backup')]);
    });

    it('never throws when the parent cannot be read', () => {
        root = mkdtempSync(join(tmpdir(), 'twins-'));
        expect(listMachineIdTwins(join(root, 'missing', '.happy'), 'm-1')).toEqual([]);
    });
});
