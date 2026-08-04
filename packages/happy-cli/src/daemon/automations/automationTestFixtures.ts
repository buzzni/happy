/**
 * 테스트 전용 픽스처. .test.ts 파일에서 cross-import하면 그 파일의 테스트가
 * 중복 등록되므로(vitest는 import된 테스트 파일의 describe도 다시 실행한다)
 * 픽스처는 일반 모듈로 분리한다. 프로덕션 코드에서 import 금지.
 */

import type { ScheduledAutomation } from './automationDomain'

export function makeAutomation(patch: Partial<ScheduledAutomation> = {}): ScheduledAutomation {
  return {
    id: 'auto-1',
    projectId: 'project-1',
    name: '아침 로그 점검',
    schedule: { kind: 'daily', hour: 9, minute: 0 },
    prompt: '어제 로그를 점검해줘',
    directory: '/repo/project-1',
    scriptCommand: null,
    suppressSilent: false,
    paused: false,
    createdAt: 1_000,
    nextRunAt: null,
    runHistory: [],
    createdByAccountId: null,
    ...patch,
  }
}
