import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BrowserInstanceId } from '../contracts'
import { CdpDriver } from './cdpDriver'
import { findChrome, launchChrome, startSite, HarnessCdp, type LaunchedChrome, type Site } from './pocTestKit'

describe.skipIf(!findChrome())('human page port in isolated real Chrome (local PoC, not remote acceptance)', () => {
    let chrome: LaunchedChrome, site: Site, driver: CdpDriver, harness: HarnessCdp
    const origins: string[][] = []
    beforeAll(async () => {
        chrome = await launchChrome(); site = await startSite('a.poc-one.test')
        site.route('/input', '<title>Page viewer fixture</title><style>body{margin:0}input{position:absolute;left:20px;top:20px;width:200px;height:40px}</style><input id="field"><div style="height:3000px"></div>')
        driver = new CdpDriver({ browserWsUrl: chrome.browserWsUrl, browserInstanceIdProvider: async () => randomUUID() as BrowserInstanceId,
            setAllowedOrigins: values => { origins.push([...values]) } })
        await driver.connect(); harness = await HarnessCdp.connect(chrome.browserWsUrl)
    })
    afterAll(async () => { harness?.close(); await driver?.close(); await site?.close(); await chrome?.stop() })
    it('captures the owned viewport without changing egress and sends pointer/IME text only after the live guard', async () => {
        const tab = await driver.openTab(site.url('/input'), [site.origin], { timeoutMs: 15000 })
        const before = origins.length
        const frame = await driver.pageView.capture(tab.tabId, () => {}, 55, 1280)
        expect(frame).toMatchObject({ mimeType: 'image/jpeg', viewport: { width: expect.any(Number), height: expect.any(Number) } })
        expect(frame.pixelWidth).toBeGreaterThan(0)
        expect(Buffer.from(frame.data, 'base64').subarray(0, 2)).toEqual(Buffer.from([255, 216]))
        expect(origins).toHaveLength(before)
        const pointer = { kind: 'pointer' as const, x: 80, y: 40, button: 'left' as const, buttons: 1, clickCount: 1, modifiers: 0 }
        await driver.pageView.input(tab.tabId, frame, { ...pointer, type: 'mousePressed' }, () => {})
        await driver.pageView.input(tab.tabId, frame, { ...pointer, buttons: 0, type: 'mouseReleased' }, () => {})
        await driver.pageView.input(tab.tabId, frame, { kind: 'text', text: '한글 입력 확인' }, () => {})
        expect(await harness.evaluate(tab.targetId, "document.querySelector('#field').value")).toBe('한글 입력 확인')
        await driver.pageView.input(tab.tabId, frame, { kind: 'key', type: 'keyDown', key: 'Backspace', code: 'Backspace', modifiers: 0 }, () => {})
        await driver.pageView.input(tab.tabId, frame, { kind: 'key', type: 'keyUp', key: 'Backspace', code: 'Backspace', modifiers: 0 }, () => {})
        expect(await harness.evaluate(tab.targetId, "document.querySelector('#field').value")).toBe('한글 입력 확')
        await expect(driver.pageView.input(tab.tabId, frame, { kind: 'text', text: 'refused' }, () => { throw new Error('control changed') })).rejects.toThrow('control changed')
        expect(await harness.evaluate(tab.targetId, "document.querySelector('#field').value")).toBe('한글 입력 확')
        // A view close drains keys/buttons even when the user leaves before sending keyUp/mouseReleased.
        await harness.evaluate(tab.targetId, `window.released=[];addEventListener('keyup',e=>window.released.push(e.code));addEventListener('mouseup',()=>window.released.push('mouse'))`)
        await driver.pageView.input(tab.tabId, frame, { kind: 'key', type: 'keyDown', key: 'Shift', code: 'ShiftLeft', modifiers: 8 }, () => {})
        await driver.pageView.input(tab.tabId, frame, { ...pointer, type: 'mousePressed' }, () => {})
        await driver.pageView.release(tab.tabId)
        expect(await harness.evaluate(tab.targetId, `window.released`)).toEqual(['ShiftLeft', 'mouse'])
        await harness.evaluate(tab.targetId, 'window.scrollTo(0, 300)')
        await expect(driver.pageView.input(tab.tabId, frame, { kind: 'text', text: 'old-frame' }, () => {})).rejects.toMatchObject({ code: 'STALE_REF' })
        await driver.closeTab(tab.tabId, { timeoutMs: 15000 })
    })
})
