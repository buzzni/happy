import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '../core';
import { DefaultTransport } from '../transport';
import {
  completeToolCall,
  handleToolCall,
  type HandlerContext,
  type SessionUpdate,
} from './sessionUpdateHandlers';

function createContext(): { ctx: HandlerContext; emitted: AgentMessage[] } {
  const emitted: AgentMessage[] = [];
  const ctx: HandlerContext = {
    transport: new DefaultTransport('grok'),
    activeToolCalls: new Set<string>(),
    toolCallStartTimes: new Map<string, number>(),
    toolCallTimeouts: new Map<string, NodeJS.Timeout>(),
    toolCallIdToNameMap: new Map<string, string>(),
    idleTimeout: null,
    toolCallCountSincePrompt: 0,
    emit: (msg) => emitted.push(msg),
    emitIdleStatus: vi.fn(),
    clearIdleTimeout: vi.fn(),
    setIdleTimeout: vi.fn(),
  };
  return { ctx, emitted };
}

function toolCallEvent(emitted: AgentMessage[]): Record<string, unknown> {
  const event = emitted.find((msg) => (msg as { type?: string }).type === 'tool-call');
  expect(event).toBeDefined();
  return event as unknown as Record<string, unknown>;
}

/**
 * Real payloads captured from `grok agent stdio` (see
 * specs/acp-grok-tool-name-and-title/spec.md).
 */
const GROK_TOOL_CALL: SessionUpdate = {
  sessionUpdate: 'tool_call',
  toolCallId: 'call-ce5ee8d5-0',
  title: 'read_file',
  rawInput: { target_file: 'sample.txt' },
  _meta: { 'x.ai/tool': { version: 1, name: 'read_file', kind: 'read', label: 'Read' } },
};

describe('startToolCall tool naming', () => {
  it('shouldUseXaiMetaToolNameWhenKindIsMissing', () => {
    const { ctx, emitted } = createContext();

    handleToolCall(GROK_TOOL_CALL, ctx);

    expect(toolCallEvent(emitted).toolName).toBe('read_file');
    expect(ctx.toolCallIdToNameMap.get('call-ce5ee8d5-0')).toBe('read_file');
  });

  it('shouldFallBackToTitleWhenMetaIsAbsent', () => {
    const { ctx, emitted } = createContext();

    handleToolCall({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'grep' }, ctx);

    expect(toolCallEvent(emitted).toolName).toBe('grep');
  });

  it('shouldKeepKindAsToolNameForAgentsThatSendIt', () => {
    const { ctx, emitted } = createContext();

    handleToolCall({ sessionUpdate: 'tool_call', toolCallId: 'call-2', kind: 'execute' }, ctx);

    expect(toolCallEvent(emitted).toolName).toBe('execute');
  });

  it('shouldReportUnknownOnlyWhenNoNameSourceExists', () => {
    const { ctx, emitted } = createContext();

    handleToolCall({ sessionUpdate: 'tool_call', toolCallId: 'call-3' }, ctx);

    expect(toolCallEvent(emitted).toolName).toBe('unknown');
  });
});

describe('startToolCall args', () => {
  it('shouldUseRawInputWhenContentCarriesNoArgs', () => {
    const { ctx, emitted } = createContext();

    handleToolCall(GROK_TOOL_CALL, ctx);

    expect(toolCallEvent(emitted).args).toEqual({ target_file: 'sample.txt' });
  });

  it('shouldFallBackToContentWhenRawInputIsEmpty', () => {
    const { ctx, emitted } = createContext();

    handleToolCall(
      { sessionUpdate: 'tool_call', toolCallId: 'call-4', kind: 'execute', rawInput: {}, content: { command: 'ls' } },
      ctx,
    );

    expect(toolCallEvent(emitted).args).toEqual({ command: 'ls' });
  });

  it('shouldKeepLocationsAlongsideRawInput', () => {
    const { ctx, emitted } = createContext();

    handleToolCall({ ...GROK_TOOL_CALL, locations: [{ path: 'sample.txt' }] }, ctx);

    expect(toolCallEvent(emitted).args).toEqual({
      target_file: 'sample.txt',
      locations: [{ path: 'sample.txt' }],
    });
  });
});

describe('completeToolCall tool naming', () => {
  it('shouldReuseTheNameRecordedAtStartWhenTerminalUpdateOmitsKind', () => {
    const { ctx, emitted } = createContext();
    handleToolCall(GROK_TOOL_CALL, ctx);

    completeToolCall('call-ce5ee8d5-0', undefined, [{ type: 'content' }], ctx);

    const result = emitted.find((msg) => (msg as { type?: string }).type === 'tool-result');
    expect(result).toBeDefined();
    expect((result as unknown as Record<string, unknown>).toolName).toBe('read_file');
  });
});
