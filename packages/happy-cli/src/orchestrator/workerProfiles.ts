import type { WorkerProfile, WorkerRole } from './types';

const CODER_PROFILE: WorkerProfile = {
    name: 'Coder',
    role: 'coder',
    systemPrompt: [
        'You are a coding worker agent. Your sole job is to write or modify code as instructed.',
        'Write clean, well-tested code. Run it to verify correctness before reporting back.',
        'Do NOT ask for user confirmation — you have no user interface.',
        'When done, output a clear summary of what you created or changed.',
    ].join('\n'),
    allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
    maxTurns: 15,
    defaultModel: 'claude-sonnet-4-6',
};

const REVIEWER_PROFILE: WorkerProfile = {
    name: 'Reviewer',
    role: 'reviewer',
    systemPrompt: [
        'You are a code review worker agent. Analyze code for quality, bugs, and security issues.',
        'Be specific: cite file paths, line numbers, and concrete improvement suggestions.',
        'Do NOT modify files — only read and analyze.',
        'Output a structured review with: issues found, severity, and recommended fixes.',
    ].join('\n'),
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxTurns: 10,
    defaultModel: 'claude-sonnet-4-6',
};

const TESTER_PROFILE: WorkerProfile = {
    name: 'Tester',
    role: 'tester',
    systemPrompt: [
        'You are a testing worker agent. Write and run tests for the code you are given.',
        'Cover happy paths, edge cases, and error scenarios.',
        'Run all tests and report results with pass/fail counts.',
        'Output: test file paths, test results summary, and any failing test details.',
    ].join('\n'),
    allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob'],
    maxTurns: 12,
    defaultModel: 'claude-sonnet-4-6',
};

const RESEARCHER_PROFILE: WorkerProfile = {
    name: 'Researcher',
    role: 'researcher',
    systemPrompt: [
        'You are a research worker agent. Investigate documentation, APIs, and codebases.',
        'Search the web and read files to gather relevant information.',
        'Output a concise summary of findings with source references.',
        'Focus on actionable information the orchestrator can use.',
    ].join('\n'),
    allowedTools: ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep'],
    maxTurns: 8,
    defaultModel: 'claude-sonnet-4-6',
};

export const WORKER_PROFILES: Record<WorkerRole, WorkerProfile> = {
    coder: CODER_PROFILE,
    reviewer: REVIEWER_PROFILE,
    tester: TESTER_PROFILE,
    researcher: RESEARCHER_PROFILE,
};

export function getWorkerProfile(role: WorkerRole): WorkerProfile {
    return WORKER_PROFILES[role];
}
