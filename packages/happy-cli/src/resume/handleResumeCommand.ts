import { existsSync } from 'node:fs';

import type { Metadata } from '@/api/types';
import { readPersistedSessions } from '@/persistence';
import { INPUT_EVIDENCE_ENV, resolveRecoveredInputEvidenceEnvironment } from '@/utils/inputEvidenceSettings';
import { sanitizeChildEnv } from '@/utils/childEnv';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';

import { resolveHappySession, type ResumableHappySession } from './resolveHappySession';

export type ResumeLaunch = {
    cwd: string;
    args: string[];
};

export type ResumeLaunchOptions = {
    claudeStartingMode?: 'local' | 'remote';
    startedBy?: 'daemon' | 'terminal';
    /** Fresh authenticated server head and the prior child's processed cursor. */
    emptyCodexSession?: { serverSeq?: number; processedSeq: number };
    /** Daemon-only durable machine execution proof: no provider start was ever submitted. */
    emptyMachineClaudeSession?: { sessionId: string; serverSeq?: number; processedSeq: number; startNeverSubmitted: true };
};

export function parseResumeCommandArgs(args: string[]): { showHelp: boolean; sessionId: string; inputEvidence?: '0' | '1' } {
    if (args.includes('-h') || args.includes('--help')) {
        return {
            showHelp: true,
            sessionId: '',
        };
    }

    if (args.length === 0) {
        throw new Error('Happy session ID is required: happy resume <session-id>');
    }
    let inputEvidence: '0' | '1' | undefined;
    if (args[1] === '--input-evidence' && args.length <= 3) {
        const value = args[2];
        if (value !== '0' && value !== '1') throw new Error('--input-evidence must be "0" or "1"');
        inputEvidence = value;
    } else if (args.length > 1) {
        throw new Error(`Unexpected arguments for happy resume: ${args.slice(1).join(' ')}`);
    }

    return {
        showHelp: false,
        sessionId: args[0],
        ...(inputEvidence !== undefined ? { inputEvidence } : {}),
    };
}

function resolveFlavor(metadata: Metadata): 'codex' | 'claude' | null {
    if (metadata.flavor === 'codex' || metadata.codexThreadId) {
        return 'codex';
    }
    if (metadata.flavor === 'claude' || metadata.claudeSessionId) {
        return 'claude';
    }
    return null;
}

export function buildResumeLaunch(session: ResumableHappySession, options: ResumeLaunchOptions = {}): ResumeLaunch {
    const { metadata } = session;
    const flavor = resolveFlavor(metadata);

    if (flavor === 'codex') {
        const unused = options.startedBy === 'daemon'
            && options.emptyCodexSession?.serverSeq === 0
            && options.emptyCodexSession.processedSeq === 0;
        if (!metadata.codexThreadId && !unused) {
            throw new Error(`Happy session ${session.id} has no Codex thread to resume (Codex never started a thread in it, or its context was reset). Start a new conversation.`);
        }
        const args = metadata.codexThreadId ? ['codex', '--resume', metadata.codexThreadId] : ['codex'];
        if (options.startedBy) {
            args.push('--started-by', options.startedBy);
        }
        return {
            cwd: metadata.path,
            args,
        };
    }

    if (flavor === 'claude') {
        const fresh = options.emptyMachineClaudeSession;
        const unused = options.startedBy === 'daemon' && fresh?.startNeverSubmitted === true && fresh.sessionId === session.id
            && Number.isSafeInteger(fresh.serverSeq) && (fresh.serverSeq ?? -1) >= 0 && fresh.processedSeq === 0;
        if (!metadata.claudeSessionId && !unused) {
            throw new Error(`Happy session ${session.id} is missing its Claude session ID.`);
        }
        const args = ['claude'];
        if (options.claudeStartingMode) {
            args.push('--happy-starting-mode', options.claudeStartingMode);
        }
        if (options.startedBy) {
            args.push('--started-by', options.startedBy);
        }
        if (metadata.claudeSessionId) args.push('--resume', metadata.claudeSessionId);
        return {
            cwd: metadata.path,
            args,
        };
    }

    throw new Error(`Happy session ${session.id} uses unsupported flavor "${metadata.flavor ?? 'unknown'}".`);
}

export function formatResumeHelp(): string {
    return [
        'happy resume - Resume a previous Happy session',
        '',
        'Usage:',
        '  happy resume <happy-session-id> [--input-evidence 0|1]',
        '',
        'Examples:',
        '  happy resume cmmij8olq00dp5jcxr3wtbpau',
        '  happy resume cmmij8',
        '',
        'This reuses the saved worktree/path and resumes the underlying agent session',
        'when the backend supports it.',
        'Input evidence keeps the original session setting; --input-evidence overrides it.',
        "The caller's HAPPY_INPUT_EVIDENCE is ignored.",
    ].join('\n');
}

function spawnResumeChild(launch: ResumeLaunch, evidenceEnvironment: Record<string, string>): Promise<number | null> {
    return new Promise((resolve, reject) => {
        const child = spawnHappyCLI(launch.args, {
            cwd: launch.cwd,
            // The resumed runner hosts another session: it must not start with the
            // caller's agent grant, checkpoint binding or connector grant (an agent
            // shell running `happy resume <id>`).
            env: { ...sanitizeChildEnv(process.env), ...evidenceEnvironment },
            stdio: 'inherit',
        });

        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (signal) {
                reject(new Error(`Resumed session exited via signal ${signal}`));
                return;
            }
            resolve(code);
        });
    });
}

export async function handleResumeCommand(args: string[]): Promise<void> {
    const parsed = parseResumeCommandArgs(args);
    if (parsed.showHelp) {
        console.log(formatResumeHelp());
        return;
    }

    const session = await resolveHappySession(parsed.sessionId);
    const launch = buildResumeLaunch(session);

    if (!existsSync(launch.cwd)) {
        throw new Error(`Saved session path does not exist: ${launch.cwd}`);
    }

    const evidenceEnvironment = resolveRecoveredInputEvidenceEnvironment({
        savedEnvironment: readPersistedSessions()[session.id]?.agentEnvironment,
        metadata: session.metadata,
        requestedEnvironment: parsed.inputEvidence === undefined ? undefined : { [INPUT_EVIDENCE_ENV]: parsed.inputEvidence },
    });
    const exitCode = await spawnResumeChild(launch, evidenceEnvironment);
    if (typeof exitCode === 'number' && exitCode !== 0) {
        process.exit(exitCode);
    }
}
