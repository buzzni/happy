import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    accountUpdate: vi.fn(),
    sessionUpdate: vi.fn()
}));

vi.mock("@/storage/db", () => ({
    db: {
        account: { update: mocks.accountUpdate },
        session: { update: mocks.sessionUpdate }
    }
}));

import { allocateUserSeq, allocateUserSeqBatch } from "./seq";

describe("allocateUserSeqBatch", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("allocates a contiguous block with a single account update", async () => {
        mocks.accountUpdate.mockResolvedValue({ seq: 13 });

        const seqs = await allocateUserSeqBatch("account-1", 4);

        expect(seqs).toEqual([10, 11, 12, 13]);
        expect(mocks.accountUpdate).toHaveBeenCalledTimes(1);
        expect(mocks.accountUpdate).toHaveBeenCalledWith({
            where: { id: "account-1" },
            select: { seq: true },
            data: { seq: { increment: 4 } }
        });
    });

    it("matches allocateUserSeq for a single-item block", async () => {
        mocks.accountUpdate.mockResolvedValue({ seq: 7 });
        const single = await allocateUserSeq("account-1");

        mocks.accountUpdate.mockResolvedValue({ seq: 7 });
        const batched = await allocateUserSeqBatch("account-1", 1);

        expect(batched).toEqual([single]);
    });

    it("does not touch the account row when nothing is allocated", async () => {
        await expect(allocateUserSeqBatch("account-1", 0)).resolves.toEqual([]);
        await expect(allocateUserSeqBatch("account-1", -1)).resolves.toEqual([]);

        expect(mocks.accountUpdate).not.toHaveBeenCalled();
    });
});
