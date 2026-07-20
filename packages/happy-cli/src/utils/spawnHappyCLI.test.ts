import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { preflightInstalledHappyCLI, resolveHappyCliSpawnCommand } from './spawnHappyCLI';

describe('resolveHappyCliSpawnCommand', () => {
  it('uses the source entrypoint when the current CLI is running from source', () => {
    const projectRoot = '/repo/packages/happy-cli';
    const result = resolveHappyCliSpawnCommand(['daemon', 'start-sync'], {
      projectRoot,
      execPath: '/node',
      execArgv: ['--import', '/repo/node_modules/tsx/loader.mjs'],
      argv: ['/node', join(projectRoot, 'src', 'index.ts'), 'daemon', 'start-sync'],
      isBunRuntime: false,
    });

    expect(result.runtime).toBe('/node');
    expect(result.entrypoint).toBe(join(projectRoot, 'src', 'index.ts'));
    expect(result.tsconfigPath).toBe(join(projectRoot, 'tsconfig.json'));
    expect(result.args).toEqual([
      '--no-warnings',
      '--no-deprecation',
      '--import',
      '/repo/node_modules/tsx/loader.mjs',
      join(projectRoot, 'src', 'index.ts'),
      'daemon',
      'start-sync',
    ]);
  });

  it('uses the bundled dist entrypoint for production CLI processes', () => {
    const projectRoot = '/repo/packages/happy-cli';
    const result = resolveHappyCliSpawnCommand(['claude'], {
      projectRoot,
      execPath: '/node',
      execArgv: [],
      argv: ['/node', join(projectRoot, 'dist', 'index.mjs'), 'daemon', 'start-sync'],
      isBunRuntime: false,
    });

    expect(result.runtime).toBe('node');
    expect(result.entrypoint).toBe(join(projectRoot, 'dist', 'index.mjs'));
    expect(result.tsconfigPath).toBeUndefined();
    expect(result.args).toEqual([
      '--no-warnings',
      '--no-deprecation',
      join(projectRoot, 'dist', 'index.mjs'),
      'claude',
    ]);
  });
});

describe('preflightInstalledHappyCLI', () => {
  it('reports ready only when the candidate preflight exits successfully', async () => {
    const child = new EventEmitter() as ChildProcess
    child.kill = vi.fn()
    const spawn = vi.fn(() => child)
    const preflight = preflightInstalledHappyCLI({ spawn, timeoutMs: 1_000 })

    child.emit('exit', 0)

    await expect(preflight).resolves.toBe(true)
    expect(spawn).toHaveBeenCalledWith(['daemon', 'preflight'], { stdio: 'ignore' })
  })

  it('reports not ready when the candidate preflight fails', async () => {
    const child = new EventEmitter() as ChildProcess
    child.kill = vi.fn()
    const preflight = preflightInstalledHappyCLI({ spawn: () => child, timeoutMs: 1_000 })

    child.emit('exit', 1)

    await expect(preflight).resolves.toBe(false)
  })
})
