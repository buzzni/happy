/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary 4b-3 preview stage 2 — the server seals a
 * preview's merged env for one strict machine; the daemon checks what it opens before a process
 * gets any of it.
 */
import { describe, expect, it } from 'vitest';
import {
  SEALED_SPAWN_ENV_CAPABILITY,
  SEALED_SPAWN_ENV_MAX_TIMEOUT_MS,
  SEALED_SPAWN_ENV_WINDOW_MS,
  readSealedSpawnEnvPayload,
  rejectedSealedSpawnEnvNames,
  sealedSpawnEnvCapabilitySchema,
} from './sealedSpawnEnv';

const nonce = Buffer.alloc(16, 9).toString('base64');
const issuedAt = 1_790_000_000_000;
const payload = (over: Record<string, unknown> = {}) => ({
  v: 1,
  purpose: 'spawn-env',
  machineId: 'machine-1',
  projectId: 'project-1',
  issuedAt,
  nonce,
  env: { DATABASE_URL: 'postgres://db', API_KEY: 'k' },
  ...over,
});
const expected = { machineId: 'machine-1', now: issuedAt + 1_000 };

describe('rejectedSealedSpawnEnvNames', () => {
  it('lets ordinary application variables through', () => {
    expect(rejectedSealedSpawnEnvNames(['DATABASE_URL', 'API_KEY', 'NEXT_PUBLIC_API_URL', 'my_var', 'PORT'])).toEqual([]);
  });

  it('refuses names a runtime, shell or package manager executes or loads from', () => {
    const names = [
      'PATH', 'HOME', 'SHELL', 'ENV', 'BASH_ENV', 'IFS', 'PS4', 'PROMPT_COMMAND',
      'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES',
      'PYTHONSTARTUP', 'PYTHONPATH', 'PERL5OPT', 'RUBYOPT', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS',
      'GIT_SSH_COMMAND', 'GIT_CONFIG_GLOBAL', 'npm_config_registry', 'NPM_CONFIG_USERCONFIG', 'YARN_RC_FILENAME',
      'PIP_INDEX_URL', 'DOCKER_HOST', 'HTTP_PROXY', 'https_proxy', 'HAPPY_HOME_DIR', 'SAYCODE_TOKEN',
      'APLUS_SEALED_ENV_FILE', 'ComSpec', 'PathExt',
    ];
    expect(rejectedSealedSpawnEnvNames(names)).toEqual(names);
  });

  it('lets NODE_ENV through: it selects a mode, it loads nothing', () => {
    expect(rejectedSealedSpawnEnvNames(['NODE_ENV', 'node_env'])).toEqual([]);
    expect(rejectedSealedSpawnEnvNames(['NODE_OPTIONS', 'NODE_ENV_FILE'])).toEqual(['NODE_OPTIONS', 'NODE_ENV_FILE']);
  });

  it('compares without case, as Windows does', () => {
    expect(rejectedSealedSpawnEnvNames(['Path', 'node_options', 'Ld_Preload'])).toEqual(['Path', 'node_options', 'Ld_Preload']);
  });

  it('refuses names that are not plain identifiers', () => {
    expect(rejectedSealedSpawnEnvNames(['', '1ABC', 'A-B', 'A B', 'A=B', 'x'.repeat(129)])).toHaveLength(6);
  });
});

describe('readSealedSpawnEnvPayload', () => {
  it('returns the env of a payload sealed for this machine just now', () => {
    expect(readSealedSpawnEnvPayload(payload(), expected)).toEqual({
      ok: true,
      nonce,
      env: { DATABASE_URL: 'postgres://db', API_KEY: 'k' },
    });
  });

  it('refuses a payload that is not a spawn env payload', () => {
    for (const bad of [null, 'x', payload({ v: 2 }), payload({ purpose: 'rpc' }), payload({ env: { A: 1 } }), payload({ extra: true })]) {
      expect(readSealedSpawnEnvPayload(bad, expected)).toEqual({ ok: false, code: 'SEALED_ENV_MALFORMED' });
    }
  });

  it('refuses a payload sealed for another machine', () => {
    expect(readSealedSpawnEnvPayload(payload({ machineId: 'machine-2' }), expected)).toEqual({ ok: false, code: 'SEALED_ENV_MACHINE_MISMATCH' });
  });

  it('refuses a payload issued outside the window, either way', () => {
    for (const shift of [SEALED_SPAWN_ENV_WINDOW_MS + 1, -(SEALED_SPAWN_ENV_WINDOW_MS + 1)]) {
      expect(readSealedSpawnEnvPayload(payload(), { ...expected, now: issuedAt + shift })).toEqual({ ok: false, code: 'SEALED_ENV_STALE' });
    }
  });

  it('refuses the whole payload when any name is reserved, and names them', () => {
    expect(readSealedSpawnEnvPayload(payload({ env: { API_KEY: 'k', NODE_OPTIONS: '--require /tmp/x.js', PATH: '/tmp' } }), expected))
      .toEqual({ ok: false, code: 'SEALED_ENV_RESERVED_NAME', names: ['NODE_OPTIONS', 'PATH'] });
  });
});

describe('sealedSpawnEnvCapabilitySchema', () => {
  it('reads the capability the daemon advertises', () => {
    expect(sealedSpawnEnvCapabilitySchema.parse(SEALED_SPAWN_ENV_CAPABILITY)).toEqual({ version: 1 });
    expect(sealedSpawnEnvCapabilitySchema.safeParse({ version: 2 }).success).toBe(false);
  });
});

describe('SEALED_SPAWN_ENV_MAX_TIMEOUT_MS', () => {
  it('covers the longest preview start the web sends: a container start with a cold image pull (15 minutes)', () => {
    expect(SEALED_SPAWN_ENV_MAX_TIMEOUT_MS).toBeGreaterThanOrEqual(15 * 60_000);
  });
});
