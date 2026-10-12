import { describe, expect, it } from 'vitest';
import { ScriptRequestError } from './scriptAutomationWorker';
import {
  SCRIPT_RUNTIME_RELEASE_IMAGE,
  classifyScriptRuntimeFailure,
  isImmutableScriptImage,
  resolveScriptRuntimeImage,
  scriptRuntimeReadiness,
  scriptRuntimeReadinessKey,
} from './scriptRuntimeReadiness';

const DIGEST = 'a'.repeat(64);

describe('script runtime image resolution', () => {
  it('ships an immutable release image so Desktop-started daemons need no shell environment', () => {
    expect(isImmutableScriptImage(SCRIPT_RUNTIME_RELEASE_IMAGE)).toBe(true);
    expect(resolveScriptRuntimeImage({})).toEqual({ ok: true, image: SCRIPT_RUNTIME_RELEASE_IMAGE, source: 'release' });
  });

  it('lets an operator override the release image with another immutable digest', () => {
    const image = `registry.example/node@sha256:${DIGEST}`;
    expect(resolveScriptRuntimeImage({ HAPPY_SCRIPT_RUNTIME_IMAGE: image })).toEqual({ ok: true, image, source: 'env' });
  });

  it('rejects a mutable override instead of silently falling back to the release image', () => {
    expect(resolveScriptRuntimeImage({ HAPPY_SCRIPT_RUNTIME_IMAGE: 'node:24' })).toEqual({ ok: false, code: 'IMAGE_INVALID' });
  });

  it('treats a blank override as unset', () => {
    expect(resolveScriptRuntimeImage({ HAPPY_SCRIPT_RUNTIME_IMAGE: '  ' }).ok).toBe(true);
  });

  it('accepts only digest-pinned references', () => {
    expect(isImmutableScriptImage(`sha256:${DIGEST}`)).toBe(true);
    expect(isImmutableScriptImage('node:24-alpine')).toBe(false);
    expect(isImmutableScriptImage(`node@sha256:${DIGEST.slice(1)}`)).toBe(false);
  });
});

describe('script runtime failure classification', () => {
  const code = (error: unknown) => classifyScriptRuntimeFailure(error);
  it('maps each setup failure to a stable enum', () => {
    expect(code(new Error('SCRIPT_RUNTIME_IMAGE_REQUIRED'))).toBe('IMAGE_MISSING');
    expect(code(new Error('IMMUTABLE_IMAGE_REQUIRED'))).toBe('IMAGE_INVALID');
    expect(code(new Error('SCRIPT_STUDIO_AUTHORIZATION_REQUIRED'))).toBe('STUDIO_CONFIG_MISSING');
    expect(code(new Error('SCRIPT_STUDIO_HTTPS_REQUIRED'))).toBe('STUDIO_CONFIG_INVALID');
    expect(code(new Error('SCRIPT_LINUX_RUNTIME_REQUIRED'))).toBe('ENGINE_UNSUPPORTED');
    expect(code(new Error('SCRIPT_RUNTIME_PREFLIGHT_FAILED'))).toBe('PROBE_FAILED');
  });

  it('tells a missing docker binary and a stopped engine apart from a failed probe', () => {
    expect(code(Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }))).toBe('DOCKER_UNAVAILABLE');
    expect(code(Object.assign(new Error('Command failed: docker info'), { stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' }))).toBe('DOCKER_UNAVAILABLE');
    // Docker CLI 29 on macOS, observed with DOCKER_HOST pointing at a missing socket.
    expect(code(Object.assign(new Error('Command failed: docker info --format {{.OSType}}'), {
      stderr: 'failed to connect to the docker API at unix:///nonexistent.sock; check if the path is correct and if the daemon is running: dial unix /nonexistent.sock: connect: no such file or directory',
    }))).toBe('DOCKER_UNAVAILABLE');
    expect(code(Object.assign(new Error('Command failed: docker info'), { stderr: 'permission denied while trying to connect to the Docker daemon socket' }))).toBe('DOCKER_UNAVAILABLE');
  });

  it('separates a server that has the feature off from one that is unreachable', () => {
    expect(code(new ScriptRequestError(404, 'SCRIPT_AUTOMATIONS_DISABLED'))).toBe('SERVER_DISABLED');
    expect(code(new ScriptRequestError(503, 'SCRIPT_REQUEST_FAILED'))).toBe('SERVER_UNAVAILABLE');
  });

  it('never leaks the raw message for unknown failures', () => {
    expect(code(new Error('boom /Users/someone/secret'))).toBe('UNKNOWN');
  });
});

describe('script runtime readiness DTO', () => {
  const now = 1_700_000_000_000;
  it('exposes only enums, a timestamp and a short image fingerprint', () => {
    const image = `node@sha256:${DIGEST}`;
    expect(scriptRuntimeReadiness({ state: 'ready', now, image: { image, source: 'env' } })).toEqual({
      state: 'ready', checkedAt: now, imageSource: 'env', imageFingerprint: DIGEST.slice(0, 12),
    });
  });

  it('carries the failure code and omits the fingerprint when no image was resolved', () => {
    expect(scriptRuntimeReadiness({ state: 'unavailable', code: 'IMAGE_INVALID', now })).toEqual({
      state: 'unavailable', code: 'IMAGE_INVALID', checkedAt: now,
    });
  });

  it('changes its key only when the observable state changes, not on every check', () => {
    const a = scriptRuntimeReadiness({ state: 'unavailable', code: 'DOCKER_UNAVAILABLE', now });
    const b = scriptRuntimeReadiness({ state: 'unavailable', code: 'DOCKER_UNAVAILABLE', now: now + 60_000 });
    const c = scriptRuntimeReadiness({ state: 'ready', now });
    expect(scriptRuntimeReadinessKey(a)).toBe(scriptRuntimeReadinessKey(b));
    expect(scriptRuntimeReadinessKey(a)).not.toBe(scriptRuntimeReadinessKey(c));
  });
});
