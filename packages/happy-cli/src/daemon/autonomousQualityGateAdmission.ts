export interface AutonomousGateOperation {
    inputEpoch: number;
    signal: AbortSignal;
    finish(): void;
}

export class AutonomousQualityGateAdmission {
    private idle = false;
    private epoch: number;
    private activeOperation?: AbortController;

    constructor(initialEpoch = 0) {
        this.epoch = initialEpoch;
    }

    get inputEpoch(): number {
        return this.epoch;
    }

    get sessionIdle(): boolean {
        return this.idle;
    }

    setSessionIdle(idle: boolean): void {
        this.idle = idle;
    }

    noteUserInput(): void {
        this.epoch += 1;
        this.idle = false;
        this.activeOperation?.abort();
        this.activeOperation = undefined;
    }

    cancelActiveOperation(): void {
        this.activeOperation?.abort();
        this.activeOperation = undefined;
        this.idle = false;
    }

    beginGateOperation(): AutonomousGateOperation {
        this.activeOperation?.abort();
        const controller = new AbortController();
        this.activeOperation = controller;
        const inputEpoch = this.epoch;
        return {
            inputEpoch,
            signal: controller.signal,
            finish: () => {
                if (this.activeOperation === controller) this.activeOperation = undefined;
            },
        };
    }

    async admitRepair(
        expectedInputEpoch: number,
        send: (signal: AbortSignal) => Promise<void>,
    ): Promise<boolean> {
        if (!this.idle || this.epoch !== expectedInputEpoch) return false;
        this.idle = false;
        this.activeOperation?.abort();
        const controller = new AbortController();
        this.activeOperation = controller;
        try {
            await send(controller.signal);
        } catch (error) {
            if (this.epoch === expectedInputEpoch) this.idle = true;
            throw error;
        } finally {
            if (this.activeOperation === controller) this.activeOperation = undefined;
        }
        return !controller.signal.aborted && this.epoch === expectedInputEpoch;
    }
}
