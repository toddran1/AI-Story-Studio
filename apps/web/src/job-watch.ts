import { api, isTerminalJob, type Job } from "./api.js";
type Listener = { update: (job: Job) => void | Promise<void>; error: (error: unknown) => void; failures: number; maxFailures?: number; active: boolean };
type Watch = { id: string; listeners: Set<Listener>; timer?: ReturnType<typeof setTimeout>; controller?: AbortController; stopped: boolean };
const watches = new Map<string, Watch>();
/** Short requests avoid exhausting the browser's HTTP connection pool with
 * one persistent progress stream per card/tab. Duplicate observers share work. */
export function watchJob(id: string, onUpdate: Listener["update"], onError: Listener["error"], options: { maxFailures?: number } = {}) {
  const listener: Listener = { update: onUpdate, error: onError, failures: 0, maxFailures: options.maxFailures, active: true };
  let watch = watches.get(id);
  const fresh = !watch;
  if (!watch) { watch = { id, listeners: new Set(), stopped: false }; watches.set(id, watch); }
  watch.listeners.add(listener);
  const current = watch;
  const unsubscribe = () => { listener.active = false; current.listeners.delete(listener); if (!current.listeners.size) stop(current); };
  if (fresh) void poll(current);
  return unsubscribe;
}
function stop(watch: Watch) {
  watch.stopped = true; if (watch.timer) clearTimeout(watch.timer); watch.controller?.abort();
  if (watches.get(watch.id) === watch) watches.delete(watch.id);
}
function report(listener: Listener, error: unknown) {
  if (!listener.active) return;
  try { listener.error(error); } catch { /* One observer must not interrupt the others. */ }
}
async function poll(watch: Watch) {
  if (watch.stopped) return;
  const controller = new AbortController(); watch.controller = controller;
  // Bound a stalled request so monitoring can recover without a page reload.
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let delay = 1000;
  try {
    const job = await api<Job>(`/jobs/${watch.id}`, { signal: controller.signal });
    if (watch.stopped) return;
    if (job.id !== watch.id) throw new Error("The service returned a different job. Retrying progress updates.");
    for (const listener of [...watch.listeners]) {
      if (!listener.active) continue;
      listener.failures = 0;
      try { void Promise.resolve(listener.update(job)).catch(error => report(listener, error)); } catch (error) { report(listener, error); }
    }
    if (isTerminalJob(job)) stop(watch);
  } catch (error) {
    if (watch.stopped) return;
    delay = 2000;
    for (const listener of [...watch.listeners]) {
      listener.failures++; report(listener, error);
      if (listener.maxFailures !== undefined && listener.failures >= listener.maxFailures) { listener.active = false; watch.listeners.delete(listener); }
    }
    if (!watch.listeners.size) stop(watch);
  } finally { clearTimeout(timeout); }
  if (!watch.stopped) watch.timer = setTimeout(() => void poll(watch), delay);
}
