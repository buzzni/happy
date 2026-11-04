import type { Prisma } from '@prisma/client';
import { isAutomationExecutionSessionId } from '@slopus/happy-wire';

/** Display projection only. Reading it never appends messages to the manual provider input. */
export async function listAutomationExecutionPage(tx: Prisma.TransactionClient, accountId: string,
  displaySessionId: string, input: { limit: number; cursor: string | null }) {
  if (isAutomationExecutionSessionId(displaySessionId)
    || !await tx.session.findFirst({ where: { id: displaySessionId, accountId }, select: { id: true } })) return null;
  let after: { createdAt: Date; id: string } | null = null;
  if (input.cursor !== null) {
    try {
      const row = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0]) || row[0] < 0
        || !Number.isFinite(new Date(row[0]).getTime()) || typeof row[1] !== 'string' || !row[1] || row[1].length > 160) throw new Error();
      after = { createdAt: new Date(row[0]), id: row[1] };
    } catch { throw new Error('invalid-automation-execution-cursor'); }
  }
  const rows = await tx.automationRun.findMany({
    where: { displaySessionId, machineAccountId: accountId, executionCreateBodyHash: { not: null },
      automation: { project: { OR: [{ accountId }, { members: { some: { accountId, status: 'accepted' } } }] } },
      ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}),
    },
    select: { id: true, automationId: true, generation: true, displaySessionId: true, sessionId: true,
      createdAt: true, scheduledFor: true, status: true, outcome: true, failureCode: true, startedAt: true, completedAt: true,
      automation: { select: { projectId: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: input.limit + 1,
  });
  const page = rows.slice(0, input.limit), last = page.at(-1);
  return { runs: page.map(row => ({ id: row.id, automationId: row.automationId, projectId: row.automation.projectId,
    generation: row.generation, displaySessionId: row.displaySessionId, executionSessionId: row.sessionId,
    // COMPLETED/WOKE means dispatch accepted, not proof that the native model finished its answer.
    schedulerStatus: row.status, outcome: row.outcome, failureCode: row.failureCode,
    scheduledFor: row.scheduledFor.getTime(), dispatchedAt: row.startedAt?.getTime() ?? null,
    dispatchReportedAt: row.completedAt?.getTime() ?? null,
  })), nextCursor: rows.length > input.limit && last
    ? Buffer.from(JSON.stringify([last.createdAt.getTime(), last.id])).toString('base64url') : null };
}
