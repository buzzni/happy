export type WorkerRole = 'coder' | 'reviewer' | 'tester' | 'researcher';

export interface WorkerProfile {
    name: string;
    role: WorkerRole;
    systemPrompt: string;
    allowedTools: string[];
    maxTurns: number;
    defaultModel: string;
}

export interface WorkerTask {
    id: string;
    workerRole: WorkerRole;
    prompt: string;
    context?: string;
    sessionId?: string;
    status: 'pending' | 'running' | 'complete' | 'failed';
    result?: string;
    error?: string;
    startedAt?: number;
    completedAt?: number;
}

export interface OrchestratorConfig {
    orchestratorModel: string;
    workerModel: string;
    maxConcurrentWorkers: number;
}

export interface SpawnWorkerInput {
    role: WorkerRole;
    task: string;
    context?: string;
}

export interface WorkerStatus {
    workerId: string;
    status: WorkerTask['status'];
    progress?: string;
}

export interface WorkerResult {
    workerId: string;
    result?: string;
    error?: string;
}
