import { describe, expect, it } from "vitest";
import {
  resolveModelRouting,
  resolveAllModelRoutings,
  CONFIGURABLE_AI_STAGES,
} from "../src/config/model-routing.js";

describe("resolveModelRouting", () => {
  const dummyEnv = {
    OPENAI_API_KEY: "sk-test",
    GEMINI_API_KEY: "gm-test",
    KIMI_API_KEY: "km-test",
    OPENAI_DEFAULT_MODEL: "gpt-5.6-luna",
    GEMINI_DEFAULT_MODEL: "gemini-3.8-flash",
  };

  it("inherits from globalSettings when story has no override", () => {
    const globalSettings = {
      scenePlanner: { provider: "openai" as const, model: "gpt-5.6-luna" },
    };
    const routing = resolveModelRouting({
      stage: "scenePlanner",
      globalSettings,
      env: dummyEnv,
    });
    expect(routing.provider).toBe("openai");
    expect(routing.model).toBe("gpt-5.6-luna");
    expect(routing.source).toBe("application_default");
    expect(routing.isOverride).toBe(false);
    expect(routing.ready).toBe(true);
  });

  it("favors explicit project override over studio default", () => {
    const globalSettings = {
      scenePlanner: { provider: "openai" as const, model: "gpt-5.6-luna" },
    };
    const story = {
      pipeline: {
        scenePlanner: { provider: "openai" as const, model: "gpt-5.6-terra" },
      },
      pipelineOverrides: {
        scenePlanner: true,
      },
    };
    const routing = resolveModelRouting({
      stage: "scenePlanner",
      story,
      globalSettings,
      env: dummyEnv,
    });
    expect(routing.provider).toBe("openai");
    expect(routing.model).toBe("gpt-5.6-terra");
    expect(routing.source).toBe("project");
    expect(routing.isOverride).toBe(true);
    expect(routing.ready).toBe(true);
  });

  it("restores inheritance when pipelineOverrides is explicitly false (reset to default)", () => {
    const globalSettings = {
      scenePlanner: { provider: "openai" as const, model: "gpt-5.6-luna" },
    };
    const story = {
      pipeline: {
        scenePlanner: { provider: "openai" as const, model: "gpt-5.6-terra" },
      },
      pipelineOverrides: {
        scenePlanner: false,
      },
    };
    const routing = resolveModelRouting({
      stage: "scenePlanner",
      story,
      globalSettings,
      env: dummyEnv,
    });
    expect(routing.provider).toBe("openai");
    expect(routing.model).toBe("gpt-5.6-luna");
    expect(routing.source).toBe("application_default");
    expect(routing.isOverride).toBe(false);
  });

  it("detects missing credentials and marks ready=false with actionable reason", () => {
    const routing = resolveModelRouting({
      stage: "scenePlanner",
      globalSettings: {
        scenePlanner: { provider: "openai" as const, model: "gpt-5.6-luna" },
      },
      env: { ...dummyEnv, OPENAI_API_KEY: "" },
    });
    expect(routing.ready).toBe(false);
    expect(routing.reason).toContain("Missing required openai credential (OPENAI_API_KEY)");
  });

  it("detects missing structured output capability if stage requires it", () => {
    const routing = resolveModelRouting({
      stage: "scenePlanner",
      story: {
        pipeline: {
          // Fish does not support structured output
          scenePlanner: { provider: "fish" as any, model: "s2-pro" },
        },
        pipelineOverrides: { scenePlanner: true },
      },
      env: dummyEnv,
    });
    expect(routing.ready).toBe(false);
    expect(routing.reason).toContain("does not support required capability 'structured_output'");
  });

  it("resolves all 5 configurable AI stages", () => {
    const routings = resolveAllModelRoutings(undefined, undefined, dummyEnv);
    expect(Object.keys(routings)).toEqual(CONFIGURABLE_AI_STAGES);
    expect(routings.translation.ready).toBe(true);
    expect(routings.narration.ready).toBe(true);
    expect(routings.qa.ready).toBe(true);
    expect(routings.storyBible.ready).toBe(true);
    expect(routings.scenePlanner.ready).toBe(true);
  });
});

