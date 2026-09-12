import { NovelBook, NovelChapterRef } from "../novel-provider.js";
import { WebHttpClient } from "../web/http-client.js";

export type JsonCatalogRequest =
  | { method: "GET"; url(book: NovelBook): string }
  | { method: "POST_FORM"; url(book: NovelBook): string; fields(book: NovelBook): Record<string, string>; headers?(book: NovelBook): Record<string, string> };

export type JsonCatalogConfig = {
  label: string;
  request: JsonCatalogRequest;
  items(payload: unknown): unknown[] | undefined;
  chapter(item: unknown, index: number, book: NovelBook): NovelChapterRef | undefined;
  detectChallenge?(body: string): string[];
};

/** Reusable transport for providers whose directory is a JSON API rather than an HTML page. */
export class JsonCatalogTransport {
  constructor(private readonly http: WebHttpClient, private readonly config: JsonCatalogConfig) {}

  async getChapterList(book: NovelBook): Promise<NovelChapterRef[]> {
    const request = this.config.request;
    const body = request.method === "POST_FORM"
      ? await this.http.postForm(request.url(book), request.fields(book), { headers: request.headers?.(book) })
      : await this.http.getText(request.url(book));
    const indicators = this.config.detectChallenge?.(body) ?? [];
    if (indicators.length) throw new Error(`${this.config.label} requires an authorized browser session (${indicators.join(", ")})`);
    let payload: unknown; try { payload = JSON.parse(body); } catch (error) { throw new Error(`${this.config.label} did not return JSON`, { cause: error }); }
    const items = this.config.items(payload); if (!items) throw new Error(`${this.config.label} is missing its chapter list`);
    const chapters = items.flatMap((item, index) => this.config.chapter(item, index, book) ?? []);
    if (!chapters.length && items.length) throw new Error(`${this.config.label} did not contain any usable chapter records`);
    return chapters;
  }
}
