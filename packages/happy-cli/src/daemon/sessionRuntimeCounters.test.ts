import { describe, expect, it } from 'vitest';
import {
    mergeCumulativeRuntimeCounter,
    runtimeReportBelongsToTrackedProcess,
    shouldAcceptSessionRuntimeReport,
} from './sessionRuntimeCounters';

describe('mergeCumulativeRuntimeCounter', () => {
    it('keeps the highest cumulative value when runtime reports arrive out of order', () => {
        expect(mergeCumulativeRuntimeCounter(12, 9)).toBe(12);
        expect(mergeCumulativeRuntimeCounter(12, 15)).toBe(15);
    });

    it('preserves absence until either report provides a value', () => {
        expect(mergeCumulativeRuntimeCounter(undefined, undefined)).toBeUndefined();
        expect(mergeCumulativeRuntimeCounter(undefined, 3)).toBe(3);
        expect(mergeCumulativeRuntimeCounter(3, undefined)).toBe(3);
    });
});

describe('shouldAcceptSessionRuntimeReport', () => {
    it('rejects delayed reports so old idle state cannot overwrite a newer busy state', () => {
        expect(shouldAcceptSessionRuntimeReport(4, 3)).toBe(false);
        expect(shouldAcceptSessionRuntimeReport(4, 4)).toBe(false);
        expect(shouldAcceptSessionRuntimeReport(4, 5)).toBe(true);
    });

    it('does not let a sequence-less report downgrade an already sequenced process', () => {
        expect(shouldAcceptSessionRuntimeReport(4, undefined)).toBe(false);
        expect(shouldAcceptSessionRuntimeReport(undefined, 1)).toBe(true);
        expect(shouldAcceptSessionRuntimeReport(undefined, undefined)).toBe(true);
    });
});

describe('runtimeReportBelongsToTrackedProcess', () => {
    it('rejects a delayed report from a previous process generation', () => {
        expect(runtimeReportBelongsToTrackedProcess(200, 100)).toBe(false);
        expect(runtimeReportBelongsToTrackedProcess(200, 200)).toBe(true);
    });

    it('keeps compatibility with reporters that predate hostPid', () => {
        expect(runtimeReportBelongsToTrackedProcess(200, undefined)).toBe(true);
    });
});
