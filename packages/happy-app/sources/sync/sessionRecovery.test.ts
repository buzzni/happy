import { describe, it, expect, vi } from 'vitest';
import {
    consumedComposerClearPlan,
    isRecoverableResumeFailure,
    prepareSessionForSend,
    RECOVERABLE_RESUME_CODES,
    shouldAttemptSessionRecovery,
    type PrepareSendOutcome,
} from './sessionRecovery';
import type { SpawnSessionResult, RecoverSessionResult } from './ops';

const mockMachineId = 'test-machine-123';
const mockSessionId = 'test-session-456';
const mockText = 'Hello, world!';

function createResumeSuccess(): SpawnSessionResult {
    return { type: 'success', sessionId: mockSessionId };
}

function createResumeError(code: string, message: string): SpawnSessionResult {
    return { type: 'error', errorMessage: message, code };
}

function createResumeDirectoryApproval(): SpawnSessionResult {
    return { type: 'requestToApproveDirectoryCreation', directory: '/some/dir' };
}

function createRecoverSuccess(newSessionId: string, recovery: 'same-session' | 'new-session', initialPromptDelivered: boolean): RecoverSessionResult {
    return {
        type: 'success',
        sessionId: newSessionId,
        previousSessionId: mockSessionId,
        recovery,
        initialPromptDelivered,
    };
}

function createRecoverError(code: string, message: string): RecoverSessionResult {
    return { type: 'error', code, errorMessage: message };
}

describe('sessionRecovery', () => {
    describe('shouldAttemptSessionRecovery', () => {
        it('shouldSkipTextOnlyRecoveryWhenAttachmentsWouldBeLost', () => {
            expect(shouldAttemptSessionRecovery({
                isConnected: false,
                enabled: true,
                text: 'Please inspect this image',
                attachmentCount: 1,
                canResume: true,
            })).toBe(false);
        });

        it('shouldAttemptRecoveryForTextWithoutAttachments', () => {
            expect(shouldAttemptSessionRecovery({
                isConnected: false,
                enabled: true,
                text: 'Continue',
                attachmentCount: 0,
                canResume: true,
            })).toBe(true);
        });
    });

    describe('consumedComposerClearPlan', () => {
        it('shouldPreserveTextAndAttachmentsChangedWhileRecoveryWasPending', () => {
            const sentAttachments = [{ uri: 'sent.jpg' }];
            expect(consumedComposerClearPlan({
                sentText: 'sent text',
                currentText: 'new draft',
                sentAttachments,
                currentAttachments: [{ uri: 'new.jpg' }],
            })).toEqual({ clearMessage: false, clearAttachments: false });
        });

        it('shouldClearOnlyComposerValuesThatStillMatchTheSentSnapshot', () => {
            const sentAttachments = [{ uri: 'sent.jpg' }];
            expect(consumedComposerClearPlan({
                sentText: 'sent text',
                currentText: 'sent text',
                sentAttachments,
                currentAttachments: sentAttachments,
            })).toEqual({ clearMessage: true, clearAttachments: true });
        });
    });

    describe('isRecoverableResumeFailure', () => {
        it('shouldReturnTrueForRecoverableCodes', () => {
            RECOVERABLE_RESUME_CODES.forEach(code => {
                expect(isRecoverableResumeFailure(code)).toBe(true);
            });
        });

        it('shouldReturnFalseForNonRecoverableCodes', () => {
            expect(isRecoverableResumeFailure('SESSION_LIVE')).toBe(false);
            expect(isRecoverableResumeFailure('SESSION_IDENTITY_MISMATCH')).toBe(false);
            expect(isRecoverableResumeFailure('SESSION_ALIVE_ELSEWHERE')).toBe(false);
        });

        it('shouldReturnFalseForUndefinedCode', () => {
            expect(isRecoverableResumeFailure(undefined)).toBe(false);
        });
    });

    describe('prepareSessionForSend', () => {
        it('shouldReturnSendNormallyWhenResumeSucceeds', async () => {
            const resume = vi.fn().mockResolvedValue(createResumeSuccess());
            const recover = vi.fn();

            const result = await prepareSessionForSend({
                machineId: mockMachineId,
                sessionId: mockSessionId,
                text: mockText,
                resume,
                recover,
            });

            expect(result).toEqual({ kind: 'send-normally' });
            expect(resume).toHaveBeenCalledTimes(1);
            expect(recover).not.toHaveBeenCalled();
        });

        it('shouldReturnFailedWhenResumeReturnsDirectoryApprovalRequest', async () => {
            const resume = vi.fn().mockResolvedValue(createResumeDirectoryApproval());
            const recover = vi.fn();

            const result = await prepareSessionForSend({
                machineId: mockMachineId,
                sessionId: mockSessionId,
                text: mockText,
                resume,
                recover,
            });

            expect(result).toEqual({ kind: 'failed', reason: 'directory-approval-required' });
            expect(recover).not.toHaveBeenCalled();
        });

        it('shouldReturnFailedWhenResumeReturnsNonRecoverableError', async () => {
            const resume = vi.fn().mockResolvedValue(
                createResumeError('SESSION_IDENTITY_MISMATCH', 'Identity mismatch')
            );
            const recover = vi.fn();

            const result = await prepareSessionForSend({
                machineId: mockMachineId,
                sessionId: mockSessionId,
                text: mockText,
                resume,
                recover,
            });

            expect(result).toEqual({ kind: 'failed', reason: 'rpc-error', message: 'Identity mismatch' });
            expect(recover).not.toHaveBeenCalled();
        });

        it('shouldQueueNormallyWhenResumeRpcTransportFails', async () => {
            const resume = vi.fn().mockResolvedValue(
                createResumeError('RPC_TRANSPORT_ERROR', 'operation has timed out')
            );
            const recover = vi.fn();

            const result = await prepareSessionForSend({
                machineId: mockMachineId,
                sessionId: mockSessionId,
                text: mockText,
                resume,
                recover,
            });

            expect(result).toEqual({ kind: 'send-normally' });
            expect(recover).not.toHaveBeenCalled();
        });

        it('shouldCallRecoverWhenResumeReturnsRecoverableError', async () => {
            const resume = vi.fn().mockResolvedValue(
                createResumeError('SESSION_CURSOR_MISSING', 'Cursor missing')
            );
            const recover = vi.fn().mockResolvedValue(
                createRecoverSuccess('new-session-789', 'same-session', true)
            );

            const result = await prepareSessionForSend({
                machineId: mockMachineId,
                sessionId: mockSessionId,
                text: mockText,
                resume,
                recover,
            });

            expect(recover).toHaveBeenCalledTimes(1);
            expect(recover).toHaveBeenCalledWith({
                sessionId: mockSessionId,
                initialPrompt: mockText,
                model: undefined,
                permissionMode: undefined,
            });
        });

        it('shouldReturnSendNormallyWhenRecoverReturnsSameSession', async () => {
            const resume = vi.fn().mockResolvedValue(
                createResumeError('SESSION_METADATA_MISSING', 'Metadata missing')
            );
            const recover = vi.fn().mockResolvedValue(
                createRecoverSuccess('recovered-session', 'same-session', true)
            );

            const result = await prepareSessionForSend({
                machineId: mockMachineId,
                sessionId: mockSessionId,
                text: mockText,
                resume,
                recover,
            });

            expect(result).toEqual({ kind: 'send-normally' });
        });

        it('shouldReturnPromptDeliveredWhenRecoverReturnsNewSessionWithInitialPromptDelivered', async () => {
            const newSessionId = 'new-session-xyz';
            const resume = vi.fn().mockResolvedValue(
                createResumeError('SESSION_ENCRYPTION_MISSING', 'Encryption missing')
            );
            const recover = vi.fn().mockResolvedValue(
                createRecoverSuccess(newSessionId, 'new-session', true)
            );

            const result = await prepareSessionForSend({
                machineId: mockMachineId,
                sessionId: mockSessionId,
                text: mockText,
                resume,
                recover,
            });

            expect(result).toEqual({ kind: 'prompt-delivered', sessionId: newSessionId });
        });

        it('shouldReturnFailedWhenRecoverReturnsNewSessionWithoutInitialPromptDelivered', async () => {
            const resume = vi.fn().mockResolvedValue(
                createResumeError('SESSION_NOT_TRACKED', 'Not tracked')
            );
            const recover = vi.fn().mockResolvedValue(
                createRecoverSuccess('new-session-fail', 'new-session', false)
            );

            const result = await prepareSessionForSend({
                machineId: mockMachineId,
                sessionId: mockSessionId,
                text: mockText,
                resume,
                recover,
            });

            expect(result).toEqual({ kind: 'failed', reason: 'initial-prompt-not-delivered' });
        });

        it('shouldReturnFailedWhenRecoverReturnsError', async () => {
            const resume = vi.fn().mockResolvedValue(
                createResumeError('SESSION_CURSOR_MISSING', 'Cursor missing')
            );
            const recover = vi.fn().mockResolvedValue(
                createRecoverError('RECOVER_FAILED', 'Recovery failed')
            );

            const result = await prepareSessionForSend({
                machineId: mockMachineId,
                sessionId: mockSessionId,
                text: mockText,
                resume,
                recover,
            });

            expect(result).toEqual({ kind: 'failed', reason: 'rpc-error', message: 'Recovery failed' });
        });

        it('shouldQueueNormallyWhenRecoverRpcTransportFails', async () => {
            const resume = vi.fn().mockResolvedValue(
                createResumeError('SESSION_CURSOR_MISSING', 'Cursor missing')
            );
            const recover = vi.fn().mockResolvedValue(
                createRecoverError('RPC_TRANSPORT_ERROR', 'Socket not connected')
            );

            const result = await prepareSessionForSend({
                machineId: mockMachineId,
                sessionId: mockSessionId,
                text: mockText,
                resume,
                recover,
            });

            expect(result).toEqual({ kind: 'send-normally' });
        });

        it('shouldPassModelAndPermissionModeToRecoverWhenProvided', async () => {
            const resume = vi.fn().mockResolvedValue(
                createResumeError('SESSION_CURSOR_MISSING', 'Cursor missing')
            );
            const recover = vi.fn().mockResolvedValue(
                createRecoverSuccess('new-session-789', 'same-session', true)
            );

            await prepareSessionForSend({
                machineId: mockMachineId,
                sessionId: mockSessionId,
                text: mockText,
                model: 'claude-3-sonnet',
                permissionMode: 'bypassPermissions',
                resume,
                recover,
            });

            expect(recover).toHaveBeenCalledWith(
                expect.objectContaining({
                    model: 'claude-3-sonnet',
                    permissionMode: 'bypassPermissions',
                })
            );
        });

        it('shouldCoverAllRecoverableCodes', async () => {
            for (const code of RECOVERABLE_RESUME_CODES) {
                const resume = vi.fn().mockResolvedValue(
                    createResumeError(code, `Error: ${code}`)
                );
                const recover = vi.fn().mockResolvedValue(
                    createRecoverSuccess('new-session', 'new-session', true)
                );

                const result = await prepareSessionForSend({
                    machineId: mockMachineId,
                    sessionId: mockSessionId,
                    text: mockText,
                    resume,
                    recover,
                });

                expect(recover).toHaveBeenCalled();
                recover.mockClear();
            }
        });
    });
});
