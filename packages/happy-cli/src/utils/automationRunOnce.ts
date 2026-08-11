/** Consume the daemon-only marker that makes a scheduled session exit after one turn. */
export function consumeAutomationRunOnce(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HAPPY_AUTOMATION_RUN_ONCE
  delete env.HAPPY_AUTOMATION_RUN_ONCE
  return raw === '1'
}
