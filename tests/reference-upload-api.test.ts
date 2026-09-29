import { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { createApiHandler } from "../apps/server/api.js";
import type { StudioOperations } from "../apps/server/operations.js";

it("accepts a reference JSON upload larger than the ordinary 1 MB limit", async () => {
  const image = Buffer.alloc(2 * 1024 * 1024, 1);
  const add = vi.fn().mockResolvedValue({ profile: { references: [{ id: "second" }] }, reference: { id: "second" } });
  const operations = { addVisualReferenceImage: add } as unknown as StudioOperations;
  const req = Object.assign(Readable.from([JSON.stringify({ dataBase64: image.toString("base64"), ext: "png", role: "general_reference" })]), {
    method: "POST", url: `/api/stories/demo/visual-profiles/ent_${"a".repeat(24)}/references`, headers: { host: "localhost:3000", "content-type": "application/json" },
  });
  let status = 0;
  const res = Object.assign(new PassThrough(), { writeHead(code: number) { status = code; } });
  res.resume();
  const done = new Promise<void>((resolve) => res.on("finish", resolve));
  await createApiHandler(operations)(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  await done;
  expect(status).toBe(201);
  expect(add).toHaveBeenCalledWith("demo", `ent_${"a".repeat(24)}`, image, "png", "general_reference", undefined);
});
