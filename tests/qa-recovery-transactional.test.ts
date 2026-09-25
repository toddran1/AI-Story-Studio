import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadEnvironment } from "../src/config/env.js";
import { ChapterPipeline } from "../src/pipeline/chapter-pipeline.js";
import { LLMRouter } from "../src/llm/router.js";
import { TTSProviderRouter } from "../src/tts/router.js";
import { createBlankStory } from "../src/studio/projects.js";
import { storyPaths } from "../src/storage/paths.js";
import { atomicWrite } from "../src/storage/atomic-write.js";
import { MockLLM, MockTTS } from "./helpers.js";
import { QaResult, qaIssueSchema } from "../src/domain/qa.js";

type QaIssue = z.infer<typeof qaIssueSchema>;

const makeIssues = (count: number, severity: "warn" | "fail" = "warn"): QaIssue[] =>
  Array.from({ length: count }, (_, i) => ({
    category: "terminology",
    severity,
    message: `Issue number ${i + 1}`,
    evidence: `Evidence for issue ${i + 1}`,
  }));

describe("transactional QA auto-recovery", () => {
  it("preserves prior translation, narration, and QA artifacts when recovery fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-recovery-test-"));
    const env = loadEnvironment({});
    const story = await createBlankStory(root, env, { title: "QA Story", slug: "qa-story" });
    const paths = storyPaths(root, story.slug, 1);

    const initialSource = "第一章 初始内容";
    await atomicWrite(paths.original, initialSource);

    // Initial run produces 5 QA issues (triggering recovery)
    const badQaResponse: QaResult = {
      status: "warn",
      score: 0.7,
      issues: makeIssues(5, "warn"),
      checks: {
        completeness: "warn",
        names: "pass",
        numbers: "pass",
        terminology: "warn",
        dialogue: "pass",
        storyConsistency: "pass",
        narrationFidelity: "pass",
      },
    };

    let translationAttempts = 0;
    const llm = new MockLLM("gemini", ["Translation attempt 1", "Narration attempt 1"], badQaResponse);
    const originalGenerateText = llm.generateText.bind(llm);
    llm.generateText = async (request) => {
      translationAttempts++;
      if (translationAttempts === 3) {
        // Translation attempt 1 was call 1
        // Narration attempt 1 was call 2
        // Call 3 is recovery translation attempt!
        throw new Error("Simulated LLM rate limit during recovery translation");
      }
      return originalGenerateText(request);
    };

    const router = new LLMRouter(new Map([["gemini", llm], ["openai", llm]]));
    const pipeline = new ChapterPipeline(router, new TTSProviderRouter(new Map([["fish", new MockTTS()]])));

    // Run the pipeline; the recovery attempt will fail
    await expect(
      pipeline.run({
        root,
        story,
        chapter: 1,
        inputPath: paths.original,
        stopAfter: "qa",
      })
    ).rejects.toThrow("Simulated LLM rate limit during recovery translation");

    // CRITICAL: The prior English, narration, and QA files MUST NOT have been deleted
    const englishText = await readFile(paths.english, "utf8");
    const narrationText = await readFile(paths.narration, "utf8");
    const qaRaw = await readFile(paths.qa, "utf8");

    expect(englishText).toBe("Translation attempt 1");
    expect(narrationText).toBe("Narration attempt 1");
    expect(JSON.parse(qaRaw).status).toBe("warn");

    // Metadata should record QA failure without destroying previous stage metadata
    const metaRaw = JSON.parse(await readFile(paths.chapterMeta, "utf8"));
    expect(metaRaw.stages.translation.status).toBe("complete");
    expect(metaRaw.stages.narration.status).toBe("complete");
    expect(metaRaw.stages.qa.status).toBe("failed");
    expect(metaRaw.stages.qa.error.message).toContain("Simulated LLM rate limit during recovery translation");
  });

  it("replaces artifacts cleanly when recovery succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-recovery-success-"));
    const env = loadEnvironment({});
    const story = await createBlankStory(root, env, { title: "QA Story", slug: "qa-story" });
    const paths = storyPaths(root, story.slug, 1);

    const initialSource = "第一章 初始内容";
    await atomicWrite(paths.original, initialSource);

    const badQaResponse: QaResult = {
      status: "warn",
      score: 0.6,
      issues: makeIssues(5, "warn"),
      checks: {
        completeness: "warn",
        names: "pass",
        numbers: "pass",
        terminology: "warn",
        dialogue: "pass",
        storyConsistency: "pass",
        narrationFidelity: "pass",
      },
    };

    const goodQaResponse: QaResult = {
      status: "pass",
      score: 1.0,
      issues: [],
      checks: {
        completeness: "pass",
        names: "pass",
        numbers: "pass",
        terminology: "pass",
        dialogue: "pass",
        storyConsistency: "pass",
        narrationFidelity: "pass",
      },
    };

    let qaCallCount = 0;
    const llm = new MockLLM("gemini", [
      "Initial English translation",
      "Initial English narration",
      "Recovered English translation",
      "Recovered English narration",
    ]);

    const originalGenerateStructured = llm.generateStructured.bind(llm);
    llm.generateStructured = async (request) => {
      if (request.schemaName === "chapter_qa") {
        qaCallCount++;
        const qaData = qaCallCount === 1 ? badQaResponse : goodQaResponse;
        return { value: request.schema.parse(qaData), usage: { inputTokens: 10, outputTokens: 5 } };
      }
      return originalGenerateStructured(request);
    };

    const router = new LLMRouter(new Map([["gemini", llm], ["openai", llm]]));
    const pipeline = new ChapterPipeline(router, new TTSProviderRouter(new Map([["fish", new MockTTS()]])));

    const result = await pipeline.run({
      root,
      story,
      chapter: 1,
      inputPath: paths.original,
      stopAfter: "qa",
    });

    expect(qaCallCount).toBe(2);
    expect(result.stages.qa.status).toBe("complete");
    expect(result.quality?.status).toBe("pass");

    const finalEnglish = await readFile(paths.english, "utf8");
    const finalNarration = await readFile(paths.narration, "utf8");
    expect(finalEnglish).toBe("Recovered English translation");
    expect(finalNarration).toBe("Recovered English narration");
  });
});

