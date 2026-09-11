import { logger } from "../utils/logger.js";
import { classifyQueueFailure } from "./failure.js";
import { PostgresQueueRepository, QueueBudgetPausedError, QueueLeaseLostError } from "./repository.js";
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
    let writes = Promise.resolve(); let lastStage = "reconciling"; let leaseLost = false;
    const lost = (error: unknown) => { leaseLost = true; logger.warn({ event: "queue.chapter.lease_lost", jobId: item.jobId, chapter: item.chapter, error: error instanceof Error ? error.message : String(error) }); };
    const progress = (stage: string, status = "started") => { if (leaseLost) throw new QueueLeaseLostError("Work item lease was lost"); if (stage === lastStage && status === "started") return; lastStage = stage; writes = writes.then(async () => { await this.repository.heartbeat(item.id, this.options.workerId, item.leaseToken, stage, this.options.leaseMs); if (!leaseLost) await this.repository.addEvent(item.jobId, status === "reused" ? "stage.reused" : "stage.started", `${stage} ${status}`, { chapter: item.chapter, stage }); }).catch(lost); };
    const keepAlive=setInterval(()=>void this.repository.heartbeat(item.id,this.options.workerId,item.leaseToken,lastStage,this.options.leaseMs).catch(lost),Math.max(10_000,Math.floor(this.options.leaseMs/3)));keepAlive.unref();
    try { const result = await this.executor.execute(item, job, progress); await writes; if (leaseLost) return; await this.repository.completeItem(item, result); if (this.options.providerSpacingMs) for (const provider of item.requiredProviders) await this.repository.setCooldown(provider, new Date(Date.now()+this.options.providerSpacingMs), "Configured request spacing"); }
    catch (error) { await writes.catch(() => undefined); if (leaseLost || error instanceof QueueLeaseLostError || error instanceof QueueBudgetPausedError) return; const failure = classifyQueueFailure(error); if(!failure.provider&&item.requiredProviders.length===1)failure.provider=item.requiredProviders[0]; try { await this.repository.failItem(item, failure); } catch (finishError) { if (finishError instanceof QueueLeaseLostError) { lost(finishError); return; } throw finishError; } logger.warn({ event: "queue.chapter.failed", jobId:item.jobId,chapter:item.chapter,category:failure.category,error:failure.message }); }
    finally{clearInterval(keepAlive);}
  }
  private async finalize(job: QueueJob) {
    let leaseLost=false;const lost=(error:unknown)=>{leaseLost=true;logger.warn({event:"queue.finalization.lease_lost",jobId:job.id,error:error instanceof Error?error.message:String(error)});};
    const keepAlive=setInterval(()=>void this.repository.heartbeatFinalization(job,this.options.workerId,this.options.leaseMs).catch(lost),Math.max(10_000,Math.floor(this.options.leaseMs/3)));keepAlive.unref();
    try { const result = await this.executor.finalize(job, (stage,status="started") => { if(leaseLost)throw new QueueLeaseLostError("Finalization lease was lost");void this.repository.addEvent(job.id,`export.${status}`,`${stage} ${status}`,{stage}).catch(lost); }); if(leaseLost)return; await this.repository.completeFinalization(job,result.warning); }
    catch(error){if(leaseLost||error instanceof QueueLeaseLostError)return;const failure=classifyQueueFailure(error);try{await this.repository.failFinalization(job,failure);}catch(finishError){if(finishError instanceof QueueLeaseLostError){lost(finishError);return;}throw finishError;}}finally{clearInterval(keepAlive);}
  }
}
