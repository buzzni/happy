import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { log } from '@/utils/log';
import { scriptQueueInTransaction } from './scriptExecutionService';

export function startScriptInvocationMaintenance() {
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    running = (async () => {
      const now = Date.now();
      const rows = await db.scriptInvocation.findMany({ where: { OR: [
        { status: 'QUEUED', createdAt: { lte: now - 86400000 } },
        { status: { in: ['CLAIMED', 'RUNNING'] }, leaseExpiresAt: { lte: now } },
        { status: { notIn: ['QUEUED', 'CLAIMED', 'RUNNING'] }, completedAt: { lte: now - 86400000 }, inputCiphertext: { not: '' } },
        { status: { notIn: ['QUEUED', 'CLAIMED', 'RUNNING'] }, completedAt: { lte: now - 2592000000 } },
      ] }, distinct: ['automationId'], select: { automationId: true }, orderBy: { automationId: 'asc' }, take: 100 });
      for (const { automationId } of rows) {
        try { await inTx((tx) => scriptQueueInTransaction(tx).sweep(automationId, now)); }
        catch (error) { log({ module: 'script-maintenance', automationId }, `Queue maintenance failed: ${error instanceof Error ? error.message : 'unknown error'}`); }
      }
    })().catch((error) => {
      log({ module: 'script-maintenance' }, `Queue maintenance scan failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }).finally(() => { running = null; });
  };
  const timer = setInterval(tick, 60000);
  timer.unref();
  tick();
  return { async stop() { clearInterval(timer); if (running) await running; } };
}
