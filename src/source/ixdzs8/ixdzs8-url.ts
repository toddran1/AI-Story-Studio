export type Ixdzs8Url = { kind: "book" | "chapter"; bookId: string; chapterId?: string; url: string };

export function parseIxdzs8Url(input: string): Ixdzs8Url {
  let url: URL; try { url = new URL(input); } catch (error) { throw new Error(`Invalid ixdzs8 URL: ${input}`, { cause: error }); }
  if (url.protocol !== "https:" || !["ixdzs8.com", "www.ixdzs8.com"].includes(url.hostname.toLowerCase())) throw new Error(`Unsupported ixdzs8 URL: ${input}`);
  const chapter = /^\/read\/(\d+)\/(p\d+)\.html\/?$/.exec(url.pathname);
  if (chapter) return { kind: "chapter", bookId: chapter[1]!, chapterId: chapter[2]!, url: `https://ixdzs8.com/read/${chapter[1]}/${chapter[2]}.html` };
  const book = /^\/read\/(\d+)\/?$/.exec(url.pathname);
  if (book) return { kind: "book", bookId: book[1]!, url: `https://ixdzs8.com/read/${book[1]}/` };
  throw new Error(`Expected an ixdzs8 /read/<book-id>/ or /read/<book-id>/p<chapter>.html URL: ${input}`);
}

export const ixdzs8BookUrl = (bookId: string) => `https://ixdzs8.com/read/${bookId}/`;
export const ixdzs8ChapterUrl = (bookId: string, chapterId: string) => `https://ixdzs8.com/read/${bookId}/${chapterId}.html`;
