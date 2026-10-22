/**
 * Claude structured output for a spawned session (Saycode specs/claude-cli-benchmark-followups R2).
 *
 * A caller that needs a machine-readable answer spawns the session with an `outputFormat`. The
 * SDK applies it per `query()`, and this runner keeps one `query()` per session as streaming
 * input, so the format is **session-scoped**: every turn of that session is asked for, and judged
 * against, the same schema. Switching per turn would mean restarting the query each turn.
 *
 * This module owns the three edges of that contract:
 * - what the daemon admits (`parseOutputFormat`) — the closed shape, a size bound and a schema
 *   that compiles, so a bad schema is refused at spawn instead of failing every turn;
 * - how it reaches the session process (`outputFormatSeed` / `consumeOutputFormatSeed`), a
 *   one-shot `HAPPY_INITIAL_` seed like the model and effort seeds;
 * - what a turn's result means (`judgeStructuredOutput`). The verdict rests on the presence of a
 *   value that satisfies the schema, never on `subtype`: an unsatisfiable schema ends with
 *   `subtype: "success"` and no `structured_output` (Phase 0 probe).
 */
import Ajv from 'ajv';
import type { StructuredOutputMissingReason } from '@slopus/happy-wire';

/**
 * Upper bound on the serialized schema. It travels to the session as one environment value
 * (Windows caps a variable at 32,767 characters), and the SDK then passes it to the Claude CLI as
 * a `--json-schema` argument, where it shares Windows' 32,767-character command line with the
 * MCP config and system prompt. Half of the variable limit is a bound, not a guarantee: a schema
 * near it is untested on Windows.
 */
export const STRUCTURED_OUTPUT_MAX_SCHEMA_BYTES = 16 * 1024;

/**
 * Advertised in machine metadata so a client refuses an unsupported spawn up front.
 * `spawn-happy-session` destructures its parameters, so an older daemon would otherwise drop the
 * format silently and run the session without it.
 */
export const STRUCTURED_OUTPUT_CAPABILITY = {
    version: 1 as const,
    agents: ['claude'],
    maxSchemaBytes: STRUCTURED_OUTPUT_MAX_SCHEMA_BYTES,
};

export const OUTPUT_FORMAT_ENV = 'HAPPY_INITIAL_OUTPUT_FORMAT';

export type ClaudeOutputFormat = { type: 'json_schema'; schema: Record<string, unknown> };

export type StructuredOutputEnvelope =
    | { v: 1; status: 'ok'; value: unknown }
    | { v: 1; status: 'missing'; reason: StructuredOutputMissingReason };

type CompiledSchema = (value: unknown) => boolean;

/**
 * The same admission the bundled Claude CLI applies to `--json-schema` at startup: strict Ajv on
 * the draft-07 meta-schema. Probed against SDK 0.3.308: a 2020-12 `$schema`, an unknown keyword
 * and `$async` each make the CLI exit 1, which would fail every turn of the session, so they are
 * refused at spawn instead. The CLI accepts `format`; `validateFormats: false` accepts it too
 * without this side vouching for formats (the SDK validated the value already).
 * `logger: false` because a session process must not write to the terminal Claude runs in.
 */
function compileSchema(schema: Record<string, unknown>): CompiledSchema {
    if (schema.$async !== undefined) throw new Error('$async schemas are not supported');
    return new Ajv({ strict: true, validateFormats: false, allErrors: false, logger: false }).compile(schema);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Throws on anything the caller could believe was applied when it would not be. */
export function parseOutputFormat(value: unknown): ClaudeOutputFormat | undefined {
    if (value === undefined) return undefined;
    if (!isPlainObject(value)) throw new Error('Output format must be an object');
    if (value.type !== 'json_schema') throw new Error('Output format type must be json_schema');
    const schema = value.schema;
    if (!isPlainObject(schema)) throw new Error('Output format schema must be a JSON object');
    const bytes = Buffer.byteLength(JSON.stringify(schema), 'utf8');
    if (bytes > STRUCTURED_OUTPUT_MAX_SCHEMA_BYTES) {
        throw new Error(`Output format schema is ${bytes} bytes; the limit is ${STRUCTURED_OUTPUT_MAX_SCHEMA_BYTES}`);
    }
    try {
        compileSchema(schema);
    } catch (error) {
        throw new Error(`Output format schema is not a valid JSON Schema: ${(error as Error).message}`);
    }
    return { type: 'json_schema', schema };
}

export function outputFormatSeed(format: ClaudeOutputFormat): Record<string, string> {
    return { [OUTPUT_FORMAT_ENV]: JSON.stringify(format) };
}

/**
 * Read once and delete, like every `HAPPY_INITIAL_` seed, so the agent's own children never see
 * it. The daemon already validated it; a seed that no longer parses is read as "no format" rather
 * than crashing the session — the turns then report nothing, which a caller sees as missing.
 */
export function consumeOutputFormatSeed(env: NodeJS.ProcessEnv): ClaudeOutputFormat | null {
    const raw = env[OUTPUT_FORMAT_ENV];
    delete env[OUTPUT_FORMAT_ENV];
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
        return parseOutputFormat(JSON.parse(raw)) ?? null;
    } catch {
        return null;
    }
}

/** The SDK `result` fields the verdict reads. */
export interface StructuredOutputResult {
    subtype?: unknown;
    is_error?: unknown;
    structured_output?: unknown;
}

/**
 * Builds the per-turn verdict for one session's format. The schema is compiled once: every turn
 * of the session is judged against the same one.
 *
 * The SDK validates the value itself before ending the turn; checking it again here is what lets
 * the envelope say "validated" without trusting a field the runtime might fill differently after
 * an SDK update.
 */
export function judgeStructuredOutput(format: ClaudeOutputFormat): (result: StructuredOutputResult) => StructuredOutputEnvelope {
    const validate = compileSchema(format.schema);
    return (result) => {
        if (result.subtype === 'error_max_structured_output_retries') return { v: 1, status: 'missing', reason: 'retries_exhausted' };
        if (result.subtype !== 'success' || result.is_error === true) return { v: 1, status: 'missing', reason: 'turn_failed' };
        if (result.structured_output === undefined) return { v: 1, status: 'missing', reason: 'not_produced' };
        if (!validate(result.structured_output)) return { v: 1, status: 'missing', reason: 'schema_mismatch' };
        return { v: 1, status: 'ok', value: result.structured_output };
    };
}
