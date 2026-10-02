import type { ServerResponse } from "node:http";
import type { SourceInspectOptions } from "../../src/source/types.js";

/** The existing inspection request can stream progress without creating a production job. */
export async function streamSourceInspection(
  response: ServerResponse,
  inspect: (options: Pick<SourceInspectOptions, "onProgress" | "signal">) => Promise<unknown>,
  publicError: (error: unknown) => unknown,
): Promise<true> {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  response.flushHeaders();
  const controller = new AbortController();
  const push = (event: string, data: unknown) => {
    if (!response.destroyed && !response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => { if (!response.destroyed && !response.writableEnded) response.write(": heartbeat\n\n"); }, 15_000);
  heartbeat.unref();
  const disconnected = () => controller.abort();
  response.once("close", disconnected);
  try {
    const result = await inspect({ signal: controller.signal, onProgress: (progress) => push("progress", progress) });
    controller.signal.throwIfAborted();
    push("result", result);
  } catch (error) {
    if (!controller.signal.aborted) push("error", publicError(error));
  } finally {
    clearInterval(heartbeat);
    response.off("close", disconnected);
    if (!response.destroyed && !response.writableEnded) response.end();
  }
  return true;
}
