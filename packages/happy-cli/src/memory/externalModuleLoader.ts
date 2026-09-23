/**
 * Loads a module that is not part of this bundle.
 *
 * The target is whatever CML the user installed globally, resolved at runtime
 * from `npm root -g`. There is nothing for a bundler to trace, and
 * `await import(someVariable)` makes rollup try anyway and warn that it
 * "cannot be statically analyzed" — correctly. Silencing that with a
 * build-wide option would also silence it for imports that really are
 * traceable and really are mistakes.
 *
 * So this uses `createRequire`, which is the pattern this CLI already uses for
 * loading something outside its own bundle (`electronGuiPreload.ts`). It is
 * not a dynamic import, so there is no analysis to defeat and no warning to
 * suppress.
 *
 * Two alternatives were tried and rejected:
 *
 *  - `new Function('s', 'return import(s)')` hides the specifier but loses the
 *    module's loader context. Any host that evaluates this in a VM without a
 *    dynamic-import callback — vitest among them — fails with "A dynamic
 *    import callback was not specified".
 *  - Passing the specifier through an identity function does not help: the
 *    plugin warns on any non-literal argument, folded or not.
 *
 * `require` of an ES module is supported from Node 22, which is what this CLI
 * runs on. A build too old for it throws `ERR_REQUIRE_ESM`, and the caller
 * reports that as "not installed" — the same answer it gives for a package
 * that is genuinely absent.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireExternal = createRequire(import.meta.url);

/**
 * Imports a module by absolute `file://` URL.
 *
 * Throws like any load when the target is missing or fails to evaluate;
 * callers translate that into their own typed answer rather than surfacing the
 * error, which would quote the resolved path.
 */
export async function loadExternalEsModule(href: string): Promise<Record<string, unknown>> {
    // `require` takes a path, not a URL. Going through `fileURLToPath` is what
    // keeps a real install path containing a space or a `#` working.
    return requireExternal(fileURLToPath(href)) as Record<string, unknown>;
}
