export type FanqieUrl = { kind: "book" | "chapter"; id: string; url: string };

export function parseFanqieUrl(input: string): FanqieUrl {
  let url: URL; try { url = new URL(input); } catch (error) { throw new Error(`Invalid Fanqie URL: ${input}`, { cause: error }); }
  if (url.protocol !== "https:" || !["fanqienovel.com", "www.fanqienovel.com"].includes(url.hostname.toLowerCase())) throw new Error(`Unsupported Fanqie URL: ${input}`);
  const match = /^\/(page|reader)\/(\d+)\/?$/.exec(url.pathname);
  if (!match) throw new Error(`Expected a Fanqie /page/<book-id> or /reader/<chapter-id> URL: ${input}`);
  return { kind: match[1] === "page" ? "book" : "chapter", id: match[2]!, url: `https://fanqienovel.com/${match[1]}/${match[2]}` };
}

export const fanqieBookUrl = (bookId: string) => `https://fanqienovel.com/page/${bookId}`;
export const fanqieChapterUrl = (chapterId: string) => `https://fanqienovel.com/reader/${chapterId}`;
