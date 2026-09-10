import { logger } from "../utils/logger.js";
import { classifyQueueFailure } from "./failure.js";
import { PostgresQueueRepository } from "./repository.js";
import { QueueJob, QueueWorkItem } from "./types.js";

export type QueueExecutionResult = { reused: boolean; qaStatus?: "pass" | "warn" | "fail" };
export type QueueExecutor = {
  execute(item: QueueWorkItem, job: QueueJob, progress: (stage: string, status?: string) => void): Promise<QueueExecutionResult>;
  finalize(job: QueueJob, progress: (stage: string, status?: string) => void): Promise<{ warning?: string }>;
};

export class ProductionWorker {
  private stopped = true; private timer?: NodeJS.Timeout; private active?: Promise<void>;
  constructor(private readonly repository: PostgresQueueRepository, private readonly executor: QueueExecutor,
    private readonly options: { workerId: string; pollMs: number; leaseMs: number; providerSpacingMs: number }) {}

  async start() { if (!this.stopped) return; this.stopped = false; const recovered = await this.repository.recoverExpired(); await this.repository.pruneEvents(); if (recovered) logger.info({ event: "queue.recovered", workItems: recovered }); this.schedule(0); }
  async stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); await this.active; }
  async tick() {
    if (this.active) return this.active; this.active = this.workOnce().catch((error) => logger.error({ event: "queue.worker.failed", error: error instanceof Error ? error.message : String(error) })).finally(() => { this.active = undefined; });
    await this.active;
  }
  private schedule(delay: number) { if (this.stopped) return; this.timer = setTimeout(() => void this.tick().finally(() => this.schedule(this.options.pollMs)), delay); }
  private async workOnce() {
    await this.repository.recoverExpired();
    const item = await this.repository.claimNext(this.options.workerId, this.options.leaseMs);
    if (item) { await this.runItem(item); return; }
    const job = await this.repository.claimFinalization(this.options.workerId, this.options.leaseMs);
    if (job) await this.finalize(job);
  }
  private async runItem(item: QueueWorkItem) {
    const job = await this.repository.getJob(item.jobId); if (!job) return;
    let writes = Promise.resolve(); let lastStage = "reconciling";
    const progress = (stage: string, status = "started") => { if (stage === lastStage && status === "started") return; lastStage = stage; writes = writes.then(async () => { await this.repository.heartbeat(item.id, this.options.workerId, stage, this.options.leaseMs); await this.repository.addEvent(item.jobId, status === "reused" ? "stage.reused" : "stage.started", `${stage} ${status}`, { chapter: item.chapter, stage }); }); };
    const keepAlive=setInterval(()=>void this.repository.heartbeat(item.id,this.options.workerId,lastStage,this.options.leaseMs).catch(error=>logger.error({event:"queue.chapter.heartbeat_failed",jobId:item.jobId,chapter:item.chapter,error:error instanceof Error?error.message:String(error)})),Math.max(10_000,Math.floor(this.options.leaseMs/3)));keepAlive.unref();
    try { const result = await this.executor.execute(item, job, progress); await writes; await this.repository.completeItem(item, result); if (this.options.providerSpacingMs) for (const provider of item.requiredProviders) await this.repository.setCooldown(provider, new Date(Date.now()+this.options.providerSpacingMs), "Configured request spacing"); }
    catch (error) { await writes.catch(() => undefined); const failure = classifyQueueFailure(error); if(!failure.provider&&item.requiredProviders.length===1)failure.provider=item.requiredProviders[0]; await this.repository.failItem(item, failure); logger.warn({ event: "queue.chapter.failed", jobId:item.jobId,chapter:item.chapter,category:failure.category,error:failure.message }); }
    finally{clearInterval(keepAlive);}
  }
  private async finalize(job: QueueJob) {
    const keepAlive=setInterval(()=>void this.repository.heartbeatFinalization(job.id,this.options.workerId,this.options.leaseMs).catch(error=>logger.error({event:"queue.finalization.heartbeat_failed",jobId:job.id,error:error instanceof Error?error.message:String(error)})),Math.max(10_000,Math.floor(this.options.leaseMs/3)));keepAlive.unref();
    try { const result = await this.executor.finalize(job, (stage,status="started") => void this.repository.addEvent(job.id,`export.${status}`,`${stage} ${status}`,{stage})); await this.repository.completeFinalization(job.id,result.warning); }
    catch(error){const failure=classifyQueueFailure(error);await this.repository.failFinalization(job.id,failure);}finally{clearInterval(keepAlive);}
  }
}
