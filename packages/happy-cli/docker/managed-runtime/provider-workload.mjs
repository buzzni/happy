/*
 * The provider generation's entry.
 *
 * It carries no policy of its own. Two things happen here and both are the
 * product's decisions, reached through the same read-only CommonJS bundle the
 * tool workload uses:
 *
 * 1. The exec line is checked against the plan the environment binds. An entry
 *    that ignored `argv` would let a generation script say one thing while the
 *    provider ran with another, and neither side would report it.
 *
 * 2. The run is handed to the Happy CLI, which is what reads the envelope from
 *    the inherited descriptor, attaches to the session the parent created, and
 *    enters the existing runner. Nothing about the envelope is parsed here —
 *    it holds a scoped bearer and the session's raw key, and this file is not
 *    where that is opened.
 *
 * The descriptor and every plan value reach the CLI exactly as the supervisor
 * left them: inherited fd and environment, never argv and never a file.
 */
// The CLI reads its own argv; the plan is bound through the environment and
// the inherited descriptor, so nothing is appended here. The exec line's own
// arguments are checked by the CLI's managed startup, which is the side that
// has already parsed the plan — see `assertProviderExecArguments`.
process.argv = [process.argv[0], '/usr/local/lib/saycode/cli/index.mjs', ...process.argv.slice(2)];
await import('/usr/local/lib/saycode/cli/index.mjs');
