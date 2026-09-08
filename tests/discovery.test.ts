import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverChapters, inspectChapterDirectory } from "../src/batch/chapter-discovery.js";

async function fixture(files: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), "discovery-"));
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(directory, name), content, "utf8")));
  return directory;
}

describe("chapter discovery", () => {
  it("recognizes variants and sorts numerically", async () => {
    const directory = await fixture({ "chapter-10.txt": "十", "Chapter 2.txt": "二", "0001.txt": "一", "notes.md": "ignored" });
    expect((await discoverChapters(directory, true)).map((item) => item.chapter)).toEqual([1, 2, 10]);
  });
  it("rejects duplicates", async () => {
    const directory = await fixture({ "chapter-001.txt": "一", "1.txt": "一" });
    await expect(discoverChapters(directory)).rejects.toThrow(/Duplicate Chapter 1/);
  });
  it("reports invalid names, empty files, and missing chapters", async () => {
    const directory = await fixture({ "chapter-1.txt": "一", "chapter-3.txt": "三", "prologue.txt": "text", "chapter-4.txt": "  " });
    const report = await inspectChapterDirectory(directory);
    expect(report.invalidFiles).toEqual(["prologue.txt"]);
    expect(report.emptyFiles).toEqual(["chapter-4.txt"]);
    expect(report.missingChapters).toEqual([2]);
  });
  it("rejects an empty directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "discovery-empty-")); await mkdir(directory, { recursive: true });
    await expect(discoverChapters(directory)).rejects.toThrow(/No supported chapter/);
  });
});
