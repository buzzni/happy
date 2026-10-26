/** One session's launch option; never a daemon-wide inherited preference. */
export const INPUT_EVIDENCE_ENV = 'HAPPY_INPUT_EVIDENCE';

export function requestedInputEvidenceEnvironment(env: Record<string, string>): Record<string, string> {
    if (!Object.hasOwn(env, INPUT_EVIDENCE_ENV)) return {};
    const value = env[INPUT_EVIDENCE_ENV];
    if (value !== '0' && value !== '1') throw new Error(`${INPUT_EVIDENCE_ENV} must be "0" or "1"`);
    return { [INPUT_EVIDENCE_ENV]: value };
}

/** Capture before startup awaits; later account/env changes cannot enable another session. */
export function consumeInputEvidenceOption(env: NodeJS.ProcessEnv): boolean | undefined {
    const value = env[INPUT_EVIDENCE_ENV];
    delete env[INPUT_EVIDENCE_ENV];
    return value === undefined ? undefined : value === '1';
}

export function resolveInputEvidenceOption(explicit: boolean | undefined, ownMetadata?: { inputEvidenceEnabled?: boolean }): boolean {
    return explicit ?? ownMetadata?.inputEvidenceEnabled === true;
}

/** Carry only the original conversation's setting into a replacement Happy session. */
export function resolveRecoveredInputEvidenceEnvironment(input: {
    savedEnvironment?: NodeJS.ProcessEnv;
    metadata?: { inputEvidenceEnabled?: boolean };
    requestedEnvironment?: Record<string, string>;
}): Record<string, string> {
    const saved = input.savedEnvironment?.[INPUT_EVIDENCE_ENV];
    const enabled = resolveInputEvidenceOption(saved === '0' || saved === '1' ? saved === '1' : undefined, input.metadata);
    return {
        [INPUT_EVIDENCE_ENV]: enabled ? '1' : '0',
        ...requestedInputEvidenceEnvironment(input.requestedEnvironment ?? {}),
    };
}

/** Only ON adds metadata; missing means OFF on recovery, preserving main's OFF document. */
export function inputEvidenceMetadata<T extends { inputEvidenceEnabled?: boolean }>(metadata: T, enabled: boolean): T {
    if (enabled) return { ...metadata, inputEvidenceEnabled: true };
    if (!Object.hasOwn(metadata, 'inputEvidenceEnabled')) return metadata;
    const { inputEvidenceEnabled: _setting, ...rest } = metadata;
    return rest as T;
}
