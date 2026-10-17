import { join } from 'node:path'
import { projectPath } from '@/projectPath'

/**
 * AgentTask 워커가 /start·/heartbeat·/complete·/fail 을 보낼 때 쓰는 클라이언트.
 * 봉투(version·token·agentRunId·idempotencyKey)는 이 스크립트가 채우고 워커는 결과
 * 파일만 만든다. 워커 세션에는 happy 가 PATH 에 있다는 보장이 없으므로 데몬이 이
 * 경로와 자신의 node 실행 파일을 환경변수로 넘긴다.
 */
export const AGENT_TASK_CLIENT_PATH = join(projectPath(), 'bin', 'happy-agent-task.mjs')
