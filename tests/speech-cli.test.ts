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
});
