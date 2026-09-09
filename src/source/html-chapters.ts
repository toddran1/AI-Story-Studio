import { load } from "cheerio";
import { parseChapterHeading, ParsedHeading } from "./headings.js";
import { RawChapter, SourceType, SourceWarning, UnnumberedSection } from "./types.js";

export type HtmlExtraction = { chapters: RawChapter[]; unnumberedSections: UnnumberedSection[]; warnings: SourceWarning[] };
const MARKER_START = "\u{f0000}CHAPTER:"; const MARKER_END = "\u{f0001}";

export function extractHtmlSections(html: string, sourceId: string, sourceType: SourceType, fallbackTitle?: string, detectPatternParagraphs = false): HtmlExtraction {
  const $ = load(html); $("script,style,nav,noscript,svg").remove(); $("br").replaceWith("\n");
  const headings: ParsedHeading[] = [];
  $(detectPatternParagraphs ? "h1,h2,h3,h4,h5,h6,p" : "h1,h2,h3,h4,h5,h6").each((_, element) => {
    const heading = parseChapterHeading(cleanInline($(element).text())); if (!heading) return;
    const index = headings.push(heading) - 1; $(element).before(`${MARKER_START}${index}${MARKER_END}`);
  });
  $("p,div,section,article,aside,header,footer,h1,h2,h3,h4,h5,h6,li,blockquote,pre,table,tr,td,th").each((_, element) => { $(element).after("\n\n"); });
  const fullText = cleanDocument($("body").text());
  const chapters: RawChapter[] = []; const unnumberedSections: UnnumberedSection[] = []; const warnings: SourceWarning[] = [];
  const marker = new RegExp(`${MARKER_START}(\\d+)${MARKER_END}`, "gu"); const matches = [...fullText.matchAll(marker)];
  if (matches.length) {
    const preamble = cleanDocument(fullText.slice(0, matches[0]!.index));
    if (preamble) {
      unnumberedSections.push({ sourceId: `${sourceId}#preamble`, title: "Content before first numbered chapter" });
      warnings.push({ code: "unnumbered_section", message: `Unnumbered content before the first chapter in ${fallbackTitle ?? sourceId}`, sourceId });
    }
    for (let index = 0; index < matches.length; index++) {
      const match = matches[index]!; const heading = headings[Number(match[1])]!;
      const sectionText = cleanDocument(fullText.slice(match.index! + match[0].length, matches[index + 1]?.index ?? fullText.length));
      const text = removeLeadingHeading(sectionText, heading.originalTitle);
      const sourcePart = matches.length > 1 ? `${sourceId}#part-${index + 1}` : sourceId;
      if (!text) warnings.push({ code: "empty_section", message: `Chapter ${heading.chapter} has a heading but no body text`, sourceId: sourcePart });
      chapters.push({ ref: { chapter: heading.chapter, sourceId: sourcePart, sourceTitle: fallbackTitle, originalTitle: heading.originalTitle, sourceType, metadata: { document: sourceId, title: heading.title } }, text });
    }
  } else {
    const heading = fallbackTitle ? parseChapterHeading(fallbackTitle) : undefined;
    if (heading && fullText) chapters.push({ ref: { chapter: heading.chapter, sourceId, sourceTitle: fallbackTitle, originalTitle: heading.originalTitle, sourceType, metadata: { title: heading.title } }, text: fullText });
    else if (fullText) {
      unnumberedSections.push({ sourceId, title: fallbackTitle });
      warnings.push({ code: "unnumbered_section", message: `Unnumbered section: ${fallbackTitle ?? sourceId}`, sourceId });
    } else warnings.push({ code: "empty_section", message: `Empty section: ${fallbackTitle ?? sourceId}`, sourceId });
  }
  return { chapters, unnumberedSections, warnings };
}

function cleanInline(value: string) { return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim(); }
function cleanDocument(value: string) { return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim(); }
function removeLeadingHeading(text: string, heading: string) { return text.startsWith(heading) ? text.slice(heading.length).trim() : text; }
