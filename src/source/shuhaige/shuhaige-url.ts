export type ShuhaigeUrl = { kind: "book" | "chapter"; bookId: string; chapterId?: string; url: string };

export function parseShuhaigeUrl(input: string): ShuhaigeUrl {
  let url: URL; try { url = new URL(input); } catch (error) { throw new Error(`Invalid Shuhaige URL: ${input}`, { cause: error }); }
  if (url.protocol !== "https:" || !["shuhaige.net", "www.shuhaige.net", "m.shuhaige.net"].includes(url.hostname.toLowerCase())) throw new Error(`Unsupported Shuhaige URL: ${input}`);
  const chapter = /^\/(\d+)\/(\d+)(?:_\d+)?\.html\/?$/.exec(url.pathname);
  if (chapter) return { kind: "chapter", bookId: chapter[1]!, chapterId: chapter[2]!, url: `https://www.shuhaige.net/${chapter[1]}/${chapter[2]}.html` };
  const book = /^\/(\d+)\/?$/.exec(url.pathname);
  if (book) return { kind: "book", bookId: book[1]!, url: `https://www.shuhaige.net/${book[1]}/` };
  throw new Error(`Expected a Shuhaige /<book-id>/ or /<book-id>/<chapter-id>.html URL: ${input}`);
}

export const shuhaigeBookUrl = (bookId: string) => `https://www.shuhaige.net/${bookId}/`;
export const shuhaigeChapterUrl = (bookId: string, chapterId: string, page = 1) => `https://www.shuhaige.net/${bookId}/${chapterId}${page > 1 ? `_${page}` : ""}.html`;
