/**
 * The three `HAPPY_MANAGED_` variables the runtime itself binds on a provider.
 *
 * Named once because **two** guards need exactly this set and they are not the
 * same guard: `assertProviderEnv` (claude) and `buildCodexToolPolicy` (codex)
 * each keep their own forbidden list, and each closed the whole `HAPPY_MANAGED_`
 * prefix. That prefix must stay closed — it is how a managed child is told what
 * it is, so an open prefix is a way to tell it something else — but the runtime
 * binds three of them itself, and refusing those refused every managed launch
 * for both agents before a byte was written.
 *
 * They are metadata, not material: a flag and two **descriptor numbers**. The
 * documents behind those descriptors never travel in the environment.
 *
 * Literals rather than imports. `managedSpawnBootstrap` belongs to the image's
 * runtime-entry bundle and `managedReportCredential` to the daemon's; importing
 * either here would put a module in two bundle graphs, and the bundler answers
 * that with a sibling chunk the image does not install. The agreement is
 * asserted in `managedProviderEnvComposition.test.ts` instead.
 */
export const TRUSTED_RUNTIME_BOOTSTRAP_ENV: ReadonlySet<string> = new Set([
    'HAPPY_MANAGED_REQUIRE_PROMPT_ACK',
    'HAPPY_MANAGED_BOOTSTRAP_FD',
    'HAPPY_MANAGED_REPORT_FD',
]);
