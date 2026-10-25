import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';

// The daemon and its sessions run detached, without a console of their own. On Windows a console
// program they start without windowsHide gets a new, visible console window for its whole life.
const mocks = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: mocks.execFile,
  spawn: mocks.spawn,
}));

import { probeManagedScriptEngine } from './automations/managedScriptRuntime';
import { createEvidenceIo } from './previewRuntimeEvidence';
import { runBashStream } from '@/claude/utils/bashStream';

beforeEach(() => {
  mocks.execFile.mockReset();
  mocks.spawn.mockReset();
});

it('hides the docker engine probe that the script runtime repeats while ready', async () => {
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, { stdout: 'linux\n', stderr: '' }));

  await probeManagedScriptEngine();

  expect(mocks.execFile).toHaveBeenCalledWith('docker', ['info', '--format', '{{.OSType}}'], expect.objectContaining({ windowsHide: true }), expect.any(Function));
});

it('hides the commands the preview proxy runs for runtime evidence', async () => {
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, '', ''));

  await createEvidenceIo().exec('docker', ['ps'], 1_000);

  expect(mocks.execFile).toHaveBeenCalledWith('docker', ['ps'], expect.objectContaining({ windowsHide: true }), expect.any(Function));
});

it('hides the shell that bash_stream starts for each command', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  mocks.spawn.mockImplementation(() => {
    setImmediate(() => child.emit('close', 0));
    return child;
  });

  await runBashStream({ command: 'true', onProgress: () => {} });

  expect(mocks.spawn).toHaveBeenCalledWith('bash', ['-c', 'true'], expect.objectContaining({ windowsHide: true }));
});
