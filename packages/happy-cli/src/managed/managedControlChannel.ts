/**
 * The one way anything outside a managed child can ask it to stop.
 *
 * A checkpoint needs the provider to end its input and exit cleanly, and only
 * the child can do that — `nextMessage()` returning `null` is the sole path
 * that reaches the SDK's `endInput`. But nothing outside the child could reach
 * it: `defaultSupervisorDeps.launch` fills `stdio` with `'ignore'`, so the
 * child's stdin is `/dev/null`, and the only other lever is `cgroup.kill`.
 *
 * ## Why a descriptor and not an RPC
 *
 * The write end is held only by the privileged supervisor that spawned the
 * child. Authority is the descriptor itself — there is no token to check, no
 * port to reach, and nothing a user-facing RPC could impersonate. It is the
 * same mechanism already trusted for the bootstrap envelope and the report
 * credential, which arrive on their own inherited descriptors.
 *
 * ## The protocol
 *
 * Newline-delimited verbs, from a closed set. One verb exists:
 *
 *     stop\n     end input after the work already accepted, then exit
 *
 * The child answers on the same descriptor:
 *
 *     ended exhausted-clean <id>\n  the iterator ran out AND the SDK's own
 *                                   process exited 0, unsignalled, unforced,
 *                                   and this is the native session it wrote
 *     ended <code> <id>\n           anything else, as a closed code
 *     ended <code>\n                the same, from a peer with no identity to
 *                                   give: an older child, or a generation that
 *                                   never learned one
 *
 * The identity travels **in the same frame as the verdict**, and is read out of
 * it in one step. Two frames would be two observations, and a reader would then
 * have to decide which generation the second one belonged to — the exact class
 * of mistake that produced a clean verdict for a generation that never ran.
 *
 * Node's extra `'pipe'` stdio slots are socketpairs, so one descriptor carries
 * both directions — measured, not assumed.
 *
 * The ack is **not** the proof on its own, and an earlier version of this file
 * argued it was therefore not worth having. That was wrong: the supervisor can
 * see the child leave and the cgroup empty, but neither of those distinguishes
 * an iterator that ran out from one that was aborted, and only the child knows
 * that. So the ack carries the half only the child can see, and the supervisor
 * still requires its own observations alongside it.
 *
 * An unknown verb is ignored rather than refused: this is a closed vocabulary
 * and a newer supervisor talking to an older child must not be able to make it
 * do something it does not understand. EOF is not a stop either — the
 * supervisor going away says nothing about whether this run should end.
 */

/** The descriptor the child finds its control channel on. */
export const MANAGED_CONTROL_CHILD_FD = 5;

/*
 * Deliberately no environment variable for this one.
 *
 * The bootstrap descriptor is named in the environment because
 * `options.bootstrapFd` is configurable; this slot is a constant on both
 * sides, so naming it would add a fourth `HAPPY_MANAGED_` variable that the
 * provider-env guards would then have to allow — widening a prefix that is
 * closed on purpose, for a value neither side chooses.
 */

/** The only verb. A closed set, so nothing is parsed out of free text. */
const STOP_VERB = 'stop';

/**
 * The longest line this channel can legally carry.
 *
 * `ended ` (6) + a 40-character code + a space + a 36-character identifier = 83.
 *
 * Measured on the **raw** line, before any tidying. Trimming first and measuring
 * after was a real defect: 129 bytes of padding in front of a valid frame
 * vanished into `trim()` and the frame was accepted, so a sender could put a
 * legal answer behind arbitrary padding and the length bound never saw it. The
 * length of a frame is a property of the bytes that were sent.
 */
const MAX_FRAME_LENGTH = 83;

/**
 * Refuses a launch whose descriptors would collide.
 *
 * `bootstrapFd` is configurable, so the slots cannot simply be assumed
 * distinct. Two documents landing on one descriptor means the child reads one
 * of them as the other — and the failure would appear far away, as an
 * unparseable envelope or a control channel that never speaks.
 */
export function assertDistinctManagedFds(slots: {
    bootstrap: number;
    report: number;
    control: number;
    status: number;
    release: number;
}): void {
    const seen = new Map<number, string>();
    for (const [name, fd] of Object.entries(slots)) {
        if (!Number.isInteger(fd) || fd < 3) {
            // 0, 1 and 2 belong to the child's own stdio, whatever it does
            // with them.
            throw new Error(`managed launch requires ${name} above the standard descriptors`);
        }
        const taken = seen.get(fd);
        if (taken !== undefined) {
            // The names, never the numbers-as-content: which two axes clashed
            // is the actionable part.
            throw new Error(`managed launch cannot put ${name} and ${taken} on one descriptor`);
        }
        seen.set(fd, name);
    }
}

/**
 * Reads the control channel and calls `onStop` when the supervisor asks.
 *
 * Returns a function that stops reading — used when the run is ending for its
 * own reasons and nothing should act on a late verb.
 */
export function readManagedControlChannel(input: {
    /** Emits the channel's bytes. A `node:fs` read stream over the descriptor. */
    source: {
        on(event: 'data', handler: (chunk: Buffer | string) => void): unknown;
        on(event: 'error', handler: (error: Error) => void): unknown;
        destroy?: () => void;
    };
    onStop: () => void;
    /**
     * A child's answer, when this end is the supervisor's.
     *
     * Delivered once per validated frame. A generation ends once, so what the
     * reader does with a second frame is the reader's decision — see
     * `managedProviderRun`, which keeps the first and refuses to let a later
     * one rewrite it.
     */
    onAck?: (ack: ManagedStopAck) => void;
    /**
     * The channel turned out to be unusable.
     *
     * A descriptor the runtime never opened fails **asynchronously** — the
     * stream constructs fine and then emits `error` on its first read. Without
     * a listener that is an unhandled `error` event, which takes the whole
     * child down. So this is not optional politeness: it is the difference
     * between "this run cannot be stopped gracefully" and "this run died".
     */
    onUnusable?: () => void;
}): () => void {
    let buffered = '';
    let stopped = false;
    /*
     * Set when a frame grew past any legal length. Everything up to the next
     * newline is still **inside** that frame, so none of it may be read as one.
     */
    let discardingUntilNewline = false;
    input.source.on('error', () => {
        if (stopped) return;
        stopped = true;
        /*
         * Never a stop. A channel that failed said nothing, and reading
         * failure as a request to end input would fabricate an EOF nobody
         * asked for — on every runtime that did not open the descriptor.
         */
        input.onUnusable?.();
    });
    input.source.on('data', (chunk) => {
        if (stopped) return;
        buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (discardingUntilNewline) {
            const end = buffered.indexOf('\n');
            // Still inside the overlong frame. Nothing here is a frame.
            if (end === -1) { buffered = ''; return; }
            discardingUntilNewline = false;
            buffered = buffered.slice(end + 1);
        }
        /*
         * A verb is only a verb once its newline arrived. Acting on a partial
         * read would let a chunk boundary inside `stop` go unnoticed, and a
         * later chunk complete a word nobody sent.
         */
        let newline = buffered.indexOf('\n');
        while (newline !== -1) {
            const raw = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            /*
             * Only a trailing carriage return is tidied away **here**, before
             * the length bound: with spaces stripped first, any amount of
             * padding could carry a frame the bound then measures as short —
             * which is exactly how a 129-byte padded frame was accepted.
             *
             * `parseManagedStopAck` still trims its own input. That is not a
             * second chance at the bound: it only ever sees a line that already
             * passed it, so what it can trim is bounded too. It keeps the trim
             * because it is exported and read directly, and a caller holding a
             * line with a stray carriage return should get the same answer this
             * reader would give.
             */
            const verb = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
            // Over the bound is not a frame — not a verb, not an answer, and
            // not a reason to stop reading: the next line is judged on its own.
            if (verb.length > MAX_FRAME_LENGTH) {
                newline = buffered.indexOf('\n');
                continue;
            }
            // Ignored, not refused: an older child must not be made to act on
            // a verb it does not have.
            if (verb === STOP_VERB) {
                input.onStop();
            } else if (input.onAck) {
                const ack = parseManagedStopAck(verb);
                if (ack !== null) input.onAck(ack);
            }
            newline = buffered.indexOf('\n');
        }
        /*
         * A sender that never sends a newline must not be able to grow this
         * without limit. The longest legal frame is `ended ` + a 40-character
         * code + a space + a 36-character id = 83; 128 leaves room to see a
         * whole overlong frame.
         *
         * Dropping the buffer here is **not** enough, and that was a real
         * defect: with no newline seen, the bytes that follow are still part of
         * the frame that overflowed, so a sender could pad past the cap and have
         * whatever it put after the padding accepted as a frame of its own. So
         * the rest of this frame is discarded up to the newline that ends it,
         * and only what comes after that may be read.
         */
        if (buffered.length > 128) {
            buffered = '';
            discardingUntilNewline = true;
        }
    });
    return () => {
        stopped = true;
        input.source.destroy?.();
    };
}

/** The bytes a supervisor writes to ask for a graceful stop. */
export function managedStopRequest(): string {
    return `${STOP_VERB}\n`;
}

/** The one verdict that means this run ended its own input and flushed. */
export const MANAGED_STOP_CLEAN = 'exhausted-clean';

/**
 * The native session identifier's grammar.
 *
 * The same shape, **including the case-insensitivity**, already checked at
 * `claude/utils/claudeSessionTransfer.ts:12` and `api/apiMachine.ts:133` — not
 * imported from either, because this channel is provider-agnostic and must not
 * take a dependency on a Claude util to read a Codex frame.
 *
 * An earlier version of this narrowed it to lower case on the theory that the
 * writer is this codebase. It is not: the id comes from the provider's SDK, and
 * the narrowing made a legitimate upper-case session vanish out of the frame
 * silently — a run that reported clean and named nothing, which is worse than
 * one that refused. Two spellings of one id are one id, and that belongs at the
 * comparison, not in the grammar.
 *
 * The spelling itself is never folded. This value reaches a path, and
 * normalising an identifier on its way to a filesystem is how you end up
 * looking for a file that is not there.
 */
const NATIVE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a child said about how it ended, and which session it was. */
export type ManagedStopAck = {
    verdict: string;
    /** `null` when the peer gave none — an old child, or no session yet. */
    nativeId: string | null;
};

/**
 * The bytes a child writes back once it has stopped, or failed to.
 *
 * An identity that does not match the grammar is **dropped**, not sent as-is
 * and not turned into a verdict of its own: this crosses a trust boundary and
 * is logged, and `unknown` already covers a verdict nobody recognises. A frame
 * without an id is a legal frame, so dropping it degrades to exactly the
 * behaviour of the peer that predates this field.
 */
export function managedStopAck(verdict: string, nativeId?: string | null): string {
    // A code, never a sentence: this crosses a trust boundary and is logged.
    const safe = /^[a-z-]{1,40}$/.test(verdict) ? verdict : 'unknown';
    const id = typeof nativeId === 'string' && NATIVE_ID_RE.test(nativeId) ? ` ${nativeId}` : '';
    return `ended ${safe}${id}\n`;
}

/**
 * Reads a child's answer out of one line, or `null` if it is not one.
 *
 * `null` is "the child did not say", which is never the same as a verdict —
 * folding the two would let a silent child look like a clean one. A frame whose
 * identity is malformed is **not** a frame: it is refused whole rather than
 * accepted with the id dropped, because a verdict and an identity that arrived
 * together were meant to be believed together.
 */
export function parseManagedStopAck(line: string): ManagedStopAck | null {
    const match = /^ended ([a-z-]{1,40})( [0-9a-fA-F-]{1,64})?$/.exec(line.trim());
    if (!match) return null;
    const raw = match[2]?.slice(1);
    if (raw !== undefined && !NATIVE_ID_RE.test(raw)) return null;
    return { verdict: match[1]!, nativeId: raw ?? null };
}
