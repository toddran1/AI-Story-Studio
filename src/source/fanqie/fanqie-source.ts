import { fingerprint } from "../../utils/hash.js";
import { RawChapter, SourceInspectOptions, SourceInspection, StorySourceProvider } from "../types.js";
import { WebHttpClient } from "../web/http-client.js";
import { parseFanqieBook } from "./book-parser.js";
import { bookIdFromChapterPage, parseFanqieChapter } from "./chapter-parser.js";
import { fanqieBookUrl, parseFanqieUrl } from "./fanqie-url.js";

const ADAPTER_VERSION = "fanqie-v1";

export class FanqieSource implements StorySourceProvider {
  readonly type = "fanqie" as const;
  constructor(private readonly http = new WebHttpClient({ allowedHosts: ["fanqienovel.com", "www.fanqienovel.com"] })) {}

  async inspect(sourcePath: string, options: SourceInspectOptions = {}): Promise<SourceInspection> {
    const parsed = parseFanqieUrl(sourcePath); let bookId = parsed.id;
    if (parsed.kind === "chapter") bookId = bookIdFromChapterPage(await this.http.getText(parsed.url, { refresh: options.refresh }));
    const sourceUrl = fanqieBookUrl(bookId); const book = parseFanqieBook(await this.http.getText(sourceUrl, { refresh: options.refresh }), sourceUrl, bookId);
    if (options.from && options.to && options.from > options.to) throw new Error("--from cannot be greater than --to");
    let requested = options.chapters ? new Set(options.chapters) : undefined; let selected;
    if (!requested && (options.from !== undefined || options.to !== undefined)) {
      const from = options.from ?? 1; const to = options.to ?? book.directory.length;
      if (from > book.directory.length || to > book.directory.length) throw new Error(`Requested range ${from}-${to} exceeds the ${book.directory.length} exposed Fanqie chapters`);
      selected = book.directory.filter((ref) => ref.chapter >= from && ref.chapter <= to);
    }
    if (!requested && !selected && options.probe) selected = book.directory.slice(0, options.probe);
    selected ??= requested ? book.directory.filter((ref) => requested!.has(ref.chapter)) : [];
    if (requested && selected.length !== requested.size) {
      const found = new Set(selected.map((ref) => ref.chapter)); const missing = [...requested].filter((chapter) => !found.has(chapter));
      throw new Error(`Requested chapters are not present in the Fanqie directory: ${missing.join(", ")}`);
    }
    const chapters: RawChapter[] = [];
    for (const ref of selected) {
      const url = String(ref.metadata.url); const parsedChapter = parseFanqieChapter(await this.http.getText(url));
      chapters.push({ ref: { ...ref, originalTitle: parsedChapter.title }, text: parsedChapter.text });
    }
    const now = new Date().toISOString(); const metadata = { title: book.title, author: book.author, description: book.description,
      coverUrl: book.coverUrl, status: book.status, bookId, sourceUrl };
    return {
      sourcePath: sourceUrl, sourceType: this.type, title: book.title, author: book.author, language: "zh-CN",
      fingerprint: fingerprint({ adapter: ADAPTER_VERSION, metadata, directory: book.directory }), chapters, directory: book.directory,
      unnumberedSections: [], warnings: book.chapterCount !== book.directory.length ? [{ code: "unavailable_chapter", message: `Fanqie reports ${book.chapterCount} chapters but exposes ${book.directory.length}` }] : [],
      origin: { url: sourceUrl, bookId }, metadata, remote: { lastInspectedAt: now, chapterCountAtInspection: book.chapterCount }, additive: true,
      adapterVersion: ADAPTER_VERSION,
    };
  }
}
