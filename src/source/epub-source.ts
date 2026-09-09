import { readFile } from "node:fs/promises";
import { basename, posix, resolve } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import { fingerprint } from "../utils/hash.js";
import { extractHtmlSections } from "./html-chapters.js";
import { chapterWarnings } from "./inspection.js";
import { SourceInspectOptions, SourceInspection, SourceWarning, StorySourceProvider } from "./types.js";

const ADAPTER_VERSION = "epub-v1";
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", removeNSPrefix: true });

export class EpubSource implements StorySourceProvider {
  readonly type = "epub" as const;
  async inspect(sourcePath: string, options: SourceInspectOptions = {}): Promise<SourceInspection> {
    const absolute = resolve(sourcePath); const bytes = await readFile(absolute); const archive = unzipSync(bytes);
    const entries = new Map(Object.entries(archive).map(([name, data]) => [normalize(name), data]));
    const container = textEntry(entries, "META-INF/container.xml");
    const containerDoc = xml.parse(container) as Record<string, unknown>;
    const rootfiles = arrayAt(containerDoc, ["container", "rootfiles", "rootfile"]);
    const opfPath = stringValue(rootfiles[0], "full-path");
    if (!opfPath) throw new Error("EPUB container does not identify a package document");
    const opfText = textEntry(entries, opfPath); const opf = xml.parse(opfText) as Record<string, unknown>;
    const pkg = recordAt(opf, ["package"]); const metadata = recordAt(pkg, ["metadata"]);
    const title = metadataValue(metadata, "title"); const author = metadataValue(metadata, "creator"); const language = metadataValue(metadata, "language");
    const manifestItems = arrayAt(pkg, ["manifest", "item"]); const byId = new Map<string, unknown>();
    for (const item of manifestItems) { const id = stringValue(item, "id"); if (id) byId.set(id, item); }
    const spineRefs = arrayAt(pkg, ["spine", "itemref"]); const packageDir = posix.dirname(normalize(opfPath));
    const tocTitles = this.tocTitles(entries, manifestItems, packageDir);
    const chapters: SourceInspection["chapters"] = []; const unnumberedSections: SourceInspection["unnumberedSections"] = []; const warnings: SourceWarning[] = [];
    for (const ref of spineRefs) {
      const item = byId.get(stringValue(ref, "idref") ?? ""); if (!item) continue;
      const href = stringValue(item, "href"); if (!href) continue;
      const entryPath = normalize(posix.join(packageDir, stripFragment(href)));
      const mediaType = stringValue(item, "media-type") ?? ""; const properties = stringValue(item, "properties") ?? "";
      if (properties.split(/\s+/).includes("nav") || !/html|xhtml/i.test(mediaType)) continue;
      const entry = entries.get(entryPath); if (!entry) { warnings.push({ code: "unsupported_epub_structure", message: `Spine item is missing: ${entryPath}`, sourceId: entryPath }); continue; }
      const html = strFromU8(entry); const fallbackTitle = tocTitles.get(entryPath) ?? documentTitle(html);
      const extracted = extractHtmlSections(html, entryPath, this.type, fallbackTitle);
      chapters.push(...extracted.chapters); unnumberedSections.push(...extracted.unnumberedSections); warnings.push(...extracted.warnings);
    }
    warnings.push(...chapterWarnings(chapters, options.allowGaps));
    for (const [field, value] of [["title", title], ["author", author], ["language", language]] as const) if (!value) warnings.push({ code: "missing_metadata", message: `EPUB metadata is missing ${field}` });
    if (!spineRefs.length) warnings.push({ code: "unsupported_epub_structure", message: "EPUB package has no readable spine" });
    return {
      sourcePath: absolute, sourceType: this.type, title: title ?? basename(absolute, ".epub"), author, language,
      fingerprint: fingerprint({ adapter: ADAPTER_VERSION, bytes: bytes.toString("base64") }), chapters,
      unnumberedSections, warnings,
    };
  }

  private tocTitles(entries: Map<string, Uint8Array>, items: unknown[], packageDir: string): Map<string, string> {
    const titles = new Map<string, string>();
    for (const item of items) {
      const href = stringValue(item, "href"); if (!href) continue;
      const properties = stringValue(item, "properties") ?? ""; const mediaType = stringValue(item, "media-type") ?? "";
      if (!properties.split(/\s+/).includes("nav") && mediaType !== "application/x-dtbncx+xml") continue;
      const tocPath = normalize(posix.join(packageDir, stripFragment(href))); const entry = entries.get(tocPath); if (!entry) continue;
      const $ = load(strFromU8(entry), { xmlMode: mediaType.includes("ncx") });
      $("a[href]").each((_, element) => {
        const target = $(element).attr("href"); const label = $(element).text().replace(/\s+/g, " ").trim();
        if (target && label) titles.set(normalize(posix.join(posix.dirname(tocPath), stripFragment(target))), label);
      });
      $("navPoint").each((_, element) => {
        const target = $(element).find("content").first().attr("src"); const label = $(element).find("navLabel text").first().text().replace(/\s+/g, " ").trim();
        if (target && label) titles.set(normalize(posix.join(posix.dirname(tocPath), stripFragment(target))), label);
      });
    }
    return titles;
  }
}

function textEntry(entries: Map<string, Uint8Array>, path: string): string {
  const entry = entries.get(normalize(path)); if (!entry) throw new Error(`EPUB entry is missing: ${path}`);
  return strFromU8(entry);
}
function normalize(path: string) { return posix.normalize(path.replace(/\\/g, "/")).replace(/^\.\//, ""); }
function stripFragment(path: string) { return decodeURIComponent(path.split("#", 1)[0]!); }
function asRecord(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function recordAt(value: unknown, path: string[]): Record<string, unknown> {
  let current: unknown = value; for (const key of path) current = asRecord(current)?.[key]; return asRecord(current) ?? {};
}
function arrayAt(value: unknown, path: string[]): unknown[] {
  let current: unknown = value; for (const key of path) current = asRecord(current)?.[key]; return current === undefined ? [] : Array.isArray(current) ? current : [current];
}
function stringValue(value: unknown, key: string): string | undefined { const result = asRecord(value)?.[key]; return typeof result === "string" || typeof result === "number" ? String(result).trim() : undefined; }
function metadataValue(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key]; const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === "string" || typeof first === "number") return String(first).trim();
  return stringValue(first, "#text") ?? stringValue(first, "text");
}
function documentTitle(html: string): string | undefined { const $ = load(html); return $("h1,h2,h3,title").first().text().replace(/\s+/g, " ").trim() || undefined; }
