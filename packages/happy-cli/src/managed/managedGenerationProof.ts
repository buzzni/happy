/**
 * One provider generation's terminal proof, and the rule that keeps it its own.
 *
 * The launcher loops: each turn may start a new SDK process, and three facts
 * about that process arrive at three different times — the session it wrote
 * (`onSessionFound`, asynchronous), whether its input ran out rather than being
 * aborted, and how it exited. All three have to belong to the *same* generation.
 *
 * Every earlier version of this kept one or more of them in a launcher-level
 * variable, and each time the same failure came back: a straggling callback
 * from a generation that had finished wrote into the generation being proved
 * now. So a generation is a **record**, callbacks are bound to the record they
 * came from, and the record becomes current only when a real process is
 * watched — a turn that launches nothing has nothing to read and nothing that
 * can be written into it.
 *
 * Exported rather than left inline in the launcher so the ordering rule is
 * exercised on this object instead of on a re-statement of it beside it.
 */
import type { ProviderExitObserver } from './managedProviderExitObserver';

export type GenerationProof = {
    readonly observer: ProviderExitObserver;
    /** Its own iterator ran out. Only the child can see this. */
    inputExhausted: boolean;
    /** The native session **this** generation wrote, or none yet. */
    nativeId: string | null;
};

export type GenerationProofs = {
    /**
     * Opens a record for a turn. The returned record is what that turn's
     * callbacks must write to — never `current()`, which is whichever
     * generation happens to be current when a callback runs.
     */
    begin: (observe: (onStarted: () => void) => ProviderExitObserver | null) => GenerationProof | null;
    /** The generation being proved, or none started. */
    current: () => GenerationProof | null;
};

export function createGenerationProofs(): GenerationProofs {
    let currentProof: GenerationProof | null = null;
    return {
        begin: (observe) => {
            let record: GenerationProof | null = null;
            // Installed only on a real watch: that is when a generation begins,
            // and it is what makes a never-started turn inert.
            const observer = observe(() => { currentProof = record; });
            record = observer ? { observer, inputExhausted: false, nativeId: null } : null;
            return record;
        },
        current: () => currentProof,
    };
}
