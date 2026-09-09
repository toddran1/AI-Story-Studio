import { load } from "cheerio";
import { ChapterReference } from "../types.js";
import { fanqieChapterUrl } from "./fanqie-url.js";

export type FanqieBook = {
  bookId: string; sourceUrl: string; title: string; author?: string; description?: string; coverUrl?: string; status?: string;
  chapterCount: number; directory: ChapterReference[];
};

export function parseFanqieBook(html: string, sourceUrl: string, bookId: string): FanqieBook {
  const $ = load(html); const title = clean($(".page-header-info h1, h1").first().text());
  if (!title) throw new Error("Fanqie book page is missing its title");
  const author = optional($(".author-name-text, .author-name").first().text());
  const description = optional($(".page-abstract-content").first().text());
  const cover = $(".page-cover img, .page-header img").first().attr("src") ?? $("img").first().attr("src");
  const coverUrl = cover ? normalizeUrl(cover, sourceUrl) : undefined;
  const info = clean($(".info-label").first().text()); const status = /连载中|已完结|完结/.exec(info)?.[0];
  const directory: ChapterReference[] = []; const seen = new Set<string>();
  $(".chapter .chapter-item-title[href*='/reader/'], .chapter-item a[href*='/reader/']").each((_, element) => {
    const href = $(element).attr("href") ?? ""; const id = /\/reader\/(\d+)/.exec(href)?.[1];
    if (!id || seen.has(id)) return; seen.add(id);
    const originalTitle = clean($(element).text()); if (!originalTitle) return;
    const chapter = directory.length + 1; const url = fanqieChapterUrl(id);
    directory.push({ chapter, sourceId: id, sourceTitle: title, originalTitle, sourceType: "fanqie", metadata: { bookId, chapterId: id, url, order: chapter } });
  });
  if (!directory.length) throw new Error("Fanqie book page did not expose a chapter directory");
  const advertised = Number(/目录\s*(\d+)\s*章/.exec(clean($("body").text()))?.[1]);
  return { bookId, sourceUrl, title, author, description, coverUrl, status, chapterCount: Number.isSafeInteger(advertised) && advertised > 0 ? advertised : directory.length, directory };
}

function clean(value: string) { return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim(); }
function optional(value: string) { return clean(value) || undefined; }
function normalizeUrl(value: string, base: string) { return value.startsWith("//") ? `https:${value}` : new URL(value, base).href; }
