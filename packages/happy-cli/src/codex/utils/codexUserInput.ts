import type { CodexAppServerClient } from '../codexAppServerClient';
import type { CodexPermissionHandler } from './permissionHandler';
import { randomUUID } from 'node:crypto';
import { createEnvelope } from '@slopus/happy-wire';
import type { ApiSessionClient } from '@/api/apiSession';

type Question = {
    answerKey: string;
    header: string;
    question: string;
    options: { label: string; description?: string }[];
};

function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function questionsFromRequest(value: unknown): Question[] | null {
    if (!record(value) || typeof value.turnId !== 'string' || !value.turnId.trim() || typeof value.itemId !== 'string' || !value.itemId
        || !Array.isArray(value.questions) || !value.questions.length) return null;
    const ids = new Set<string>();
    const questions: Question[] = [];
    for (const raw of value.questions) {
        if (!record(raw) || typeof raw.id !== 'string' || !raw.id.trim() || raw.id !== raw.id.trim() || ids.has(raw.id)
            || typeof raw.question !== 'string' || !raw.question.trim()
            || typeof raw.header !== 'string' || (raw.isSecret !== undefined && raw.isSecret !== false)) return null;
        ids.add(raw.id);
        const options: Question['options'] = [];
        if (raw.options != null) {
            if (!Array.isArray(raw.options)) return null;
            for (const option of raw.options) {
                if (!record(option) || typeof option.label !== 'string' || !option.label.trim()) return null;
                options.push({ label: option.label, ...(typeof option.description === 'string' ? { description: option.description } : {}) });
            }
        }
        questions.push({ answerKey: raw.id, header: raw.header, question: raw.question.trim(), options });
    }
    return questions;
}

/** Owns only the native-question ↔ existing Desktop permission DTO translation. */
export function installCodexUserInputBoundary(options: {
    client: CodexAppServerClient;
    permissionHandler: CodexPermissionHandler;
    session: Pick<ApiSessionClient, 'sendSessionProtocolMessage'>;
    protocolTurnId(nativeTurnId: string): string | undefined;
}): void {
    const { client, permissionHandler } = options;
    client.setUserInputHandler(async (params, signal) => {
        const questions = questionsFromRequest(params);
        if (!questions || signal.aborted) return { answers: {} };
        // JSON-RPC and item IDs can be reused after reconnect; a fresh permission ID cannot.
        const permissionId = `codex-user-input:${randomUUID()}`;
        const turn = options.protocolTurnId((params as Record<string, unknown>).turnId as string);
        options.session.sendSessionProtocolMessage(createEnvelope('agent', {
            t: 'tool-call-start', call: permissionId, name: 'request_user_input',
            title: 'request_user_input', description: 'request_user_input', args: { questions },
        }, { turn }));
        const cancel = () => permissionHandler.cancelRequest(permissionId);
        const pending = permissionHandler.handleToolCall(permissionId, 'request_user_input', { questions });
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        try {
            const result = await pending;
            if (result.decision !== 'approved' || signal.aborted) return { answers: {} };
            const values = result.updatedInput?.answers;
            if (!record(values)) return { answers: {} };
            const byId = questions.some(question => Object.hasOwn(values, question.answerKey));
            // Older Desktops key answers by text. Never guess when those texts collide.
            if (!byId && new Set(questions.map(question => question.question)).size !== questions.length) return { answers: {} };
            const entries: [string, { answers: string[] }][] = [];
            for (const question of questions) {
                const key = byId ? question.answerKey : question.question;
                const answer = Object.hasOwn(values, key) ? values[key] : undefined;
                if (typeof answer !== 'string' || !answer.trim()) return { answers: {} };
                // One answer is one string, even when a free-text answer contains commas.
                entries.push([question.answerKey, { answers: [answer] }]);
            }
            return { answers: Object.fromEntries(entries) };
        } catch {
            return { answers: {} };
        } finally {
            signal.removeEventListener('abort', cancel);
            options.session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'tool-call-end', call: permissionId }, { turn }));
        }
    });
}
