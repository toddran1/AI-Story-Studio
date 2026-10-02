import { fingerprint } from "../utils/hash.js";
import { chapterProvenance, NovelSourceProvider } from "./novel-provider.js";
import { RawChapter, SourceInspectOptions, SourceInspection, SourceType, SourceWarning } from "./types.js";
import { splitText } from "./txt-source.js";
import { SourceValidationError } from "./errors.js";

export async function inspectNovelProvider(provider: NovelSourceProvider, sourcePath: string, options: SourceInspectOptions = {}, adapterVersion: string): Promise<SourceInspection> {
  if (options.from !== undefined && options.to !== undefined && options.from > options.to) throw new SourceValidationError("--from cannot be greater than --to");
  options.signal?.throwIfAborted();
  options.onProgress?.({ phase: "metadata", provider: provider.id });
  const book = await provider.getBook(sourcePath, options);
  options.signal?.throwIfAborted();
  options.onProgress?.({ phase: "directory", provider: provider.id, pagesChecked: 0 });
  const directory = await provider.getChapterList(book, options);
  if (!directory.length) throw new Error(`${provider.displayName} exposed an empty chapter directory`);
  const minimumChapter = Math.min(...directory.map((item) => item.chapter)); const maximumChapter = Math.max(...directory.map((item) => item.chapter));
  const requested = options.chapters ? new Set(options.chapters) : undefined;
  let selected = requested ? directory.filter((item) => requested.has(item.chapter)) : options.from !== undefined || options.to !== undefined
    ? directory.filter((item) => item.chapter >= (options.from ?? minimumChapter) && item.chapter <= (options.to ?? maximumChapter))
    : options.probe ? directory.slice(0, options.probe) : [];
  if (requested && selected.length !== requested.size) {
    const found = new Set(selected.map((item) => item.chapter));
    throw new SourceValidationError(`Requested chapters are not present in the ${provider.displayName} directory: ${[...requested].filter((item) => !found.has(item)).join(", ")}`);
  }
  if ((options.from !== undefined && (options.from < minimumChapter || options.from > maximumChapter)) || (options.to !== undefined && (options.to < minimumChapter || options.to > maximumChapter))) throw new SourceValidationError(`Requested range ${options.from ?? minimumChapter}-${options.to ?? maximumChapter} exceeds the ${directory.length} exposed ${provider.displayName} chapters (available chapter numbers ${minimumChapter}-${maximumChapter}, with possible gaps)`);
  if ((options.from !== undefined || options.to !== undefined) && !selected.length) throw new SourceValidationError(`Requested range ${options.from ?? minimumChapter}-${options.to ?? maximumChapter} contains no chapters in the ${provider.displayName} directory (available ${minimumChapter}-${maximumChapter}, with possible gaps)`);

  const chapters: RawChapter[] = []; const warnings: SourceWarning[] = [...(book.directoryWarnings ?? [])];
  const bulk = options.acquisition === "bulk-download" ? await loadBulkChapters(provider, book, sourcePath) : undefined;
  for (const [index, ref] of selected.entries()) {
    options.signal?.throwIfAborted();
    const progress = { phase: "chapters" as const, provider: provider.id, chapter: ref.chapter, title: ref.title, current: index + 1, total: selected.length };
    options.onProgress?.({ ...progress, completed: index });
    try {
      const fromBulk = bulk?.chapters.get(ref.chapter); if (bulk && !fromBulk) throw new Error(`Full TXT does not contain a recognizable heading for Chapter ${ref.chapter}`);
      const fetched = fromBulk && bulk ? { ...ref, text: fromBulk.text, rawContent: fromBulk.text, contentLocated: true, extractedTitle: fromBulk.title,
        acquisitionTransport: "bulk-download" as const, acquisitionUrl: bulk.url, retrievedAt: bulk.retrievedAt } : await provider.getChapter(ref, options);
      const validation = provider.validateChapter(fetched); const provenance = chapterProvenance(fetched, validation);
      if (validation.status !== "COMPLETE") {
        warnings.push({ code: "unavailable_chapter", sourceId: ref.chapterId, message: validationMessage(ref.chapter, provider.displayName, validation.status, validation.evidence.extractedCharacters, validation.evidence.expectedCharacters, validation.evidence.reasons) });
        continue;
      }
      chapters.push({ ref: { chapter: ref.chapter, sourceId: ref.chapterId, sourceTitle: book.title, originalTitle: fetched.extractedTitle ?? ref.title,
        sourceType: provider.id === "fanqie" ? "fanqie" : "web", metadata: { ...provenance, bookId: ref.bookId, chapterId: ref.chapterId, url: ref.url, order: ref.chapter } }, text: fetched.text });
    } catch (error) {
      options.signal?.throwIfAborted();
      warnings.push({ code: "unavailable_chapter", sourceId: ref.chapterId, message: `Chapter ${ref.chapter} from ${provider.displayName} could not be retrieved: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      if (!options.signal?.aborted) options.onProgress?.({ ...progress, completed: index + 1 });
    }
  }
  const sourceType: SourceType = provider.id === "fanqie" ? "fanqie" : "web";
  const references = directory.map((ref) => ({ chapter: ref.chapter, sourceId: ref.chapterId, sourceTitle: book.title, originalTitle: ref.title, sourceType,
    metadata: { provider: provider.id, sourceBookId: ref.bookId, sourceChapterId: ref.chapterId, sourceUrl: ref.url, bookId: ref.bookId, chapterId: ref.chapterId, url: ref.url, order: ref.chapter } }));
  const now = new Date().toISOString(); const metadata = { provider: provider.id, title: book.title, author: book.author, description: book.description,
    directoryCoverage: book.directoryMetadata, coverUrl: book.coverUrl, status: book.status, bookId: book.bookId, sourceUrl: book.url, capabilities: provider.capabilities,
    acquisitionTransport: options.acquisition ?? "html", ...(bulk ? { bulkDownloadUrl: bulk.url } : {}) };
  selected = selected.slice();
  return { sourcePath: book.url, sourceType, title: book.title, author: book.author, language: book.language ?? "zh-CN",
    fingerprint: fingerprint({ adapter: adapterVersion, provider: provider.id, metadata, directory: references }), chapters, directory: references,
    unnumberedSections: [], warnings, origin: { url: book.url, bookId: book.bookId }, metadata,
    remote: { lastInspectedAt: now, chapterCountAtInspection: directory.length }, additive: true, adapterVersion };
}

async function loadBulkChapters(provider: NovelSourceProvider, book: Awaited<ReturnType<NovelSourceProvider["getBook"]>>, sourcePath: string) {
  if (!provider.getBulkDownloads || !provider.fetchBulkDownload) throw new Error(`${provider.displayName} does not support full-manuscript downloads`);
  const references = await provider.getBulkDownloads(book); const reference = references.find((item) => item.format === "txt");
  if (!reference) throw new Error(`${provider.displayName} did not advertise a full TXT download for ${sourcePath}`);
  const payload = await provider.fetchBulkDownload(reference); const parsed = splitText(payload.text, reference.url, "web");
  if (!parsed.length) throw new Error(`${provider.displayName} full TXT does not contain recognizable numbered chapter headings`);
  const chapters = new Map<number, { text: string; title?: string }>();
  for (const item of parsed) {
    if (chapters.has(item.ref.chapter)) throw new Error(`${provider.displayName} full TXT contains duplicate Chapter ${item.ref.chapter} headings`);
    chapters.set(item.ref.chapter, { text: item.text, title: item.ref.originalTitle });
  }
  return { chapters, url: reference.url, retrievedAt: payload.retrievedAt };
}

function validationMessage(chapter: number, provider: string, status: string, extracted: number, expected: number | undefined, reasons: string[]) {
  return `Chapter ${chapter} · ${provider} · ${status} · ${extracted}${expected ? ` / ~${expected}` : ""} characters: ${reasons.join("; ")}`;
}
