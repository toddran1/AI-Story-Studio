import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { inspectChapterDirectory } from "../batch/chapter-discovery.js";
import { fingerprint } from "../utils/hash.js";
import { detectTextLanguage, parseChapterHeading } from "./headings.js";
import { chapterWarnings } from "./inspection.js";
import { RawChapter, SourceInspectOptions, SourceInspection, SourceType, StorySourceProvider } from "./types.js";

const ADAPTER_VERSION = "txt-v1";

export class TxtSource implements StorySourceProvider {
  readonly type: SourceType = "text";
  async inspect(sourcePath: string, options: SourceInspectOptions = {}): Promise<SourceInspection> {
    const absolute = resolve(sourcePath); const info = await stat(absolute);
    if (info.isDirectory() && (options.chapter || options.splitChapters)) throw new Error("--chapter and --split-chapters cannot be used with a TXT directory");
    return info.isDirectory() ? this.inspectDirectory(absolute, options) : this.inspectFile(absolute, options);
  }

  private async inspectDirectory(sourcePath: string, options: SourceInspectOptions): Promise<SourceInspection> {
    const report = await inspectChapterDirectory(sourcePath); const sourceType = options.semanticType ?? this.type;
    const chapters: RawChapter[] = await Promise.all(report.chapters.map(async (item) => {
      const text = await readFile(item.path, "utf8"); const first = text.split(/\r?\n/).find((line) => line.trim());
      const heading = first ? parseChapterHeading(first) : undefined;
      return { ref: { chapter: item.chapter, sourceId: item.filename, originalTitle: heading?.originalTitle, sourceType, metadata: {} }, text };
    }));
    const warnings = [
      ...report.invalidFiles.map((name) => ({ code: "invalid_filename" as const, message: `Unrecognized chapter filename: ${name}`, sourceId: name })),
      ...report.emptyFiles.map((name) => ({ code: "empty_section" as const, message: `Empty chapter file: ${name}`, sourceId: name })),
      ...report.duplicateChapters.map((item) => ({ code: "duplicate_chapter_number" as const, message: `Duplicate Chapter ${item.chapter}: ${item.filenames.join(", ")}` })),
      ...(options.allowGaps ? [] : report.missingChapters.length ? [{ code: "chapter_number_gap" as const, message: `Missing chapters: ${report.missingChapters.join(", ")}` }] : []),
    ];
    return finish(sourcePath, sourceType, chapters, warnings, { mode: "directory", allowGaps: options.allowGaps });
  }

  private async inspectFile(sourcePath: string, options: SourceInspectOptions): Promise<SourceInspection> {
    const text = await readFile(sourcePath, "utf8"); const sourceType = options.semanticType ?? this.type;
    let chapters: RawChapter[];
    if (options.splitChapters) chapters = splitText(text, basename(sourcePath), sourceType);
    else {
      const chapter = options.chapter ?? 1; const first = text.split(/\r?\n/).find((line) => line.trim()); const heading = first ? parseChapterHeading(first) : undefined;
      chapters = [{ ref: { chapter, sourceId: basename(sourcePath), originalTitle: heading?.originalTitle, sourceType, metadata: {} }, text }];
    }
    const warnings = [
      ...chapterWarnings(chapters, options.allowGaps),
      ...(!text.trim() ? [{ code: "empty_section" as const, message: `Empty source file: ${basename(sourcePath)}` }] : []),
      ...(options.splitChapters && text.trim() && !chapters.length ? [{ code: "ambiguous_heading" as const, message: "No supported numbered chapter headings were found" }] : []),
    ];
    return finish(sourcePath, sourceType, chapters, warnings, { mode: options.splitChapters ? "split" : "single", chapter: options.chapter });
  }
}

export function splitText(text: string, sourceId: string, sourceType: SourceType = "text"): RawChapter[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n"); const chapters: RawChapter[] = [];
  let active: { heading: NonNullable<ReturnType<typeof parseChapterHeading>>; lines: string[] } | undefined;
  const flush = () => { if (active) chapters.push({
    ref: { chapter: active.heading.chapter, sourceId: `${sourceId}#chapter-${active.heading.chapter}`, originalTitle: active.heading.originalTitle, sourceType, metadata: { title: active.heading.title } },
    text: active.lines.join("\n").trim(),
  }); };
  for (const line of lines) {
    const heading = parseChapterHeading(line);
    if (heading) { flush(); active = { heading, lines: [line.trim()] }; }
    else if (active) active.lines.push(line);
  }
  flush();
  return chapters;
}

function finish(sourcePath: string, sourceType: SourceType, chapters: RawChapter[], warnings: SourceInspection["warnings"], config: unknown): SourceInspection {
  const content = chapters.map((item) => ({ ref: item.ref, text: item.text }));
  return {
    sourcePath, sourceType, title: basename(sourcePath, extname(sourcePath)), language: detectTextLanguage(chapters.map((item) => item.text).join("\n")),
    fingerprint: fingerprint({ adapter: ADAPTER_VERSION, config, content }), chapters, unnumberedSections: [], warnings,
  };
}
