import { sourceInspectionProgressSchema } from "../../../src/source/types.js";
import type { SourceInspectionProgress } from "../../../src/source/types.js";
import { ApiError } from "./api.js";

export async function inspectSourceWithProgress<T>(path: string, options: RequestInit, onProgress: (progress: SourceInspectionProgress) => void): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api${path}`, { ...options, headers: { ...options.headers, accept: "text/event-stream" } }); }
  catch (cause) { if ((cause as Error).name === "AbortError") throw cause; throw new ApiError("Cannot reach the local Story Studio service. Confirm npm run web is running, then try again."); }
  if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
    const value = await response.json();
    if (!response.ok) throw new ApiError(value.error ?? `Request failed (${response.status})`, value.diagnostic, value.validation);
    return value as T; // Compatibility with a running server that predates streaming.
  }
  if (!response.body) throw new ApiError("Source inspection returned no response stream");
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const lines = frame.split("\n"); const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
        const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const payload = JSON.parse(data);
        if (event === "progress") onProgress(sourceInspectionProgressSchema.parse(payload));
        else if (event === "result") return payload as T;
        else if (event === "error") throw new ApiError(payload.error ?? "Source inspection failed", payload.diagnostic, payload.validation);
      }
      if (done) throw new ApiError("The inspection connection closed before the preview was ready. Try inspection again; existing chapters have not been changed.");
    }
  } finally {
    await reader.cancel().catch(() => undefined); reader.releaseLock();
  }
}
