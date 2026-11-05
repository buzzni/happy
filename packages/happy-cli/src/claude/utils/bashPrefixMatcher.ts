/**
 * Matcher for a session-scoped `Bash(<prefix>:*)` grant.
 *
 * aplus-dev-studio-desktop specs/desktop-permission-prefix-grant R3 + R7. Before this the handler
 * used `command.startsWith(prefix)`, so `Bash(git add:*)` also allowed `git addx` and
 * `git add . && rm -rf ~`. A prefix now matches only a plain single command, at a word boundary.
 *
 * Fail-closed: every doubt (an escape, a substitution, a variable, an operator outside quotes, a
 * wrapper program) makes the command "not plain", and a command that is not plain never matches a
 * prefix — the handler then asks the person as it did before the grant existed. Nothing here
 * evaluates shell syntax; the shell grammar is not parsed, only refused when it is not trivial.
 *
 * The case table `bashPrefixMatcher.cases.v1.json` is shared with the Desktop spec folder; a change
 * to either copy has to change both.
 */

/** Same cap Desktop applies before it offers a grant (spec R3 `MAX_GRANT_COMMAND_LENGTH`). */
export const MAX_PLAIN_BASH_COMMAND_LENGTH = 4000;

/**
 * Live-session marker (`runtimeCapabilities.permissionGrants`): this Claude process applies the
 * matcher above. Desktop must require this session marker before offering a prefix grant. The same
 * value in machine metadata is only an availability hint: older sessions survive daemon upgrades.
 */
export const BASH_PREFIX_MATCHER_CAPABILITY = { bashPrefixMatcher: 'plain-v1' as const };

/**
 * Programs that run another command (spec R3, plus `!` and `coproc` which SayCode adds because they
 * need no separator). Their argument is the real command, which a prefix written for the wrapper
 * would silently cover, so a command that starts with one is never plain.
 * Compared by basename and case-insensitively; stripping the wrapper is deliberately not attempted.
 */
const WRAPPER_PROGRAMS: ReadonlySet<string> = new Set([
    'command', 'builtin', 'exec', 'eval', 'source', '.', 'time', 'timeout', 'nice', 'nohup',
    'xargs', 'env', 'sudo', 'doas',
    // Shell syntax that runs the rest of the line as a command without any separator (`! rm -x`).
    '!', 'coproc',
]);

const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** C0 controls (newline, return, tab, NUL), DEL, and the Unicode line/paragraph separators. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARACTER = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;

/** Never legal anywhere, quoted or not: an escape can hide a quote, `$` and a backtick expand inside `"`. */
const EXPANSION_OR_ESCAPE = /[\\$`]/;

/** Shell syntax outside quotes that chains, redirects, groups or backgrounds a command. */
const UNQUOTED_SYNTAX = /[&|;<>()]/;

/**
 * Splits the command into words the way a shell would for a command that has no escapes or
 * expansions, and reports the first one with its quotes removed. `null` when a quote is left open or
 * an operator appears outside quotes.
 */
function firstWordOfPlainCommand(command: string): string | null {
    let quote: '"' | "'" | null = null;
    let first = '';
    let inFirst = true;
    let wordStart = true;
    for (const ch of command) {
        if (quote) {
            if (ch === quote) {
                quote = null;
            } else if (inFirst) {
                first += ch;
            }
            wordStart = false;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            wordStart = false;
            continue;
        }
        if (UNQUOTED_SYNTAX.test(ch)) return null;
        if (ch === '#' && wordStart) return null;
        if (ch === ' ') {
            if (first !== '' || !wordStart) inFirst = false;
            wordStart = true;
            continue;
        }
        wordStart = false;
        if (inFirst) first += ch;
    }
    return quote === null ? first : null;
}

/** Spec R3: a one-line command with no operator, redirection, substitution, variable, escape or wrapper. */
export function isPlainBashCommand(command: string): boolean {
    if (typeof command !== 'string') return false;
    if (command.length === 0 || command.length > MAX_PLAIN_BASH_COMMAND_LENGTH) return false;
    if (command.trim() === '') return false;
    if (UNSAFE_CHARACTER.test(command) || EXPANSION_OR_ESCAPE.test(command)) return false;
    const program = firstWordOfPlainCommand(command);
    if (program === null || program === '') return false;
    if (ENVIRONMENT_ASSIGNMENT.test(program)) return false;
    const basename = program.slice(program.lastIndexOf('/') + 1).toLowerCase();
    return !WRAPPER_PROGRAMS.has(basename) && !WRAPPER_PROGRAMS.has(program.toLowerCase());
}

/**
 * Spec R7 (ii): the command equals the prefix or continues it after a space, and both are plain.
 * A prefix with an edge space, an open quote or an operator is refused too — it cannot have come from
 * a plain command, and an empty one would otherwise match every command that begins with a space.
 */
export function bashPrefixAllows(prefix: string, command: string): boolean {
    if (typeof prefix !== 'string' || typeof command !== 'string') return false;
    if (prefix !== prefix.trim() || !isPlainBashCommand(prefix)) return false;
    if (!isPlainBashCommand(command)) return false;
    return command === prefix || command.startsWith(`${prefix} `);
}
