import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createMachineTypeMarker } from './machineTypeMarker';

const homes: string[] = [];
const home = () => { const dir = mkdtempSync(join(tmpdir(), 'machine-type-')); homes.push(dir); return dir; };
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('records the machine type once, owner-only, and never overwrites it', async () => {
    const dir = home();
    const marker = createMachineTypeMarker({ home: dir, machineId: 'machine-1' });
    await expect(marker.read()).resolves.toBeNull();
    await expect(marker.record('shared')).resolves.toBe('recorded');
    await expect(marker.read()).resolves.toBe('shared');
    await expect(marker.record('dedicated')).resolves.toBe('exists');
    await expect(marker.read()).resolves.toBe('shared');
    const [file] = readdirSync(dir);
    if (process.platform !== 'win32') expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
});

it('keeps one record per machine id, so a re-registered machine gets its own', async () => {
    const dir = home();
    await createMachineTypeMarker({ home: dir, machineId: 'machine-1' }).record('dedicated');
    const next = createMachineTypeMarker({ home: dir, machineId: 'machine-2' });
    await expect(next.read()).resolves.toBeNull();
    await expect(next.record('shared')).resolves.toBe('recorded');
    await expect(next.read()).resolves.toBe('shared');
});

it('reads a record that names another machine or is malformed as no record', async () => {
    const dir = home();
    const marker = createMachineTypeMarker({ home: dir, machineId: 'machine-1' });
    await marker.record('shared');
    const [file] = readdirSync(dir);
    for (const content of [JSON.stringify({ version: 1, machineId: 'machine-9', machineType: 'shared' }), '{', JSON.stringify({ version: 1, machineId: 'machine-1', machineType: 'personal' })]) {
        writeFileSync(join(dir, file), content);
        await expect(marker.read()).resolves.toBeNull();
    }
});
