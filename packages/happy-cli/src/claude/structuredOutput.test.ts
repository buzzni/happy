import { describe, expect, it } from 'vitest';

import {
    consumeOutputFormatSeed,
    judgeStructuredOutput,
    OUTPUT_FORMAT_ENV,
    outputFormatSeed,
    parseOutputFormat,
    STRUCTURED_OUTPUT_MAX_SCHEMA_BYTES,
} from './structuredOutput';

const schema = {
    type: 'object',
    properties: { answer: { type: 'string' }, n: { type: 'integer' } },
    required: ['answer', 'n'],
    additionalProperties: false,
};

describe('parseOutputFormat', () => {
    it('leaves an absent format absent so an ordinary spawn keeps its shape', () => {
        expect(parseOutputFormat(undefined)).toBeUndefined();
    });

    it('accepts a json_schema format with an object schema', () => {
        expect(parseOutputFormat({ type: 'json_schema', schema })).toEqual({ type: 'json_schema', schema });
    });

    it('accepts a 2020-12 schema the default meta-schema does not know', () => {
        const modern = { $schema: 'https://json-schema.org/draft/2020-12/schema', ...schema };
        expect(parseOutputFormat({ type: 'json_schema', schema: modern })?.schema).toEqual(modern);
    });

    it('refuses anything a caller could believe was applied when it was not', () => {
        expect(() => parseOutputFormat(null)).toThrow();
        expect(() => parseOutputFormat({ type: 'text', schema })).toThrow(/json_schema/);
        expect(() => parseOutputFormat({ type: 'json_schema' })).toThrow(/schema/);
        expect(() => parseOutputFormat({ type: 'json_schema', schema: [schema] })).toThrow(/schema/);
        expect(() => parseOutputFormat({ type: 'json_schema', schema: { type: 'objectt' } })).toThrow(/not a valid JSON Schema/);
    });

    it('refuses a schema too large to travel as a spawn seed', () => {
        const big = { type: 'object', description: 'x'.repeat(STRUCTURED_OUTPUT_MAX_SCHEMA_BYTES) };
        expect(() => parseOutputFormat({ type: 'json_schema', schema: big })).toThrow(/bytes/);
    });

    it('drops fields outside the closed shape rather than forwarding them to the SDK', () => {
        expect(parseOutputFormat({ type: 'json_schema', schema, extra: 1 })).toEqual({ type: 'json_schema', schema });
    });
});

describe('output format spawn seed', () => {
    it('reaches the session process once and is gone afterwards', () => {
        const env: NodeJS.ProcessEnv = { ...outputFormatSeed({ type: 'json_schema', schema }) };
        expect(consumeOutputFormatSeed(env)).toEqual({ type: 'json_schema', schema });
        expect(env[OUTPUT_FORMAT_ENV]).toBeUndefined();
        expect(consumeOutputFormatSeed(env)).toBeNull();
    });

    it('reads a malformed seed as no format instead of crashing the session', () => {
        const env: NodeJS.ProcessEnv = { [OUTPUT_FORMAT_ENV]: '{not json' };
        expect(consumeOutputFormatSeed(env)).toBeNull();
        expect(env[OUTPUT_FORMAT_ENV]).toBeUndefined();
    });
});

describe('judgeStructuredOutput', () => {
    const judge = judgeStructuredOutput({ type: 'json_schema', schema });

    it('passes a value that satisfies the schema', () => {
        expect(judge({ subtype: 'success', is_error: false, structured_output: { answer: 'ok', n: 2 } }))
            .toEqual({ v: 1, status: 'ok', value: { answer: 'ok', n: 2 } });
    });

    it('treats success without structured_output as missing — the shape an unsatisfiable schema ends in', () => {
        // Phase 0 probe: minimum 5 / maximum 3 ended `success`, `is_error: false`, no structured_output.
        expect(judge({ subtype: 'success', is_error: false }))
            .toEqual({ v: 1, status: 'missing', reason: 'not_produced' });
    });

    it('does not vouch for a value the schema rejects', () => {
        expect(judge({ subtype: 'success', is_error: false, structured_output: { answer: 'ok', n: 'two' } }))
            .toEqual({ v: 1, status: 'missing', reason: 'schema_mismatch' });
    });

    it('names exhausted retries apart from other failures', () => {
        expect(judge({ subtype: 'error_max_structured_output_retries', is_error: true }))
            .toEqual({ v: 1, status: 'missing', reason: 'retries_exhausted' });
        expect(judge({ subtype: 'error_during_execution', is_error: true }))
            .toEqual({ v: 1, status: 'missing', reason: 'turn_failed' });
        expect(judge({ subtype: 'success', is_error: true, structured_output: { answer: 'ok', n: 2 } }))
            .toEqual({ v: 1, status: 'missing', reason: 'turn_failed' });
    });
});
