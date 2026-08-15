export type AcpAgentConfig = {
  command: string;
  args: string[];
  /**
   * Args that must stay at the very end, after any user passthrough flags.
   *
   * Needed by CLIs whose ACP entry point is a leaf subcommand while the flags
   * that matter (model, effort, approval) belong to its parent — `grok agent
   * -m <model> stdio`. Appending the subcommand first would make those flags
   * land on the leaf, which rejects them.
   */
  trailingArgs?: string[];
  /**
   * Args that stand in for happy's own permission bypass.
   *
   * Happy strips `--dangerously-skip-permissions` from the agent argv, so an
   * agent with no mapping here keeps prompting even though the user asked to
   * bypass. Agents whose ACP `session/new` reports selectable modes get this
   * mid-session instead and need no mapping.
   */
  bypassPermissionsArgs?: string[];
};

/** Happy's own way of saying "skip tool approval" (`--yolo` desugars to this). */
const HAPPY_BYPASS_PERMISSION_FLAG = '--dangerously-skip-permissions';

export const KNOWN_ACP_AGENTS: Record<string, AcpAgentConfig> = {
  gemini: { command: 'gemini', args: ['--experimental-acp'] },
  opencode: { command: 'opencode', args: ['acp'] },
  // `grok agent stdio` speaks ACP protocolVersion 1 over JSON-RPC, which is the
  // version AcpBackend negotiates. The interactive TUI (plain `grok`) does not.
  // Grok's `session/new` returns no ACP modes, so permission bypass cannot be
  // negotiated mid-session and has to be a launch flag.
  grok: {
    command: 'grok',
    args: ['agent'],
    trailingArgs: ['stdio'],
    bypassPermissionsArgs: ['--always-approve'],
  },
};

export type ResolvedAcpAgentConfig = {
  agentName: string;
  command: string;
  args: string[];
};

/**
 * Happy-internal CLI flags that the daemon injects when spawning an ACP agent
 * (e.g. `--happy-starting-mode remote`, `--dangerously-skip-permissions`).
 * These belong to happy's own argv and must NOT be forwarded to the underlying
 * agent: yargs-based agents (opencode, gemini) treat unknown options as fatal
 * and exit 1 before the ACP handshake completes.
 */
const HAPPY_INTERNAL_FLAG_PREFIXES = ['--happy-', '--dangerously-'] as const;
const HAPPY_INTERNAL_VALUE_FLAGS = ['--happy-starting-mode', '--permission-mode'] as const;

function isHappyInternalFlag(arg: string): boolean {
  return (
    HAPPY_INTERNAL_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix)) ||
    (HAPPY_INTERNAL_VALUE_FLAGS as readonly string[]).includes(arg)
  );
}

/**
 * Strip happy-internal flags from an argv slice. Value-bearing flags
 * (`--happy-starting-mode <val>`, `--permission-mode <val>`) consume their
 * following token too, unless that token itself starts with `-` (i.e. it is
 * another flag, meaning the value was already missing).
 */
function filterHappyInternalFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (isHappyInternalFlag(arg)) {
      if (
        (HAPPY_INTERNAL_VALUE_FLAGS as readonly string[]).includes(arg) &&
        i + 1 < args.length &&
        !args[i + 1].startsWith('-')
      ) {
        i += 1;
      }
      continue;
    }
    out.push(arg);
  }
  return out;
}

export type ParsedAcpSubcommandArgs = {
  startedBy?: 'daemon' | 'terminal';
  verbose: boolean;
  /** Remaining argv to hand to `resolveAcpAgentConfig`. */
  acpArgs: string[];
};

/**
 * Split happy's own `acp` subcommand flags off the front of the argv.
 *
 * After a `--` separator the user owns the rest of the argv, so `--verbose`
 * and `--started-by` past that point belong to the underlying agent and are
 * forwarded verbatim.
 */
export function parseAcpSubcommandArgs(rest: string[]): ParsedAcpSubcommandArgs {
  let startedBy: 'daemon' | 'terminal' | undefined = undefined;
  let verbose = false;
  const acpArgs: string[] = [];
  let customCommandMode = false;
  for (let i = 0; i < rest.length; i++) {
    if (!customCommandMode && rest[i] === '--started-by') {
      startedBy = rest[++i] as 'daemon' | 'terminal';
      continue;
    }
    if (!customCommandMode && rest[i] === '--verbose') {
      verbose = true;
      continue;
    }
    if (rest[i] === '--') {
      customCommandMode = true;
    }
    acpArgs.push(rest[i]);
  }
  return { startedBy, verbose, acpArgs };
}

export function resolveAcpAgentConfig(cliArgs: string[]): ResolvedAcpAgentConfig {
  if (cliArgs.length === 0) {
    throw new Error('Usage: happy acp <agent-name> or happy acp -- <command> [args]');
  }

  if (cliArgs[0] === '--') {
    const command = cliArgs[1];
    if (!command) {
      throw new Error('Missing command after "--". Usage: happy acp -- <command> [args]');
    }
    // Explicit `--` separator form: user owns the full argv, do not filter.
    return {
      agentName: command,
      command,
      args: cliArgs.slice(2),
    };
  }

  const agentName = cliArgs[0];
  const known = KNOWN_ACP_AGENTS[agentName];
  if (known) {
    const rawArgs = cliArgs.slice(1);
    const passthroughArgs = filterHappyInternalFlags(
      rawArgs
        // Backward-compatible with old OpenCode docs/flags.
        .filter((arg) => !(agentName === 'opencode' && arg === '--acp')),
    );
    // Read the bypass intent off the raw argv: the filter above drops the flag.
    const bypassArgs = rawArgs.includes(HAPPY_BYPASS_PERMISSION_FLAG)
      ? known.bypassPermissionsArgs ?? []
      : [];
    return {
      agentName,
      command: known.command,
      args: [...known.args, ...passthroughArgs, ...bypassArgs, ...(known.trailingArgs ?? [])],
    };
  }

  return {
    agentName,
    command: agentName,
    args: filterHappyInternalFlags(cliArgs.slice(1)),
  };
}
