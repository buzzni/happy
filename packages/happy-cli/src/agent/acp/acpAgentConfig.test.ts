import { describe, expect, it } from 'vitest';
import { KNOWN_ACP_AGENTS, parseAcpSubcommandArgs, resolveAcpAgentConfig } from './acpAgentConfig';

describe('parseAcpSubcommandArgs', () => {
  it('extracts happy-owned flags and leaves the agent argv intact', () => {
    expect(parseAcpSubcommandArgs(['--started-by', 'daemon', '--verbose', 'gemini'])).toEqual({
      startedBy: 'daemon',
      verbose: true,
      acpArgs: ['gemini'],
    });
  });

  it('defaults to terminal-unset and non-verbose', () => {
    expect(parseAcpSubcommandArgs(['gemini'])).toEqual({
      startedBy: undefined,
      verbose: false,
      acpArgs: ['gemini'],
    });
  });

  it('stops claiming flags once the -- separator hands argv to the agent', () => {
    expect(parseAcpSubcommandArgs(['--', 'custom-agent', '--verbose', '--started-by', 'daemon'])).toEqual({
      startedBy: undefined,
      verbose: false,
      acpArgs: ['--', 'custom-agent', '--verbose', '--started-by', 'daemon'],
    });
  });

  it('keeps happy flags that precede the -- separator', () => {
    expect(parseAcpSubcommandArgs(['--verbose', '--', 'custom-agent', '--verbose'])).toEqual({
      startedBy: undefined,
      verbose: true,
      acpArgs: ['--', 'custom-agent', '--verbose'],
    });
  });
});

describe('KNOWN_ACP_AGENTS', () => {
  it('defines built-in Gemini, OpenCode and Grok command mappings', () => {
    expect(KNOWN_ACP_AGENTS).toEqual({
      gemini: { command: 'gemini', args: ['--experimental-acp'] },
      opencode: { command: 'opencode', args: ['acp'] },
      grok: { command: 'grok', args: ['agent'], trailingArgs: ['stdio'] },
    });
  });
});

describe('resolveAcpAgentConfig', () => {
  it('resolves known agent names to predefined command + args', () => {
    expect(resolveAcpAgentConfig(['gemini'])).toEqual({
      agentName: 'gemini',
      command: 'gemini',
      args: ['--experimental-acp'],
    });
  });

  it('resolves grok to its ACP stdio subcommand', () => {
    expect(resolveAcpAgentConfig(['grok'])).toEqual({
      agentName: 'grok',
      command: 'grok',
      args: ['agent', 'stdio'],
    });
  });

  it('keeps trailing args last for agents that take flags before their subcommand', () => {
    expect(resolveAcpAgentConfig(['grok', '--reasoning-effort', 'high', '--always-approve'])).toEqual({
      agentName: 'grok',
      command: 'grok',
      args: ['agent', '--reasoning-effort', 'high', '--always-approve', 'stdio'],
    });
  });

  // `-m`, `--reasoning-effort` and `--always-approve` belong to `grok agent`,
  // not to its `stdio` leaf. Appending them after `stdio` makes the Grok CLI
  // exit with "unexpected argument" before the ACP handshake starts.
  it('places grok passthrough flags before the stdio subcommand', () => {
    expect(resolveAcpAgentConfig(['grok', '-m', 'grok-4.6'])).toEqual({
      agentName: 'grok',
      command: 'grok',
      args: ['agent', '-m', 'grok-4.6', 'stdio'],
    });
  });

  // The daemon appends `--dangerously-skip-permissions` to EVERY remote spawn
  // that has no explicit permission mode, matching how claude/codex skip every
  // approval prompt by default. Grok gets the same behavior via its own
  // `--always-approve` flag instead of happy's ACP approval prompt.
  it('maps daemon-injected --dangerously-skip-permissions to grok auto-approve', () => {
    expect(resolveAcpAgentConfig(['grok', '--dangerously-skip-permissions'])).toEqual({
      agentName: 'grok',
      command: 'grok',
      args: ['agent', '--always-approve', 'stdio'],
    });
  });

  it('maps --permission-mode yolo to grok auto-approve', () => {
    expect(resolveAcpAgentConfig(['grok', '--permission-mode', 'yolo'])).toEqual({
      agentName: 'grok',
      command: 'grok',
      args: ['agent', '--always-approve', 'stdio'],
    });
  });

  it('maps --permission-mode bypassPermissions to grok auto-approve', () => {
    expect(resolveAcpAgentConfig(['grok', '--permission-mode', 'bypassPermissions'])).toEqual({
      agentName: 'grok',
      command: 'grok',
      args: ['agent', '--always-approve', 'stdio'],
    });
  });

  it('does not auto-approve grok for non-bypass permission modes', () => {
    expect(resolveAcpAgentConfig(['grok', '--permission-mode', 'acceptEdits'])).toEqual({
      agentName: 'grok',
      command: 'grok',
      args: ['agent', 'stdio'],
    });
  });

  it('does not auto-approve other ACP agents on --dangerously-skip-permissions', () => {
    expect(resolveAcpAgentConfig(['gemini', '--dangerously-skip-permissions'])).toEqual({
      agentName: 'gemini',
      command: 'gemini',
      args: ['--experimental-acp'],
    });
  });

  it('still forwards an explicit grok auto-approve flag', () => {
    expect(resolveAcpAgentConfig(['grok', '--always-approve'])).toEqual({
      agentName: 'grok',
      command: 'grok',
      args: ['agent', '--always-approve', 'stdio'],
    });
  });

  it('strips happy-internal flags before forwarding to grok', () => {
    expect(resolveAcpAgentConfig(['grok', '--happy-starting-mode', 'remote', '-m', 'grok-4.6'])).toEqual({
      agentName: 'grok',
      command: 'grok',
      args: ['agent', '-m', 'grok-4.6', 'stdio'],
    });
  });

  it('appends extra CLI args for known agent aliases', () => {
    expect(resolveAcpAgentConfig(['opencode', '--foo'])).toEqual({
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp', '--foo'],
    });
  });

  it('strips legacy --acp for opencode compatibility', () => {
    expect(resolveAcpAgentConfig(['opencode', '--acp', '--foo'])).toEqual({
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp', '--foo'],
    });
  });

  it('resolves custom command form with -- separator', () => {
    expect(resolveAcpAgentConfig(['--', 'custom-agent', '--flag'])).toEqual({
      agentName: 'custom-agent',
      command: 'custom-agent',
      args: ['--flag'],
    });
  });

  it('treats unknown agent names as direct commands', () => {
    expect(resolveAcpAgentConfig(['my-agent', '--x'])).toEqual({
      agentName: 'my-agent',
      command: 'my-agent',
      args: ['--x'],
    });
  });

  it('throws with helpful usage when no args are provided', () => {
    expect(() => resolveAcpAgentConfig([])).toThrow('Usage: happy acp <agent-name> or happy acp -- <command> [args]');
  });

  it('throws when separator form omits command', () => {
    expect(() => resolveAcpAgentConfig(['--'])).toThrow('Missing command after "--". Usage: happy acp -- <command> [args]');
  });
});

describe('resolveAcpAgentConfig happy-internal flag stripping', () => {
  it('strips daemon-injected flags from opencode spawn (regression: yargs exit 1)', () => {
    expect(
      resolveAcpAgentConfig([
        'opencode',
        '--happy-starting-mode',
        'remote',
        '--dangerously-skip-permissions',
      ]),
    ).toEqual({
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });
  });

  it('preserves real user args while stripping happy flags for known agents', () => {
    expect(
      resolveAcpAgentConfig([
        'opencode',
        '--foo',
        '--happy-starting-mode',
        'remote',
        '--bar',
      ]),
    ).toEqual({
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp', '--foo', '--bar'],
    });
  });

  it('strips boolean --dangerously-* flags for gemini', () => {
    expect(resolveAcpAgentConfig(['gemini', '--dangerously-skip-permissions', '--x'])).toEqual({
      agentName: 'gemini',
      command: 'gemini',
      args: ['--experimental-acp', '--x'],
    });
  });

  it('strips value-bearing --permission-mode and its value', () => {
    expect(resolveAcpAgentConfig(['opencode', '--permission-mode', 'acceptEdits', '--z'])).toEqual({
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp', '--z'],
    });
  });

  it('does not consume the next token when a value flag is followed by another flag', () => {
    expect(
      resolveAcpAgentConfig(['opencode', '--happy-starting-mode', '--next-flag']),
    ).toEqual({
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp', '--next-flag'],
    });
  });

  it('strips happy flags for unknown agent names too', () => {
    expect(
      resolveAcpAgentConfig(['my-agent', '--happy-starting-mode', 'remote', '--foo']),
    ).toEqual({
      agentName: 'my-agent',
      command: 'my-agent',
      args: ['--foo'],
    });
  });

  it('preserves happy-prefixed args after explicit -- separator (user owns argv)', () => {
    expect(resolveAcpAgentConfig(['--', 'custom-agent', '--happy-x'])).toEqual({
      agentName: 'custom-agent',
      command: 'custom-agent',
      args: ['--happy-x'],
    });
  });
});
