/**
 * Daemon-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import { ChildProcess } from 'child_process';

export interface SessionEncryptionData {
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  seq: number;
  metadataVersion: number;
  agentStateVersion: number;
}

export interface SessionRuntimeState {
  thinking: boolean;
  hasOpenToolCall: boolean;
  /**
   * True while the agent is blocked waiting on the user (AskUserQuestion or a
   * permission prompt). This is the opposite of idle, but historically the CLI
   * reports such a session as `thinking: false`, so the idle guard needs it as
   * a dedicated signal to avoid reaping a session that is waiting on a human.
   */
  pendingUserInput?: boolean;
  /**
   * Last time a user-originated action was observed for this session (a new
   * prompt starting a turn, or an AskUserQuestion being answered). Absent until
   * the first user interaction is seen. Unlike `updatedAt` this is not a
   * liveness/keep-alive timestamp — it only advances on real user activity.
   */
  lastUserInteractionAt?: number;
  /**
   * Last time the agent finished a turn and went fully idle (busy → not
   * thinking / no open tool call / not waiting on the user). Marks a safe
   * reclamation point — there is no in-flight work to lose — so the reaper can
   * clean a done-and-idle conversation well before the multi-day absolute cut.
   */
  lastTurnEndAt?: number;
  /**
   * True once this conversation has launched a background job (e.g. a Bash tool
   * call with run_in_background). Such a session may look idle at turn end while
   * its detached work is still running, so it is exempted from the aggressive
   * turn-end reap and falls back to the conservative absolute idle cut.
   */
  launchedBackgroundJob?: boolean;
  /** 'local' = a terminal is attached to this session; 'remote' = app-driven. */
  mode?: 'local' | 'remote';
  updatedAt: number;
}

/**
 * Session tracking for daemon
 */
export interface TrackedSession {
  startedBy: 'daemon' | string;
  happySessionId?: string;
  happySessionMetadataFromLocalWebhook?: Metadata;
  runtime?: SessionRuntimeState;
  encryption?: SessionEncryptionData;
  pid: number;
  childProcess?: ChildProcess;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
  /** tmux session identifier (format: session:window) */
  tmuxSessionId?: string;
  /**
   * Absolute path to a tmp HAPPY_HOME_DIR staged for this session's child
   * process. Present only when the spawn request carried per-user Happy
   * credentials. The daemon removes this directory when the child exits or
   * sweeps it on next startup if cleanup was missed.
   */
  userHomeDir?: string;
}
