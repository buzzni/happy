import type { TranslationKey } from '@/text';
import { systemPrompt } from './prompt/systemPrompt';
import {
    resolveSaycodeAppendSystemPrompt,
    resolveSaycodePromptBlockEnabled,
    resolveSaycodeSystemPromptEnabled,
    type SaycodeSystemPromptSurface,
} from './settings';

/**
 * Every block id this app knows, as a literal union so a rename or typo at a use
 * site is a compile error rather than a silent fallback to the master value.
 */
export const MOBILE_SAYCODE_BLOCK_IDS = [
    'optionsGuidance',
    'agentOrchestration',
    'workerDelegation',
    'axBase',
    'coAuthoredCredit',
] as const;

export type MobileSaycodeBlockId = typeof MOBILE_SAYCODE_BLOCK_IDS[number];

export type MobileSaycodePromptBlock = {
    id: MobileSaycodeBlockId;
    /**
     * Which layer applies the block: `app-composed` is this app's own options/plan
     * guidance (gated locally, never sent on the wire — happy-cli does not know the
     * id); `cli-wire` blocks travel in message meta for happy-cli to gate.
     */
    layer: 'app-composed' | 'cli-wire';
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
};

/**
 * The toggleable Saycode-owned blocks, in display order. The chat title instruction
 * is deliberately absent — it is always-on, and listing it (even disabled) invites
 * the belief that it can be turned off. The settings screen states that separately.
 */
export const MOBILE_SAYCODE_PROMPT_BLOCKS: readonly MobileSaycodePromptBlock[] = [
    {
        id: 'optionsGuidance',
        layer: 'app-composed',
        titleKey: 'settingsFeatures.saycodeBlockOptionsGuidance',
        subtitleKey: 'settingsFeatures.saycodeBlockOptionsGuidanceSubtitle',
    },
    {
        id: 'agentOrchestration',
        layer: 'cli-wire',
        titleKey: 'settingsFeatures.saycodeBlockAgentOrchestration',
        subtitleKey: 'settingsFeatures.saycodeBlockAgentOrchestrationSubtitle',
    },
    {
        id: 'workerDelegation',
        layer: 'cli-wire',
        titleKey: 'settingsFeatures.saycodeBlockWorkerDelegation',
        subtitleKey: 'settingsFeatures.saycodeBlockWorkerDelegationSubtitle',
    },
    {
        id: 'axBase',
        layer: 'cli-wire',
        titleKey: 'settingsFeatures.saycodeBlockAxBase',
        subtitleKey: 'settingsFeatures.saycodeBlockAxBaseSubtitle',
    },
    {
        id: 'coAuthoredCredit',
        layer: 'cli-wire',
        titleKey: 'settingsFeatures.saycodeBlockCoAuthoredCredit',
        subtitleKey: 'settingsFeatures.saycodeBlockCoAuthoredCreditSubtitle',
    },
];

export type SaycodeTurnMeta = {
    saycodeSystemPromptEnabled: boolean;
    /** App-composed guidance is client-turn scoped; omission removes only its cached envelope. */
    appendSystemPrompt: string | undefined;
    /** CLI-wire overrides only; undefined when empty so the payload stays byte-identical for untouched accounts. */
    saycodePromptBlocks: Record<string, boolean> | undefined;
};

/**
 * Computes the saycode-related fields of one outgoing turn from the account
 * preference and per-block overrides. Ids this build does not know are dropped
 * rather than forwarded: happy-cli would silently ignore them while the settings
 * screen says nothing about it.
 */
export function buildSaycodeTurnMeta({
    preference,
    overrides,
    surface,
}: {
    preference: boolean | null;
    overrides: Record<string, boolean> | undefined;
    surface: SaycodeSystemPromptSurface;
}): SaycodeTurnMeta {
    const saycodeSystemPromptEnabled = resolveSaycodeSystemPromptEnabled({ preference, surface });
    const optionsGuidanceEnabled = resolveSaycodePromptBlockEnabled({
        blockId: 'optionsGuidance',
        overrides,
        preference,
        surface,
    });
    const cliWire: Record<string, boolean> = {};
    for (const block of MOBILE_SAYCODE_PROMPT_BLOCKS) {
        if (block.layer !== 'cli-wire') continue;
        const value = overrides?.[block.id];
        if (typeof value === 'boolean') {
            cliWire[block.id] = value;
            continue;
        }
        const enabled = resolveSaycodePromptBlockEnabled({
            blockId: block.id,
            overrides,
            preference,
            surface,
        });
        if (enabled !== saycodeSystemPromptEnabled) cliWire[block.id] = enabled;
    }
    const appendSystemPrompt = resolveSaycodeAppendSystemPrompt({
        enabled: optionsGuidanceEnabled,
        prompt: systemPrompt,
    });
    return {
        saycodeSystemPromptEnabled,
        appendSystemPrompt,
        saycodePromptBlocks: Object.keys(cliWire).length > 0 ? cliWire : undefined,
    };
}
