/**
 * The two copies of the `aiAuth` wire, compared.
 *
 * There is no shared package across the submodule boundary, so
 * `packages/web-ui/server/cloudAiAuth.ts` and `src/managed/managedAiAuth.ts`
 * carry the same constants twice. A drift between them is silent in both
 * codebases and shows up only as a runtime that refuses a login the Studio
 * thinks it sent — so it is compared as text here rather than trusted to
 * review.
 *
 * The Studio file is read, not imported: it is outside this package's module
 * graph and importing it would pull the Studio's own dependencies into this
 * build. When it is not there — the submodule checked out on its own — there
 * is nothing to compare and the check says so rather than passing quietly.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    MANAGED_AI_AUTH_ACTIONS,
    MANAGED_AI_AUTH_CONNECTION_ID_PATTERN,
    MANAGED_AI_AUTH_HOME_ROOT,
    MANAGED_AI_AUTH_KINDS,
    MANAGED_AI_AUTH_RPC_METHOD,
    MANAGED_AI_AUTH_TOKEN_OP,
} from '@/managed/managedAiAuth';

/**
 * `src/managed` → the Studio repository that vendors this submodule.
 *
 * Six levels: `managed` → `src` → `happy-cli` → `packages` → `happy` →
 * `vendor` → the Studio root.
 */
const STUDIO_COPY = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', '..', '..', '..',
    'packages', 'web-ui', 'server', 'cloudAiAuth.ts',
);

describe('the ai-auth wire, on both sides of the submodule boundary', () => {
    const present = existsSync(STUDIO_COPY);

    it.skipIf(!present)('agrees on every constant the parent and the runtime both name', () => {
        const studio = readFileSync(STUDIO_COPY, 'utf8');

        /** One `export const NAME = <value>` from the Studio copy. */
        const declared = (name: string): string => {
            const match = studio.match(
                new RegExp(`^export const ${name}(?::[^=]+)? = (.+)$`, 'm'),
            );
            expect(match, `${name} is not declared in the Studio copy`).not.toBeNull();
            return match![1].replace(/ as const$/, '').trim();
        };

        expect(declared('CLOUD_AI_AUTH_HOME_ROOT')).toBe(`'${MANAGED_AI_AUTH_HOME_ROOT}'`);
        expect(declared('MANAGED_AI_AUTH_RPC_METHOD')).toBe(`'${MANAGED_AI_AUTH_RPC_METHOD}'`);
        expect(declared('MANAGED_AI_AUTH_TOKEN_OP')).toBe(`'${MANAGED_AI_AUTH_TOKEN_OP}'`);
        expect(declared('CLOUD_AI_AUTH_CONNECTION_ID_PATTERN'))
            .toBe(MANAGED_AI_AUTH_CONNECTION_ID_PATTERN.toString());
        // Arrays are compared as their members, so a reordering is not a
        // failure but a missing or extra kind is.
        const members = (declaration: string): string[] =>
            [...declaration.matchAll(/'([^']+)'/g)].map((entry) => entry[1]).sort();
        expect(members(declared('MANAGED_AI_AUTH_ACTIONS'))).toEqual([...MANAGED_AI_AUTH_ACTIONS].sort());
        expect(members(declared('CLOUD_AI_AUTH_KINDS'))).toEqual([...MANAGED_AI_AUTH_KINDS].sort());
    });

    it('says plainly when the Studio copy is not checked out beside this one', () => {
        // Not an assertion about the wire — a statement that the comparison
        // above either ran or could not. A skipped check that looks like a
        // passing one is how two copies drift.
        if (!present) expect(existsSync(STUDIO_COPY)).toBe(false);
        else expect(readFileSync(STUDIO_COPY, 'utf8').length).toBeGreaterThan(0);
    });
});
