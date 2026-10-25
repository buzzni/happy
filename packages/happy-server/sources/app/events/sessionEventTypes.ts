export const SESSION_EVENT_TYPES = {
    SESSION_END: 'session-end',
    TOOL_CALL_START: 'tool-call-start',
    TOOL_CALL_END: 'tool-call-end',
    AGENT_THINKING: 'agent-thinking',
    AGENT_MESSAGE: 'agent-message',
    USAGE_REPORT: 'usage-report',
    ERROR: 'error',
    CHECKPOINT_SNAPSHOT: 'checkpoint-snapshot',
    CHECKPOINT_REWIND: 'checkpoint-rewind',
    MESSAGE_HIDDEN: 'message-hidden',
    MESSAGE_UNHIDDEN: 'message-unhidden',
    // 세션이 한가해졌다는 서버 기록. 본문이 없어 E2EE 세션에서도 서버가 완료를 알 수 있다.
    TURN_READY: 'turn-ready',
} as const;

export type SessionEventType = typeof SESSION_EVENT_TYPES[keyof typeof SESSION_EVENT_TYPES];
