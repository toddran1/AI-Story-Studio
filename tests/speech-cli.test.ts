import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSpeech } from "../apps/cli/speech.js";
import { testStory } from "./helpers.js";
import { storyPaths } from "../src/storage/paths.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("story:speech", () => {
  it("uses the production normalization service to inspect narration without editing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "speech-cli-")); roots.push(root); const story = testStory(); const paths = storyPaths(root, story.slug, 4);
    await atomicWriteJson(paths.storyConfig, story); await atomicWrite(paths.narration, "Asher watches the clock reach 23:57.");
    let output = ""; await runSpeech(["normalize", story.slug, "4", "--json"], root, value => { output += value; });
    expect(JSON.parse(output)).toMatchObject({ narrationText: "Asher watches the clock reach 23:57.", spokenText: "Asher watches the clock reach eleven fifty-seven p.m." });
  });

  it("reports vocalizations with the configured provider strategy in --json output", async () => {
    const root = await mkdtemp(join(tmpdir(), "speech-cli-")); roots.push(root); const story = testStory(); const paths = storyPaths(root, story.slug, 4);
    const narration = "Hahaha... Brat, once my fiend dragon comes out, all your bullshit undead are nothing but ants!";
    await atomicWriteJson(paths.storyConfig, story); await atomicWrite(paths.narration, narration);
    let output = ""; await runSpeech(["normalize", story.slug, "4", "--json"], root, value => { output += value; });
    const parsed = JSON.parse(output);
    // The story config uses Fish s2-pro, so the laugh is rendered with the native tag.
    expect(parsed.vocalizations).toEqual([{ sourceText: "Hahaha...", type: "laugh", intensity: "light", confidence: 0.9, strategy: "native_tags", spoken: "[laugh]" }]);
    expect(parsed.spokenText).toBe(`[laugh]${narration.slice("Hahaha...".length)}`);
  });

  it("supports --vocalizations as a focused view, including combined with --json", async () => {
    const root = await mkdtemp(join(tmpdir(), "speech-cli-")); roots.push(root); const story = testStory(); const paths = storyPaths(root, story.slug, 4);
    await atomicWriteJson(paths.storyConfig, story); await atomicWrite(paths.narration, "Hahaha... Brat, you are finished!");
    let text = ""; await runSpeech(["normalize", story.slug, "4", "--vocalizations"], root, value => { text += value; });
    expect(text).toContain("Vocalizations"); expect(text).toContain("Hahaha... — laugh · intensity light"); expect(text).toContain("native_tags → [laugh]");
    let json = ""; await runSpeech(["normalize", story.slug, "4", "--vocalizations", "--json"], root, value => { json += value; });
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed)).toEqual(["vocalizations"]);
    expect(parsed.vocalizations[0]).toMatchObject({ sourceText: "Hahaha...", type: "laugh", strategy: "native_tags", spoken: "[laugh]" });
  });
});
