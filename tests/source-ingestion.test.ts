import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { DocxSource } from "../src/source/docx-source.js";
import { EpubSource } from "../src/source/epub-source.js";
import { importSource, loadImportedChapters } from "../src/source/importer.js";
import { SourceProviderRegistry } from "../src/source/registry.js";
import { splitText, TxtSource } from "../src/source/txt-source.js";
import { sourceManifestSchema } from "../src/source/types.js";
import { readSafeZip } from "../src/source/zip-safety.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";

describe("source ingestion", () => {
  it("splits English and Chinese multi-chapter TXT without lexicographic ordering", () => {
    const english = splitText("Chapter 1: One\nA\nChapter 10 — Ten\nJ\nChapter 2 Two\nB", "book.txt");
    expect(english.map((item) => item.ref.chapter)).toEqual([1, 10, 2]);
    expect(english[0]?.ref.originalTitle).toBe("Chapter 1: One");
    const chinese = splitText("第一章 开始\n甲\n第2章 继续\n乙\n第10章 结尾\n十", "书.txt");
    expect(chinese.map((item) => item.ref.chapter)).toEqual([1, 2, 10]);
    expect(chinese[0]?.ref.metadata.title).toBe("开始");
  });

  it("inspects EPUB metadata, spine chapters, cleaned paragraphs, and unnumbered content", async () => {
    const root = await mkdtemp(join(tmpdir(), "source-epub-")); const path = join(root, "tiny.epub");
    await writeFile(path, tinyEpub());
    const report = await new EpubSource().inspect(path);
    expect(report).toMatchObject({ title: "Tiny Novel", author: "Studio Test", language: "en", sourceType: "epub" });
    expect(report.chapters.map((item) => item.ref.chapter)).toEqual([1, 2]);
    expect(report.chapters[0]?.text).toContain("First paragraph.\n\nDialogue follows.");
    expect(report.chapters[0]?.text).toContain("Text in a div.");
    expect(report.chapters[0]?.text).toContain("Quoted text.");
    expect(report.chapters[0]?.text).toContain("Table text");
    expect(report.chapters[0]?.text).not.toContain("Chapter 1: Arrival");
    expect(report.unnumberedSections).toContainEqual(expect.objectContaining({ title: "Preface" }));
    expect(report.warnings.some((warning) => warning.code === "unnumbered_section")).toBe(true);
  });

  it("splits DOCX Heading 1 chapters and preserves paragraph order", async () => {
    const root = await mkdtemp(join(tmpdir(), "source-docx-")); const path = join(root, "tiny.docx");
    await writeFile(path, tinyDocx());
    const report = await new DocxSource().inspect(path);
    expect(report.chapters.map((item) => item.ref.chapter)).toEqual([1, 2]);
    expect(report.chapters[0]?.ref.originalTitle).toBe("Chapter 1: Arrival");
    expect(report.chapters[0]?.text).toContain("The first paragraph.\n\nThe second paragraph.");
  });

  it("detects DOCX chapter patterns even when heading styles are absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "source-docx-plain-")); const path = join(root, "plain.docx");
    await writeFile(path, tinyDocx(false));
    const report = await new DocxSource().inspect(path);
    expect(report.chapters.map((item) => item.ref.chapter)).toEqual([1, 2]);
  });

  it("selects providers and imports atomically with unchanged and changed detection", async () => {
    const root = await mkdtemp(join(tmpdir(), "source-import-")); const source = join(root, "novel.txt");
    await writeFile(source, "Chapter 1\nOriginal", "utf8"); const registry = new SourceProviderRegistry();
    expect((await registry.resolve(source)).semanticType).toBe("text");
    const firstInspection = await new TxtSource().inspect(source, { splitChapters: true });
    const first = await importSource(root, "novel", firstInspection); expect(first.status).toBe("imported");
    const unchanged = await importSource(root, "novel", firstInspection); expect(unchanged.status).toBe("unchanged");
    await writeFile(source, "Chapter 1\nRevised\nChapter 2\nAdded", "utf8");
    const changedInspection = await new TxtSource().inspect(source, { splitChapters: true });
    const changed = await importSource(root, "novel", changedInspection);
    expect(changed).toMatchObject({ status: "updated", added: [2], modified: [1], removed: [] });
    const loaded = await loadImportedChapters(root, "novel"); expect(loaded.chapters).toHaveLength(2);
    const manifest = sourceManifestSchema.parse(JSON.parse(await readFile(join(root, "stories/novel/source/source.json"), "utf8")));
    expect(manifest.fingerprint).toBe(changedInspection.fingerprint);
    expect(await readFile(join(root, "stories/novel/source/chapters/0001.txt"), "utf8")).toContain("Revised");
    expect(() => sourceManifestSchema.parse({ ...manifest, chapters: [{ ...manifest.chapters[0]!, ref: { ...manifest.chapters[0]!.ref, chapter: 2 } }] })).toThrow(/Reference chapter/);
    await writeFile(join(root, "stories/novel/source/chapters/0001.txt"), "tampered", "utf8");
    expect((await importSource(root, "novel", changedInspection)).status).toBe("updated");
    expect(await readFile(join(root, "stories/novel/source/chapters/0001.txt"), "utf8")).toContain("Revised");
    const broken = { ...changedInspection, fingerprint: "broken", chapters: [{ ...changedInspection.chapters[0]!, text: "" }] };
    await expect(importSource(root, "novel", broken)).rejects.toThrow(/empty/);
    expect(await readFile(join(root, "stories/novel/source/chapters/0001.txt"), "utf8")).toContain("Revised");
  });

  it("restores the previous source when finalization fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "source-rollback-")); const source = join(root, "novel.txt"); const provider = new TxtSource();
    await writeFile(source, "Chapter 1\nOriginal", "utf8");
    await importSource(root, "novel", await provider.inspect(source, { splitChapters: true }));
    const chapterPath = storyPaths(root, "novel", 1).chapterMeta; const now = new Date().toISOString(); const complete = { status: "complete" as const, fingerprint: "before", outputFingerprint: "before-output" };
    await atomicWriteJson(chapterPath, chapterSchema.parse({ chapter: 1, sourceLanguage: "en", outputLanguage: "en", counts: { originalCharacters: 8, englishWords: 1, narrationWords: 1 }, createdAt: now, updatedAt: now, stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: complete, tts: complete } })); const previousMetadata = await readFile(chapterPath, "utf8");
    await writeFile(source, "Chapter 1\nReplacement", "utf8");
    await expect(importSource(root, "novel", await provider.inspect(source, { splitChapters: true }), async () => { throw new Error("config failed"); })).rejects.toThrow("config failed");
    expect(await readFile(join(root, "stories/novel/source/chapters/0001.txt"), "utf8")).toContain("Original");
    expect(await readFile(chapterPath, "utf8")).toBe(previousMetadata);
  });

  it("rejects a compressed archive whose expanded entry is too large", async () => {
    const root = await mkdtemp(join(tmpdir(), "source-zip-limit-")); const path = join(root, "oversized.zip");
    await writeFile(path, Buffer.from(zipSync({ "large.txt": new Uint8Array(25 * 1024 * 1024 + 1) })));
    await expect(readSafeZip(path)).rejects.toThrow(/entry 'large.txt' exceeds 25 MB/);
  });
});

function tinyEpub(): Buffer {
  return Buffer.from(zipSync({
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
    "OEBPS/content.opf": strToU8(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Tiny Novel</dc:title><dc:creator>Studio Test</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="p" href="preface.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="p"/><itemref idref="c1"/><itemref idref="c2"/></spine></package>`),
    "OEBPS/nav.xhtml": strToU8(`<html><body><nav><ol><li><a href="preface.xhtml">Preface</a></li><li><a href="c1.xhtml">Chapter 1: Arrival</a></li><li><a href="c2.xhtml">Chapter 2: City</a></li></ol></nav></body></html>`),
    "OEBPS/preface.xhtml": strToU8(`<html><body><h1>Preface</h1><p>A note.</p></body></html>`),
    "OEBPS/c1.xhtml": strToU8(`<html><body><h1>Chapter 1: Arrival</h1><p>First paragraph.</p><p>Dialogue follows.</p><div>Text in a div.</div><blockquote>Quoted text.</blockquote><table><tr><td>Table text</td></tr></table><script>bad()</script></body></html>`),
    "OEBPS/c2.xhtml": strToU8(`<html><body><h1>Chapter 2: City</h1><p>Second chapter.</p></body></html>`),
  }));
}

function tinyDocx(styled = true): Buffer {
  const p = (text: string, heading = false) => `<w:p>${heading ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : ""}<w:r><w:t>${text}</w:t></w:r></w:p>`;
  return Buffer.from(zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/styles.xml": strToU8(`<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`),
    "word/_rels/document.xml.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`),
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p("Chapter 1: Arrival", styled)}${p("The first paragraph.")}${p("The second paragraph.")}${p("第2章 城市", styled)}${p("城市中的正文。")}<w:sectPr/></w:body></w:document>`),
  }));
}
