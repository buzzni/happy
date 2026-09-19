import { describe, expect, it } from 'vitest';
import { MachineMetadataSchema, MessageMetaSchema } from './types';

describe('MessageMetaSchema', () => {
  it('preserves an explicit Saycode system prompt policy', () => {
    expect(MessageMetaSchema.parse({ saycodeSystemPromptEnabled: false }))
      .toEqual({ saycodeSystemPromptEnabled: false });
  });

  it('preserves per-block Saycode prompt overrides', () => {
    const input = {
      saycodeSystemPromptEnabled: false,
      saycodePromptBlocks: {
        agentOrchestration: false,
        coAuthoredCredit: true,
        workerDelegation: false,
      },
    };
    expect(MessageMetaSchema.parse(input)).toEqual(input);
  });
});

describe('MessageMetaSchema saycodePromptBlocks resilience', () => {
  // safeParse failure in apiSession.routeIncomingMessage does not surface an error —
  // the message stops being routed as a user message at all. An optional preference
  // field must never be able to drop the user's message.
  it('accepts null as a reset, like every other override field in this schema', () => {
    expect(MessageMetaSchema.safeParse({ saycodePromptBlocks: null }).success).toBe(true);
  });

  it('never fails the whole message on a malformed block map', () => {
    const parsed = MessageMetaSchema.safeParse({
      permissionMode: 'default',
      saycodePromptBlocks: { coAuthoredCredit: 'yes-please' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.permissionMode).toBe('default');
  });
});

describe('MessageMetaSchema modelSource', () => {
  // Clients that auto-route a Default session send a concrete model they did not
  // pin. Without this marker the CLI cannot tell that choice apart from a user
  // pin, and publishing it back as the session's active pin would freeze the
  // session on whatever the router last picked.
  it('preserves an explicit auto marker', () => {
    expect(MessageMetaSchema.parse({ model: 'claude-sonnet-5', modelSource: 'auto' }))
      .toEqual({ model: 'claude-sonnet-5', modelSource: 'auto' });
  });

  it('preserves an explicit user marker', () => {
    expect(MessageMetaSchema.parse({ modelSource: 'user' }))
      .toEqual({ modelSource: 'user' });
  });

  // Absent marker means "user pin" so that desktop/web, which never sends the
  // field, keeps working unchanged.
  it('leaves the marker undefined when the client omits it', () => {
    expect(MessageMetaSchema.parse({ model: 'claude-opus-5' }).modelSource).toBeUndefined();
  });

  // Same hazard as saycodePromptBlocks: a safeParse failure in
  // apiSession.routeIncomingMessage stops routing the message as a user message
  // entirely. An unknown marker must never drop the turn.
  it('never fails the whole message on an unknown marker', () => {
    const parsed = MessageMetaSchema.safeParse({
      permissionMode: 'default',
      model: 'claude-opus-5',
      modelSource: 'router-v2',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.permissionMode).toBe('default');
    expect(parsed.success && parsed.data.model).toBe('claude-opus-5');
  });

  // It degrades to 'auto', not to "no marker". A client that named a provenance
  // we cannot read has said this is something other than a plain user pin, and
  // "no marker" means user pin — which would freeze the session on that model.
  it('degrades an unreadable marker to auto rather than to a user pin', () => {
    expect(MessageMetaSchema.parse({ modelSource: 'router-v2' }).modelSource).toBe('auto');
    expect(MessageMetaSchema.parse({ modelSource: 42 }).modelSource).toBe('auto');
    expect(MessageMetaSchema.parse({ modelSource: null }).modelSource).toBe('auto');
  });
});

describe('channelSupport approvals capability', () => {
    const base = {
        host: 'h', platform: 'darwin', happyCliVersion: '1.0.0',
        homeDir: '/h', happyHomeDir: '/h/.happy', happyLibDir: '/h/.happy/lib',
    };

    it('parses a daemon that relays channel messages but cannot answer prompts', () => {
        // The pre-T21 shape. Absence of `approvals` is the unsafe case, and a consumer must fail
        // closed on it rather than read it as "probably fine".
        const parsed = MachineMetadataSchema.safeParse({
            ...base,
            channelSupport: { protocolVersion: 1, engines: ['claude', 'codex'] },
        });
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.channelSupport?.approvals).toBeUndefined();
    });

    it('parses the approvals object with its own protocol version', () => {
        const parsed = MachineMetadataSchema.safeParse({
            ...base,
            channelSupport: {
                protocolVersion: 1,
                engines: ['claude', 'codex'],
                approvals: { protocolVersion: 1, engines: ['claude'] },
            },
        });
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.channelSupport?.approvals)
            .toEqual({ protocolVersion: 1, engines: ['claude'] });
    });

    it('refuses an approvals block without a protocol version, or with a future one', () => {
        for (const approvals of [
            { engines: ['claude'] },
            { protocolVersion: 2, engines: ['claude'] },
            { protocolVersion: 1 },
            true,
        ]) {
            const parsed = MachineMetadataSchema.safeParse({
                ...base,
                channelSupport: { protocolVersion: 1, engines: ['claude'], approvals },
            });
            expect(parsed.success, JSON.stringify(approvals)).toBe(false);
        }
    });

    it('refuses an engine name outside the known set', () => {
        const parsed = MachineMetadataSchema.safeParse({
            ...base,
            channelSupport: {
                protocolVersion: 1, engines: ['claude'],
                approvals: { protocolVersion: 1, engines: ['acp'] },
            },
        });
        expect(parsed.success).toBe(false);
    });
});
