// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorHistoryChapterHeading } from "../apps/web/src/App.js";
import { createErrorDiagnostic } from "../src/errors/diagnostic.js";
describe("error history chapter headings", () => {
  it("shows a titled chapter link even for a generic provider error", () => {
    const diagnostic = { ...createErrorDiagnostic(new Error("Connection error"), {chapter:271, stage:"tts"}), chapterTitle:"The hidden path" };
    const html = renderToStaticMarkup(<ErrorHistoryChapterHeading slug="test-story" diagnostic={diagnostic} />);
    expect(html).toContain("Chapter 271 — The hidden path"); expect(html).toContain('/stories/test-story/chapters/271');
  });
  it("labels missing metadata instead of guessing a chapter", () => {
    const diagnostic = createErrorDiagnostic(new Error("Connection error"));
    expect(renderToStaticMarkup(<ErrorHistoryChapterHeading slug="test-story" diagnostic={diagnostic} />)).toContain("Chapter not recorded");
    expect(renderToStaticMarkup(<ErrorHistoryChapterHeading slug="test-story" diagnostic={{...diagnostic,chapter:275}} />)).toContain("Title unavailable");
  });
});
