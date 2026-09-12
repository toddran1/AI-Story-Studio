import { ChapterValidation, FetchedNovelChapter, NovelBook, NovelChapterRef, NovelProviderId, NovelSourceProvider } from "./novel-provider.js";

export type FallbackAttempt = { provider: NovelProviderId; chapter?: FetchedNovelChapter; validation: ChapterValidation };

export class NovelFallbackRetriever {
  constructor(private readonly providers: Map<NovelProviderId, NovelSourceProvider>) {}

  async retrieve(chapter: number, sources: NovelBook[]): Promise<{ accepted?: FetchedNovelChapter; attempts: FallbackAttempt[] }> {
    const attempts: FallbackAttempt[] = [];
    for (const source of sources) {
      const provider = this.providers.get(source.provider);
      if (!provider) continue;
      let ref: NovelChapterRef | undefined;
      try {
        ref = (await provider.getChapterList(source)).find((item) => item.chapter === chapter);
        if (!ref) {
          attempts.push({ provider: source.provider, validation: unavailable("The provider catalog does not contain the requested chapter") });
          continue;
        }
        const fetched = await provider.getChapter(ref); const validation = provider.validateChapter(fetched);
        attempts.push({ provider: source.provider, chapter: fetched, validation });
        if (validation.status === "COMPLETE") return { accepted: fetched, attempts };
      } catch (error) {
        attempts.push({ provider: source.provider, validation: unavailable(error instanceof Error ? error.message : String(error)) });
      }
    }
    return { attempts };
  }
}

function unavailable(reason: string): ChapterValidation {
  return { status: /challenge|captcha|interstitial|browser-verification/i.test(reason) ? "CHALLENGE_REQUIRED" : /blocked|access denied/i.test(reason) ? "BLOCKED" : "INVALID", evidence: { extractedCharacters: 0, contentContainerFound: false, indicators: [], reasons: [reason] } };
}
