import { describe, expect, it } from 'vitest'
import { ResourceQuota, resourceAdmissionLimit, type BrowserResources } from './resourceQuota'
const MiB = 1024 * 1024
const sample = (patch: Partial<BrowserResources> = {}): BrowserResources => ({ version: 1,
    hostAvailableBytes: 12 * 1024 * MiB, memoryLimitBytes: 8 * 1024 * MiB, memoryUsedBytes: 512 * MiB,
    cpuLimit: 4, pidsLimit: 512, pidsUsed: 20, ...patch })
describe('resource-aware browser quota', () => {
    it('requires repeated fresh readings before growing above fallback', () => {
        const q = new ResourceQuota(4)
        expect(q.read(0, 0, 0).limit).toBe(4)
        q.observe(sample(), 0); expect(q.read(0, 0, 0).limit).toBe(4)
        q.observe(sample(), 10_000); expect(q.read(10_000, 0, 0).limit).toBe(6)
        q.observe(sample(), 20_000); expect(q.read(20_000, 0, 0).limit).toBe(8)
    })
    it('bounds growth by the browser cgroup even on a large machine', () => {
        const q = new ResourceQuota(4)
        for (let i=0;i<10;i++) q.observe(sample({ memoryLimitBytes: 2 * 1024 * MiB }), i*10_000)
        expect(q.read(90_000, 0, 0).limit).toBe(5)
    })
    it('stops admissions under host, container or PID pressure without terminating existing work', () => {
        for (const patch of [{ hostAvailableBytes: 512 * MiB }, { memoryUsedBytes: 8*1024*MiB }, { pidsUsed: 512 }]) {
            const q = new ResourceQuota(4);q.observe(sample(patch),1000)
            expect(q.read(1000,5,0).limit).toBeLessThanOrEqual(5)
            expect(q.read(1000,5,0).reason).toBe('resource-pressure')
        }
    })
    it('never grows from stale, missing or malformed measurements', () => {
        const q = new ResourceQuota(4);q.observe(sample(),0);q.observe(sample(),10_000)
        expect(q.read(50_001,0,0)).toMatchObject({limit:4,reason:'measurement-unavailable'})
        q.observe(sample({cpuLimit:NaN}),60_000);expect(q.read(60_000,0,0).limit).toBe(4)
        q.observe(null,70_000);expect(q.read(70_000,0,0).limit).toBe(4)
    })
    it('reserves newly opened windows until the next memory sample', () => {
        const q = new ResourceQuota(4)
        q.observe(sample({memoryLimitBytes:2*1024*MiB}),0);q.observe(sample({memoryLimitBytes:2*1024*MiB}),10_000)
        expect(q.read(10_001,4,0).limit).toBe(5)
        expect(q.read(10_002,5,0).limit).toBe(5)
    })
    it('reserves host headroom for other profiles and empty spaces', () => {
        const q = new ResourceQuota(4)
        for(let i=0;i<5;i++)q.observe(sample({hostAvailableBytes:4*1024*MiB}),i*10_000)
        const capacity=q.read(40_000,0,0).limit
        expect(q.read(40_000,0,6).limit).toBeLessThan(capacity)
        expect(q.read(40_000,0,0).limit).toBe(capacity)
    })
})

it('does not grow during measured CPU saturation and recovers gradually', () => {
 const q=new ResourceQuota(4)
 q.observe(sample({cpuUsageUsec:0}),0,3)
 q.observe(sample({cpuUsageUsec:40_000_000}),10_000,3)
 expect(q.read(10_000,3,0)).toMatchObject({limit:3,reason:'resource-pressure'})
 q.observe(sample({cpuUsageUsec:41_000_000}),20_000,3)
 expect(q.read(20_000,3,0).limit).toBe(5)
})

it('grows across timer jitter rather than resetting below the sampling interval', () => {
 const q=new ResourceQuota(4)
 for(const time of [0,10_100,20_050,30_100,40_050,50_100])q.observe(sample(),time)
 expect(q.read(50_100,0,0).limit).toBeGreaterThan(6)
})
it('never raises a pressure-lowered limit on invalid or stale telemetry', () => {
 for(const missing of [false,true]){
  const q=new ResourceQuota(4);q.observe(sample({hostAvailableBytes:0}),0)
  expect(q.read(0,0,0).limit).toBe(0)
  if(missing)q.observe(null,10_000)
  expect(q.read(40_000,0,0)).toMatchObject({limit:0,reason:'measurement-unavailable',sampledAtMs:0})
 }
})

it('uses legacy fixed limits only before any supported resource sample', () => {
 const q=new ResourceQuota(4)
 expect(resourceAdmissionLimit(q.read(0,0,0),6)).toBe(6)
 q.observe(sample({hostAvailableBytes:0}),0)
 q.observe(null,10_000)
 expect(resourceAdmissionLimit(q.read(40_000,0,0),6)).toBe(0)
})
