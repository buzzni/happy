/**
 * Claude model ids the Studio catalog retired, as the model that replaced each one.
 *
 * A pin, spawn seed, message meta.model, routing floor or organization policy written before a
 * catalog swap still carries the old id. Every place that turns such a stored id into a model to run,
 * or compares it with a policy, reads it through here so the swap reaches them all at once.
 */
const RETIRED_CLAUDE_MODELS: ReadonlyMap<string, string> = new Map([
    ['claude-fable-5', 'claude-fable-5-2'],
    ['claude-fable-5-1', 'claude-fable-5-2'],
]);

/** The current id for a retired one, keeping a context-window suffix (`[1m]`); anything else unchanged. */
export function migrateRetiredClaudeModel(model: string): string {
    const match = /^(.*?)(\[[^\]]*\])?$/.exec(model);
    const id = match?.[1] ?? model;
    const successor = RETIRED_CLAUDE_MODELS.get(id.toLowerCase());
    return successor ? `${successor}${match?.[2] ?? ''}` : model;
}

/** A policy selection key (`<agent>:<model id>`) with a retired Claude id as its successor. */
export function migrateRetiredSelectionKey(key: string): string {
    return key.startsWith('claude:') ? `claude:${migrateRetiredClaudeModel(key.slice('claude:'.length))}` : key;
}
