import { describe, expect, it } from 'vitest';
import { automationPayloadSchema } from './automation';
import { scriptAutomationPayloadSchema, scriptInvocationRequestSchema, scriptScheduleSchema } from './scriptAutomation';

const script = {
  version: 3, name: 'Collect items', action: { kind: 'script', runtime: 'node',
    artifactId: 'artifact-1', digest: 'a'.repeat(64), entrypoint: 'collect.mjs',
    args: [], timeoutSeconds: 300, secretRefs: {}, allowedOrigins: [],
  }, schedule: null, externalEnabled: false, inputSchema: { type: 'object', additionalProperties: false },
};

describe('script-only automation contract', () => {
  it('registers without schedule, prompt, agent or model and cannot be parsed by the legacy executor', () => {
    expect(scriptAutomationPayloadSchema.parse(script)).toEqual(script);
    expect(automationPayloadSchema.safeParse(script).success).toBe(false);
  });

  it('rejects execution overrides rather than stripping unknown fields', () => {
    for (const field of ['prompt', 'agent', 'model', 'scriptCommand', 'directory']) {
      expect(scriptAutomationPayloadSchema.safeParse({ ...script, [field]: 'override' }).success).toBe(false);
    }
    expect(scriptInvocationRequestSchema.parse({ input: { source: 'feed' } })).toEqual({ input: { source: 'feed' } });
    for (const field of ['command', 'cwd', 'env', 'source', 'runAs']) {
      expect(scriptInvocationRequestSchema.safeParse({ input: {}, [field]: 'override' }).success).toBe(false);
    }
  });

  it('requires valid bounded runtime configuration and contained entrypoints', () => {
    for (const entrypoint of ['../x.mjs', '/x.mjs', 'a/../../x.mjs', 'a\\x.mjs', 'a//x.mjs', 'a/./x.mjs']) {
      expect(scriptAutomationPayloadSchema.safeParse({ ...script, action: { ...script.action, entrypoint } }).success).toBe(false);
    }
    for (const timeoutSeconds of [0, 1801, 1.5]) {
      expect(scriptAutomationPayloadSchema.safeParse({ ...script, action: { ...script.action, timeoutSeconds } }).success).toBe(false);
    }
    expect(scriptAutomationPayloadSchema.safeParse({ ...script, action: { ...script.action, secretRefs: { NODE_OPTIONS: 'secret' } } }).success).toBe(false);
    expect(scriptAutomationPayloadSchema.safeParse({ ...script, action: { ...script.action, secretRefs: { PB_TOKEN: 'secret' } } }).success).toBe(true);
  });

  it('requires explicit timezone for wall-clock schedules and validates calendar fields', () => {
    expect(scriptScheduleSchema.parse({ kind: 'at', at: 1_800_000_000_000, enabled: true })).toBeTruthy();
    expect(scriptScheduleSchema.parse({ kind: 'interval', minutes: 15, enabled: false })).toBeTruthy();
    expect(scriptScheduleSchema.parse({ kind: 'daily', hour: 9, minute: 0, timezone: 'Asia/Seoul', enabled: true })).toBeTruthy();
    expect(scriptScheduleSchema.parse({ kind: 'weekly', days: [1, 3], hour: 9, minute: 0, timezone: 'Asia/Seoul', enabled: true })).toBeTruthy();
    for (const timezone of ['Made/Up', '']) {
      expect(scriptScheduleSchema.safeParse({ kind: 'daily', hour: 9, minute: 0, timezone, enabled: true }).success).toBe(false);
    }
    expect(scriptScheduleSchema.safeParse({ kind: 'weekly', days: [1, 1], hour: 9, minute: 0, timezone: 'UTC', enabled: true }).success).toBe(false);
    expect(scriptScheduleSchema.safeParse({ kind: 'daily', hour: 24, minute: 0, timezone: 'UTC', enabled: true }).success).toBe(false);
  });
});
