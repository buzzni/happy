import * as z from 'zod';

/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary 4b-3 preview stage 2 — a preview's merged
 * env, sealed by the server for one strict machine.
 *
 * The server sends no command to a strict machine, and the browser should not see the merged
 * secrets in plaintext. So the server seals the env and the browser forwards it with the spawn
 * request it sends on the customer lane (`spawn-with-sealed-env`). The daemon opens it and hands
 * the env to the process it starts.
 *
 * The server picks the env, and an env can run code: `NODE_OPTIONS=--require …`, `LD_PRELOAD`,
 * `BASH_ENV`, `PATH`. The daemon refuses the whole payload when any name is one a runtime, shell
 * or package manager executes or loads from, so the server can only set the values of ordinary
 * application variables.
 *
 * Seal: AES-256-GCM `[nonce12|ciphertext|tag16]` with
 * `HMAC-SHA256(serverLaneKey, SEALED_SPAWN_ENV_KEY_LABEL)`, a key of its own so a sealed env is
 * never read as a server-lane request. Plaintext: `{ v: 1, purpose: 'spawn-env', machineId,
 * projectId, issuedAt, nonce, env }`.
 */
export const SEALED_SPAWN_ENV_VERSION = 1;
export const SEALED_SPAWN_ENV_KEY_LABEL = 'happy sealed spawn env v1';
/** How far a payload's issue time may be from the daemon's clock, either way. */
export const SEALED_SPAWN_ENV_WINDOW_MS = 5 * 60_000;
/** The variable that names the env file of an `envDelivery: 'file'` spawn. */
export const SEALED_SPAWN_ENV_FILE_VARIABLE = 'APLUS_SEALED_ENV_FILE';

export const sealedSpawnEnvCapabilitySchema = z.object({ version: z.literal(SEALED_SPAWN_ENV_VERSION) });
export type SealedSpawnEnvCapability = z.infer<typeof sealedSpawnEnvCapabilitySchema>;
export const SEALED_SPAWN_ENV_CAPABILITY: SealedSpawnEnvCapability = { version: SEALED_SPAWN_ENV_VERSION };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

// Upper case: Windows reads env names without case.
const RESERVED_NAMES = new Set([
  'PATH', 'HOME', 'SHELL', 'ENV', 'BASH_ENV', 'IFS', 'PS4', 'PROMPT_COMMAND', 'CDPATH', 'GLOBIGNORE',
  'PYTHONSTARTUP', 'PYTHONPATH', 'PYTHONHOME', 'PERL5OPT', 'PERL5LIB', 'PERLLIB', 'RUBYOPT', 'RUBYLIB',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'COMSPEC', 'PATHEXT', 'PSMODULEPATH', 'SYSTEMROOT', 'WINDIR',
]);
const RESERVED_PREFIXES = [
  'NODE_', 'LD_', 'DYLD_', 'HAPPY_', 'SAYCODE_', 'SCRIPT_', 'APLUS_',
  'NPM_CONFIG_', 'YARN_', 'PNPM_', 'BUN_', 'DENO_', 'COREPACK_', 'PIP_', 'UV_', 'CARGO_', 'RUSTUP_',
  'GIT_', 'DOCKER_', 'BUILDKIT_', 'COMPOSE_',
];

/** The names in `names` a sealed env may not set, in the order given. */
export function rejectedSealedSpawnEnvNames(names: readonly string[]): string[] {
  return names.filter((name) => {
    if (!ENV_NAME.test(name)) return true;
    const upper = name.toUpperCase();
    return RESERVED_NAMES.has(upper) || RESERVED_PREFIXES.some((prefix) => upper.startsWith(prefix));
  });
}

const payloadSchema = z.object({
  v: z.literal(SEALED_SPAWN_ENV_VERSION),
  purpose: z.literal('spawn-env'),
  machineId: z.string().min(1).max(256),
  projectId: z.string().min(1).max(256),
  issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nonce: z.string().regex(/^[A-Za-z0-9+/]{22}==$/),
  env: z.record(z.string(), z.string()),
}).strict();

export type SealedSpawnEnvPayload = z.infer<typeof payloadSchema>;

export type SealedSpawnEnvRead =
  | { ok: true; nonce: string; env: Record<string, string> }
  | { ok: false; code: 'SEALED_ENV_MALFORMED' | 'SEALED_ENV_MACHINE_MISMATCH' | 'SEALED_ENV_STALE' }
  | { ok: false; code: 'SEALED_ENV_RESERVED_NAME'; names: string[] };

/** Checks an opened payload against the daemon's machine and clock. Replay is the caller's. */
export function readSealedSpawnEnvPayload(value: unknown, expected: { machineId: string; now: number }): SealedSpawnEnvRead {
  const parsed = payloadSchema.safeParse(value);
  if (!parsed.success) return { ok: false, code: 'SEALED_ENV_MALFORMED' };
  const payload = parsed.data;
  if (payload.machineId !== expected.machineId) return { ok: false, code: 'SEALED_ENV_MACHINE_MISMATCH' };
  if (Math.abs(expected.now - payload.issuedAt) > SEALED_SPAWN_ENV_WINDOW_MS) return { ok: false, code: 'SEALED_ENV_STALE' };
  const names = rejectedSealedSpawnEnvNames(Object.keys(payload.env));
  if (names.length > 0) return { ok: false, code: 'SEALED_ENV_RESERVED_NAME', names };
  return { ok: true, nonce: payload.nonce, env: payload.env };
}
