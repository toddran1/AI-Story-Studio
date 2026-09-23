// @vitest-environment jsdom
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtDirectionModal } from "../apps/web/src/ArtDirectionModal.js";
import { createArtDirectionPreset, updateArtDirectionPreset } from "../apps/web/src/api.js";
import { createApiHandler } from "../apps/server/api.js";
import { StudioOperations } from "../apps/server/operations.js";
import { loadEnvironment } from "../src/config/env.js";
import { defaultStory } from "../src/config/load-config.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { loadStoryArtDirection } from "../src/visual-canon/art-direction.js";

describe("Art Direction preset modal", () => {
  let root: string;
  let operations: StudioOperations;
  let mount: HTMLDivElement;
  let reactRoot: Root;
  const slug = "modal-preset-story";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "preset-modal-"));
    const env = loadEnvironment({});
    await atomicWriteJson(storyPaths(root, slug, 1).storyConfig, defaultStory(slug, env));
    // These routes only need the story root; bypass unrelated provider setup in jsdom.
    operations = Object.assign(Object.create(StudioOperations.prototype), { root }) as StudioOperations;
    const handler = createApiHandler(operations);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost:3000");
      const req = Object.assign(Readable.from(init?.body ? [String(init.body)] : []), {
        method: init?.method ?? "GET",
        url: url.pathname,
        headers: { host: "localhost:3000", "content-type": "application/json" },
      });
      const chunks: Buffer[] = [];
      let status = 0;
      const res = Object.assign(new PassThrough(), { writeHead(code: number) { status = code; } });
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      const done = new Promise<void>((resolve) => res.on("finish", resolve));
      await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      await done;
      return new Response(Buffer.concat(chunks).toString("utf8"), { status, headers: { "content-type": "application/json" } });
    }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mount = document.createElement("div");
    document.body.appendChild(mount);
    reactRoot = createRoot(mount);
  });

  afterEach(async () => {
    await act(async () => reactRoot.unmount());
    mount.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  function button(label: string) {
    const match = [...mount.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
    if (!match) throw new Error(`Button '${label}' was not found`);
    return match;
  }

  async function click(label: string) {
    await waitFor(() => !button(label).disabled);
    await act(async () => button(label).click());
  }

  async function waitFor(predicate: () => boolean) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    throw new Error(`Modal did not reach the expected state: ${mount.textContent}`);
  }

  function selectedPreset() {
    return mount.querySelector(".preset-item.selected")?.textContent ?? "";
  }

  it("creates, selects, duplicates, deletes, and sets default through the live API contract", async () => {
    await act(async () => reactRoot.render(<ArtDirectionModal slug={slug} onClose={() => undefined} />));
    await waitFor(() => mount.textContent?.includes("Main Style") ?? false);
    expect(mount.textContent).toContain("Main Style");
    expect(button("Delete").disabled).toBe(true);
    expect(button("Delete").title).toBe("At least one Art Direction preset must remain.");

    await click("+ New");
    await waitFor(() => mount.querySelectorAll(".preset-item").length === 2);
    expect(mount.querySelectorAll(".preset-item")).toHaveLength(2);
    expect(selectedPreset()).toContain("Preset 2");
    expect(mount.textContent).not.toContain("Invalid input: expected string");
    expect(button("Delete").disabled).toBe(false);
    const created = (await loadStoryArtDirection(root, slug)).presets.find((preset) => preset.name === "Preset 2")!;
    expect(created.id).toMatch(/^preset_[a-f0-9-]{36}$/);
    expect(created.isDefault).toBe(false);

    const mainStyleItem = [...mount.querySelectorAll<HTMLElement>(".preset-item")].find((item) => item.textContent?.includes("Main Style"))!;
    await act(async () => mainStyleItem.click());
    expect(button("Delete").disabled).toBe(true);
    expect(button("Delete").title).toBe("Set another preset as Story Default before deleting this preset.");
    const createdPresetItem = [...mount.querySelectorAll<HTMLElement>(".preset-item")].find((item) => item.textContent?.includes("Preset 2"))!;
    await act(async () => createdPresetItem.click());
    expect(button("Delete").disabled).toBe(false);

    const nameInput = mount.querySelector<HTMLInputElement>('.preset-main input[type="text"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(nameInput, "Preset 2 Renamed");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Save Art Direction");
    await waitFor(() => mount.querySelector<HTMLButtonElement>(".modal-footer .primary")?.textContent?.trim() === "Save Art Direction");
    expect((await loadStoryArtDirection(root, slug)).presets.find((preset) => preset.id === created.id)?.name).toBe("Preset 2 Renamed");

    await click("Duplicate");
    await waitFor(() => mount.querySelectorAll(".preset-item").length === 3);
    expect(mount.querySelectorAll(".preset-item")).toHaveLength(3);
    expect(selectedPreset()).toContain("Preset 2 Renamed (Copy)");
    const duplicate = (await loadStoryArtDirection(root, slug)).presets.find((preset) => preset.name === "Preset 2 Renamed (Copy)")!;
    expect(duplicate.id).not.toBe(created.id);
    expect(duplicate.isDefault).toBe(false);

    await click("Delete");
    await waitFor(() => mount.querySelectorAll(".preset-item").length === 2);
    expect(mount.querySelectorAll(".preset-item")).toHaveLength(2);
    expect(mount.textContent).not.toContain("Preset 2 Renamed (Copy)");
    expect((await loadStoryArtDirection(root, slug)).presets.some((preset) => preset.id === duplicate.id)).toBe(false);

    const newPresetItem = [...mount.querySelectorAll<HTMLElement>(".preset-item")].find((item) => item.textContent?.includes("Preset 2"))!;
    await act(async () => newPresetItem.click());
    await click("Set as Default");
    await waitFor(() => mount.textContent?.includes("✓ Story Default") ?? false);
    expect(selectedPreset()).toContain("Default");
    expect(mount.textContent).toContain("✓ Story Default");
    const persisted = await loadStoryArtDirection(root, slug);
    expect(persisted.activePresetId).toBe(created.id);
    expect(persisted.presets.filter((preset) => preset.isDefault)).toHaveLength(1);
    expect(button("Delete").disabled).toBe(true);
    expect(button("Delete").title).toBe("Set another preset as Story Default before deleting this preset.");
    await act(async () => mainStyleItem.click());
    expect(button("Delete").disabled).toBe(false);

    await act(async () => reactRoot.unmount());
    reactRoot = createRoot(mount);
    await act(async () => reactRoot.render(<ArtDirectionModal slug={slug} onClose={() => undefined} />));
    await waitFor(() => mount.querySelectorAll(".preset-item").length === 2);
    expect(selectedPreset()).toContain("Preset 2");
    expect(mount.querySelectorAll(".preset-item")).toHaveLength(2);
    expect(button("Delete").disabled).toBe(true);
  });

  it("web API helpers send wrapped editable fields and return the updated state", async () => {
    const created = await createArtDirectionPreset(slug, { name: "API Helper Preset" });
    expect(created.preset.id).toMatch(/^preset_[a-f0-9-]{36}$/);
    expect(created.artDirection.presets).toHaveLength(2);
    const updated = await updateArtDirectionPreset(slug, created.preset.id, { name: "Updated via Helper" });
    expect(updated.presets.find((preset) => preset.id === created.preset.id)?.name).toBe("Updated via Helper");
    expect((await loadStoryArtDirection(root, slug)).presets.find((preset) => preset.id === created.preset.id)?.name).toBe("Updated via Helper");
  });
});
