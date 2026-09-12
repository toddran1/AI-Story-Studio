import { load } from "cheerio";

const FIRST_GLYPH = 58_344;
// Stable glyph ordering used by Fanqie's dc027189e0ba4cd anti-scraping font.
// Glyph-to-character data: https://github.com/tianhuoDD/fanqienovel-decryptor
const GLYPHS = "D在主特家军然表场4要只v和\u00006别还g现儿岁\u0000\u0000此象月3出战工相o男直失世F都平文什VO将真T那当\u0000会立些u是十张学气大爱两命全后东性通被1它乐接而感车山公了常以何可话先pi叫轻M士w着变尔快l个说少色里安花远7难师放t报认面道S\u0000克地度I好机U民写把万同水新没书电吃像斯5为y白几日教看但第加候作上拉住有法r事应位利你声身国问马女他Y比父xAHNsX边美对所金活回意到z从j知又内因点Q三定8Rb正或夫向德听更\u0000得告并本q过记L让打f人就者去原满体做经K走如孩cG给使物\u0000最笑部\u0000员等受k行一条果动光门头见往自解成处天能于名其发总母的死手入路进心来h时力多开已许d至由很界n小与Z想代么分生口再妈望次西风种带J\u0000实情才这\u0000E我神格长觉间年眼无不亲关结0友信下却重己老2音字m呢明之前高PB目太e9起稜她也W用方子英每理便四数期中C外样a海们任";

export class FanqieLockedChapterError extends Error {
  constructor(title: string, readonly advertisedCharacters?: number) {
    super(`Fanqie only exposed a locked preview for '${title}'${advertisedCharacters ? ` (${advertisedCharacters.toLocaleString("en-US")} characters advertised)` : ""}. Sign in or use the Fanqie app to obtain the full chapter, then import an authorized local copy.`);
    this.name = "FanqieLockedChapterError";
  }
}

export function parseFanqieChapter(html: string): { title: string; text: string } {
  const $ = load(html); const title = clean($(".muye-reader-title").first().text());
  if (!title) throw new Error("Fanqie chapter page is missing its title");
  const state = tryExtractInitialState(html) as { reader?: { chapterData?: { isChapterLock?: unknown; chapterWordNumber?: unknown; content?: unknown } } } | undefined;
  const data = state?.reader?.chapterData;
  const advertisedCharacters = typeof data?.chapterWordNumber === "string" || typeof data?.chapterWordNumber === "number" ? Number(data.chapterWordNumber) : undefined;
  const previewCharacters = typeof data?.content === "string" ? [...data.content].length : undefined;
  const expectedCharacters = Number.isSafeInteger(advertisedCharacters) && (advertisedCharacters ?? 0) > 0 ? advertisedCharacters : undefined;
  const loginGate = /会员登录后，可在网页畅读全文|扫码下载APP免费读/u.test(html);
  if (data?.isChapterLock === true || loginGate || (expectedCharacters !== undefined && previewCharacters !== undefined && previewCharacters < expectedCharacters * 0.5)) {
    throw new FanqieLockedChapterError(title, expectedCharacters);
  }
  const paragraphs = $(".muye-reader-content p").map((_, element) => clean($(element).text())).get().filter(Boolean);
  if (!paragraphs.length) throw new Error(`Fanqie chapter '${title}' has no readable body (it may be locked)`);
  const encoded = paragraphs.join("\n\n");
  if (/[\uE3E8-\uE55B]/u.test(encoded) && /awesome-font|@font-face/u.test(html) && !html.includes("dc027189e0ba4cd")) {
    throw new Error("Fanqie changed its encrypted font; refusing to decode with a stale mapping");
  }
  return { title, text: decodeFanqieText(encoded) };
}

export function decodeFanqieText(value: string): string {
  let output = "";
  for (const character of value) {
    const point = character.codePointAt(0)!; const mapped = GLYPHS[point - FIRST_GLYPH];
    if (point >= FIRST_GLYPH && point < FIRST_GLYPH + GLYPHS.length) {
      if (!mapped || mapped === "\u0000") throw new Error(`Fanqie returned an unknown encrypted glyph U+${point.toString(16).toUpperCase()}`);
      output += mapped;
    } else output += character;
  }
  return output;
}

function clean(value: string) { return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim(); }

export function extractInitialState(html: string): Record<string, unknown> {
  const marker = "window.__INITIAL_STATE__="; const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new Error("Fanqie page is missing __INITIAL_STATE__");
  const start = html.indexOf("{", markerIndex + marker.length); if (start < 0) throw new Error("Fanqie initial state is malformed");
  let depth = 0; let quoted = false; let escaped = false;
  for (let index = start; index < html.length; index++) {
    const char = html[index]!;
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true; else if (char === "{") depth++; else if (char === "}" && --depth === 0) return JSON.parse(html.slice(start, index + 1)) as Record<string, unknown>;
  }
  throw new Error("Fanqie initial state JSON is incomplete");
}

export function bookIdFromChapterPage(html: string): string {
  const state = extractInitialState(html) as { reader?: { chapterData?: { bookId?: unknown } } };
  const bookId = state.reader?.chapterData?.bookId;
  if (typeof bookId !== "string" || !/^\d+$/.test(bookId)) throw new Error("Fanqie chapter page does not identify its book");
  return bookId;
}

function tryExtractInitialState(html: string): Record<string, unknown> | undefined {
  try { return extractInitialState(html); }
  catch { return undefined; }
}
