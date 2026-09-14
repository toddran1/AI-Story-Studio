import { describe, expect, it } from "vitest";
import { parseBibleArgs } from "../apps/cli/bible.js";
import { parseContinuityArgs } from "../apps/cli/continuity.js";
import { runSources } from "../apps/cli/sources.js";

describe("administration CLI contracts", () => {
  it("parses Story Bible edits as a shared-service patch", () => {
    expect(parseBibleArgs(["edit", "demo-story", "ent_0123456789abcdef01234567", "--json", '{"canonicalName":"Hero"}'])).toMatchObject({ action: "edit", story: "demo-story", patch: { canonicalName: "Hero" } });
  });
  it("maps human continuity resolutions to the web operation values", () => {
    expect(parseContinuityArgs(["resolve", "demo-story", "ctf_0123456789abcdef01234567", "--action", "keep-canonical"])).toMatchObject({ action: "resolve", resolution: "kept_existing" });
  });
  it("uses the source registry for provider toggles", async () => {
    const calls: unknown[] = [];
    await runSources(["disable", "ixdzs8"], { novelProviders: () => [], diagnoseNovelProvider: async () => ({}), setNovelProviderEnabled: (id: string, input: unknown) => { calls.push([id, input]); return { id }; }, searchNovelSources: async () => [], updateNovelSourcePriorities: async () => ({}) } as never, () => undefined);
    expect(calls).toEqual([["ixdzs8", { enabled: false }]]);
  });
});
