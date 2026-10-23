import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execSync: vi.fn(), platform: vi.fn() }));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execSync: mocks.execSync,
}));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, platform: mocks.platform } };
});

import { detectCLIAvailability } from './detectCLI';

let binDir: string;
let homeDir: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'detect-cli-bin-'));
  homeDir = mkdtempSync(join(tmpdir(), 'detect-cli-home-'));
  mocks.execSync.mockReset();
  mocks.platform.mockReturnValue('win32');
  delete process.env.OPENCLAW_GATEWAY_URL;
  process.env.USERPROFILE = homeDir;
  process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
});

afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(binDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

// The daemon re-detects every keep-alive (20s). Starting powershell for each CLI flashed a
// console window on Windows even with windowsHide, so Windows detection must not spawn at all.
it('finds Windows CLIs on Path without starting a process', () => {
  writeFileSync(join(binDir, 'codex.cmd'), '');
  writeFileSync(join(binDir, 'claude.exe'), '');
  writeFileSync(join(binDir, 'gemini.ps1'), '');
  process.env.PATH = ['C:\\missing', `"${binDir}"`, ''].join(';');

  const availability = detectCLIAvailability();

  expect(availability).toMatchObject({ claude: true, codex: true, gemini: true, openclaw: false });
  expect(mocks.execSync).not.toHaveBeenCalled();
});

it('reports a Windows CLI missing when no Path entry holds an executable for it', () => {
  writeFileSync(join(binDir, 'codex.txt'), '');
  process.env.PATH = binDir;

  expect(detectCLIAvailability()).toMatchObject({ claude: false, codex: false, gemini: false, openclaw: false });
  expect(mocks.execSync).not.toHaveBeenCalled();
});

it('ignores a Path directory named like an executable and a broken link', () => {
  mkdirSync(join(binDir, 'claude.exe'));
  symlinkSync(join(binDir, 'missing-codex.exe'), join(binDir, 'codex.exe'));
  writeFileSync(join(binDir, 'real-gemini.exe'), '');
  symlinkSync(join(binDir, 'real-gemini.exe'), join(binDir, 'gemini.exe'));
  process.env.PATH = binDir;

  expect(detectCLIAvailability()).toMatchObject({ claude: false, codex: false, gemini: true });
});

it('falls back to the default executable extensions when PATHEXT holds only empty entries', () => {
  writeFileSync(join(binDir, 'codex.cmd'), '');
  process.env.PATH = binDir;
  process.env.PATHEXT = ' ; ;';

  expect(detectCLIAvailability()).toMatchObject({ codex: true });
});
