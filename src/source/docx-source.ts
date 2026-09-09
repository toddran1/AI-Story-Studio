import { basename, resolve } from "node:path";
import mammoth from "mammoth";
import { fingerprint } from "../utils/hash.js";
import { detectTextLanguage } from "./headings.js";
import { extractHtmlSections } from "./html-chapters.js";
import { chapterWarnings } from "./inspection.js";
import { SourceInspectOptions, SourceInspection, StorySourceProvider } from "./types.js";
import { readSafeZip } from "./zip-safety.js";

const ADAPTER_VERSION = "docx-v1";

export class DocxSource implements StorySourceProvider {
  readonly type = "docx" as const;
  async inspect(sourcePath: string, options: SourceInspectOptions = {}): Promise<SourceInspection> {
    const absolute = resolve(sourcePath);
    const { bytes } = await readSafeZip(absolute, false);
    const result = await mammoth.convertToHtml({ buffer: bytes }, { includeDefaultStyleMap: true });
    const extracted = extractHtmlSections(result.value, basename(absolute), this.type, basename(absolute, ".docx"), true);
    const warnings = [...extracted.warnings, ...chapterWarnings(extracted.chapters, options.allowGaps), ...result.messages.map((message) => ({ code: "ambiguous_heading" as const, message: message.message }))];
    return {
      sourcePath: absolute, sourceType: this.type, title: basename(absolute, ".docx"),
      language: detectTextLanguage(extracted.chapters.map((item) => item.text).join("\n")),
      fingerprint: fingerprint({ adapter: ADAPTER_VERSION, html: result.value }), chapters: extracted.chapters,
      unnumberedSections: extracted.unnumberedSections, warnings,
    };
  }
}
