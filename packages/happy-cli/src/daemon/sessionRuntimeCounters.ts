export function mergeCumulativeRuntimeCounter(
    previous: number | undefined,
    reported: number | undefined,
): number | undefined {
    if (previous === undefined) return reported;
    if (reported === undefined) return previous;
    return Math.max(previous, reported);
}

export function shouldAcceptSessionRuntimeReport(
    previousSequence: number | undefined,
    reportedSequence: number | undefined,
): boolean {
    if (reportedSequence === undefined) return previousSequence === undefined;
    return previousSequence === undefined || reportedSequence > previousSequence;
}

export function runtimeReportBelongsToTrackedProcess(
    trackedPid: number,
    reporterPid: number | undefined,
): boolean {
    return reporterPid === undefined || reporterPid === trackedPid;
}
