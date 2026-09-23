import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiHandler } from "../apps/server/api.js";
import { StudioOperations } from "../apps/server/operations.js";
import { loadEnvironment } from "../src/config/env.js";
import { defaultStory } from "../src/config/load-config.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";

describe("Story Art Direction preset HTTP contract", () => {
  let root: string;
  let operations: StudioOperations;
  const slug = "preset-contract";
  const base = `/api/stories/${slug}/art-direction`;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "preset-contract-"));
    const env = loadEnvironment({});
    await atomicWriteJson(storyPaths(root, slug, 1).storyConfig, defaultStory(slug, env));
    operations = new StudioOperations(root, env);
  });

  afterEach(async () => {
    await operations.close();
    await rm(root, { recursive: true, force: true });
  });

  async function request(method: string, path: string, input?: unknown) {
    const handler = createApiHandler(operations);
    const chunks: Buffer[] = [];
    let status = 0;
    const req = Object.assign(Readable.from(input === undefined ? [] : [JSON.stringify(input)]), {
      method,
      url: path,
      headers: { host: "localhost:3000", "content-type": "application/json" },
    });
    const res = Object.assign(new PassThrough(), {
      writeHead(code: number) { status = code; },
    });
    res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const done = new Promise<void>((resolve) => res.on("finish", resolve));
    await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    await done;
    return { status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  }

  it("creates, updates, duplicates, changes the default, and deletes with complete response shapes", async () => {
    const original = await request("GET", base);
    expect(original.status).toBe(200);
    expect(original.body.presets).toEqual([expect.objectContaining({ id: "preset_main_style", name: "Main Style", isDefault: true })]);

    const created = await request("POST", `${base}/presets`, { preset: { name: "Preset 2" } });
    expect(created.status).toBe(201);
    expect(created.body.preset).toMatchObject({ name: "Preset 2", isDefault: false, artStyle: "Manhwa" });
    expect(created.body.preset.id).toMatch(/^preset_[a-f0-9-]{36}$/);
    expect(created.body.preset).toHaveProperty("createdAt");
    expect(created.body.artDirection).toMatchObject({ activePresetId: "preset_main_style", updatedAt: expect.any(String) });
    expect(created.body.artDirection.presets).toHaveLength(2);
    expect(created.body.artDirection.presets.filter((preset: { isDefault: boolean }) => preset.isDefault)).toHaveLength(1);
    const id = created.body.preset.id as string;

    const updated = await request("PUT", `${base}/presets/${id}`, { preset: { name: "Renamed Preset", visualTone: "Quiet" } });
    expect(updated.status).toBe(200);
    expect(updated.body.presets.find((preset: { id: string }) => preset.id === id)).toMatchObject({ id, name: "Renamed Preset", visualTone: "Quiet" });

    const duplicated = await request("POST", `${base}/presets/${id}/duplicate`, {});
    expect(duplicated.status).toBe(200);
    expect(duplicated.body.preset).toMatchObject({ name: "Renamed Preset (Copy)", isDefault: false });
    expect(duplicated.body.preset.id).not.toBe(id);
    expect(duplicated.body.artDirection.presets).toHaveLength(3);
    const duplicateId = duplicated.body.preset.id as string;

    const defaultChanged = await request("POST", `${base}/presets/${duplicateId}/default`, {});
    expect(defaultChanged.status).toBe(200);
    expect(defaultChanged.body.activePresetId).toBe(duplicateId);
    expect(defaultChanged.body.updatedAt).not.toBe(duplicated.body.artDirection.updatedAt);
    expect(defaultChanged.body.presets.filter((preset: { isDefault: boolean }) => preset.isDefault)).toEqual([expect.objectContaining({ id: duplicateId })]);

    const deleted = await request("DELETE", `${base}/presets/${id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.presets.map((preset: { id: string }) => preset.id)).not.toContain(id);
    expect(deleted.body.activePresetId).toBe(duplicateId);
    expect((await request("GET", base)).body).toEqual(deleted.body);
  });

  it("rejects invalid names and client-owned preset metadata with structured field errors", async () => {
    const empty = await request("POST", `${base}/presets`, { preset: { name: "   " } });
    expect(empty.status).toBe(400);
    expect(empty.body.validation).toContainEqual(expect.objectContaining({ path: "preset.name" }));

    const missing = await request("POST", `${base}/presets`, { preset: {} });
    expect(missing.status).toBe(400);
    expect(missing.body.validation).toContainEqual(expect.objectContaining({ path: "preset.name" }));

    const forged = await request("POST", `${base}/presets`, { preset: { name: "Forged", id: "preset_user", isDefault: true } });
    expect(forged.status).toBe(400);
    expect(forged.body.validation).toEqual(expect.arrayContaining([expect.objectContaining({ path: "preset" })]));

    const immutable = await request("PUT", `${base}/presets/preset_main_style`, { preset: { id: "preset_other", name: "Changed" } });
    expect(immutable.status).toBe(400);
    expect(immutable.body.validation).toEqual(expect.arrayContaining([expect.objectContaining({ path: "preset" })]));
    expect((await request("GET", base)).body.presets[0]).toMatchObject({ id: "preset_main_style", name: "Main Style" });
  });
});
