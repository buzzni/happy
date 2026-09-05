import { describe, expect, it } from 'vitest'
import { planElectronGuiDisplay, ELECTRON_GUI_DISPLAY } from './electronGuiDisplay'

describe('planElectronGuiDisplay', () => {
    it('Linux 호스트는 Xvfb 를 확보하고 DISPLAY 를 준다', () => {
        const plan = planElectronGuiDisplay({ platform: 'linux', xvfbInstalled: true, canSudo: false, guiSession: null })
        expect(plan).toEqual({ ok: true, display: ELECTRON_GUI_DISPLAY, needsXvfb: true })
    })

    it('Linux 호스트에 Xvfb 가 없으면 설치 계획을 돌려주고 조용히 진행하지 않는다', () => {
        const plan = planElectronGuiDisplay({ platform: 'linux', xvfbInstalled: false, canSudo: true, guiSession: null })
        expect(plan.ok).toBe(false)
        if (plan.ok || plan.reason !== 'xvfb-missing') throw new Error(`unexpected plan: ${JSON.stringify(plan)}`)
        expect(plan.install.action).toBe('run')
        expect(plan.install.command).toContain('xvfb')
        // 화면 스트림은 CDP 라 x11vnc/websockify/novnc 는 설치 대상이 아니다.
        expect(plan.install.command).not.toContain('x11vnc')
        expect(plan.install.command).not.toContain('novnc')
    })

    it('macOS 는 로그인된 GUI 세션(Aqua)이 있어야 하고 DISPLAY 는 없다', () => {
        expect(planElectronGuiDisplay({ platform: 'darwin', xvfbInstalled: false, canSudo: false, guiSession: 'Aqua' }))
            .toEqual({ ok: true, display: null, needsXvfb: false })
        const noSession = planElectronGuiDisplay({ platform: 'darwin', xvfbInstalled: false, canSudo: false, guiSession: 'Background' })
        expect(noSession).toMatchObject({ ok: false, reason: 'no-gui-session' })
    })

    it('Windows 는 디스플레이 준비 없이 진행한다', () => {
        expect(planElectronGuiDisplay({ platform: 'win32', xvfbInstalled: false, canSudo: false, guiSession: null }))
            .toEqual({ ok: true, display: null, needsXvfb: false })
    })
})
