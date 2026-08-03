import { DurableJobManager } from "./jobManager.js";
import type { DurableJobRecord } from "./jobSteps.js";

export interface DurableJobRecoveryReport {
  scanned: number;
  terminal: number;
  recoverable: string[];
  recovery_required: string[];
  stale: string[];
  jobs: DurableJobRecord[];
}

export async function scanDurableJobs(manager: DurableJobManager): Promise<DurableJobRecoveryReport> {
  const ids = await manager.store.listJobIds();
  const report: DurableJobRecoveryReport = {
    scanned: 0,
    terminal: 0,
    recoverable: [],
    recovery_required: [],
    stale: [],
    jobs: []
  };
  for (const runId of ids) {
    const persisted = await manager.store.readJob(runId);
    if (!persisted) continue;
    report.scanned += 1;
    const inspected = await manager.inspect(runId);
    const job = inspected.job;
    report.jobs.push(job);
    if (["completed", "failed", "blocked", "cancelled"].includes(job.status)) {
      report.terminal += 1;
      continue;
    }
    if (job.status === "recovery_required") {
      report.recovery_required.push(runId);
      continue;
    }
    if (job.status === "stale") report.stale.push(runId);
    report.recoverable.push(runId);
  }
  return report;
}

export async function prepareDurableJobRecovery(manager: DurableJobManager, runId: string): Promise<DurableJobRecord> {
  return await manager.prepareRecovery(runId);
}
