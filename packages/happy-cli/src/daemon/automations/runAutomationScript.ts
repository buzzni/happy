/**
 * Scheduled automations 감시 스크립트 실행기.
 *
 * registerCommonHandlers의 bash 핸들러와 같은 방식(exec + validatePath cwd 검증 +
 * timeout, 비0 종료는 실패)을 automationTick의 runScript 계약에 맞춰 별도 함수로
 * 구현한다. stdout은 여기서 자르지 않는다 — wake-gate가 마지막 줄을 봐야 하고,
 * 프롬프트 주입 시의 절단은 도메인(buildAutomationPrompt)의 책임이다.
 */

import { exec, type ExecOptions } from 'node:child_process'
import { promisify } from 'node:util'

import { validatePath } from '@/modules/common/pathSecurity'

const execAsync = promisify(exec)

// exec 기본 maxBuffer(1MiB)는 스크립트 출력을 예외로 끊어버린다. 절단 없이
// 넘기라는 계약이므로 도메인 캡(16KiB)보다 충분히 큰 여유를 둔다.
const SCRIPT_MAX_BUFFER_BYTES = 10 * 1024 * 1024

export interface RunAutomationScriptInput {
  command: string
  cwd: string
  timeout: number
  /** validatePath의 허용 루트 — apiMachine의 RPC 표면과 같은 root를 주입한다. */
  allowedRoot: string
}

export interface RunAutomationScriptResult {
  ok: boolean
  stdout: string
  error?: string
}

export async function runAutomationScript(input: RunAutomationScriptInput): Promise<RunAutomationScriptResult> {
  const validation = validatePath(input.cwd, input.allowedRoot)
  if (!validation.valid) {
    return { ok: false, stdout: '', error: validation.error ?? 'Invalid cwd' }
  }

  const options: ExecOptions = {
    cwd: validation.resolvedPath,
    timeout: input.timeout,
    maxBuffer: SCRIPT_MAX_BUFFER_BYTES,
    windowsHide: true,
  }

  try {
    const { stdout } = await execAsync(input.command, options)
    return { ok: true, stdout: stdout ? stdout.toString() : '' }
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & { stdout?: string; killed?: boolean }
    const timedOut = execError.code === 'ETIMEDOUT' || execError.killed === true
    return {
      ok: false,
      stdout: execError.stdout ? execError.stdout.toString() : '',
      error: timedOut ? 'Command timed out' : (execError.message || 'Command failed'),
    }
  }
}
