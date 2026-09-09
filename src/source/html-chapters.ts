import { load } from "cheerio";
import { parseChapterHeading } from "./headings.js";
import { RawChapter, SourceType, SourceWarning, UnnumberedSection } from "./types.js";

export type HtmlExtraction = { chapters: RawChapter[]; unnumberedSections: UnnumberedSection[]; warnings: SourceWarning[] };

export function extractHtmlSections(html: string, sourceId: string, sourceType: SourceType, fallbackTitle?: string, detectPatternParagraphs = false): HtmlExtraction {
  const $ = load(html); $("script,style,nav,noscript,svg").remove();
  const blocks = $("body").find("h1,h2,h3,p,li").toArray().map((element) => ({
    heading: /^h[1-3]$/i.test(element.tagName), text: clean($(element).text()),
  })).filter((block) => block.text);
  if (!blocks.length) {
    const text = clean($("body").text());
    if (text) blocks.push({ heading: false, text });
  }

  const chapters: RawChapter[] = []; const unnumberedSections: UnnumberedSection[] = []; const warnings: SourceWarning[] = [];
  let active: { heading: ReturnType<typeof parseChapterHeading>; lines: string[]; part: number } | undefined;
  const flush = () => {
    if (!active?.heading) return;
    const heading = active.heading;
    chapters.push({
      ref: {
        chapter: heading.chapter, sourceId: active.part ? `${sourceId}#part-${active.part + 1}` : sourceId,
        sourceTitle: fallbackTitle, originalTitle: heading.originalTitle, sourceType,
        metadata: { document: sourceId, title: heading.title },
      },
      text: active.lines.join("\n\n").trim(),
    });
  };
  for (const block of blocks) {
    const heading = block.heading || detectPatternParagraphs ? parseChapterHeading(block.text) : undefined;
    if (heading) { flush(); active = { heading, lines: [block.text], part: chapters.length }; }
    else if (active) active.lines.push(block.text);
  }
  flush();

  if (!chapters.length) {
    const heading = fallbackTitle ? parseChapterHeading(fallbackTitle) : undefined;
    const text = blocks.map((block) => block.text).join("\n\n").trim();
    if (heading && text) chapters.push({
      ref: { chapter: heading.chapter, sourceId, sourceTitle: fallbackTitle, originalTitle: heading.originalTitle, sourceType, metadata: { title: heading.title } }, text,
    });
    else if (text) {
      unnumberedSections.push({ sourceId, title: fallbackTitle });
      warnings.push({ code: "unnumbered_section", message: `Unnumbered section: ${fallbackTitle ?? sourceId}`, sourceId });
    } else warnings.push({ code: "empty_section", message: `Empty section: ${fallbackTitle ?? sourceId}`, sourceId });
  }
  return { chapters, unnumberedSections, warnings };
}

function clean(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
