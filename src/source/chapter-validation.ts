import { ChapterValidation, FetchedNovelChapter } from "./novel-provider.js";

const BLOCKED = [
  /正在验证浏览器|正在驗證瀏覽器|安全验证|安全驗證|checking your browser|cloudflare|captcha|challenge=/iu,
  /access denied|request blocked|访问过于频繁|訪問過於頻繁/iu,
];
const LOCKED = [/isChapterLock\s*["']?\s*:\s*true/iu, /会员登录|會員登錄|登录后阅读|登入後閱讀|扫码下载.*全文|VIP章节|付费章节|订阅后阅读/iu];
const PREVIEW = [/试读|試讀|预览|預覽|preview|阅读全文.*(?:APP|客户端)/iu];
const INCOMPLETE_ENDING = /(?:本章|正文)(?:尚未|未)(?:结束|結束|完)|请点击下一页继续阅读|下页继续/iu;
const ADS = [/^(?:最新网址|手机用户请|请记住本站|本章未完|加入书签|投推荐票|返回目录|点击下一页)/iu, /(?:www\.)?(?:ixdzs8|shuhaige)\.(?:com|net)/iu];

export type ValidationOptions = {
  minimumCharacters?: number;
  minimumExpectedRatio?: number;
  blockedIndicators?: RegExp[];
  lockedIndicators?: RegExp[];
  truncatedIndicators?: RegExp[];
  invalidIndicators?: RegExp[];
};

export function validateWebChapter(chapter: FetchedNovelChapter, options: ValidationOptions = {}): ChapterValidation {
  const minimum = options.minimumCharacters ?? 120;
  const ratio = options.minimumExpectedRatio ?? 0.55;
  const text = chapter.text.trim();
  const raw = `${chapter.rawContent ?? chapter.rawHtml ?? ""}\n${text}`;
  const contentLocated = chapter.contentLocated ?? chapter.contentContainerFound ?? false;
  const extracted = [...text].length;
  const expected = chapter.advertisedCharacters ?? chapter.expectedCharacters;
  const indicators = [...(chapter.indicators ?? [])];
  const reasons: string[] = [];
  const blocked = matching([...BLOCKED, ...(options.blockedIndicators ?? [])], raw);
  const locked = matching([...LOCKED, ...(options.lockedIndicators ?? [])], raw);
  const preview = matching([...PREVIEW, ...(options.truncatedIndicators ?? [])], raw);
  const invalid = matching(options.invalidIndicators ?? [], raw);
  const incompleteEnding = matching([INCOMPLETE_ENDING], text.slice(-300));
  if (blocked) indicators.push(blocked);
  if (locked) indicators.push(locked);
  if (preview) indicators.push(preview);
  if (invalid) indicators.push(invalid);
  if (incompleteEnding) indicators.push(incompleteEnding);

  let status: ChapterValidation["status"] = "COMPLETE";
  if (blocked) { status = "CHALLENGE_REQUIRED"; reasons.push("The source requires an authorized browser challenge or interactive session before this chapter can be retrieved"); }
  else if (locked) { status = "LOCKED"; reasons.push("The source reports a login, membership, or locked chapter state"); }
  else if (invalid) { status = "INVALID"; reasons.push("The source returned a placeholder or failed-content response instead of a chapter"); }
  else if (!contentLocated || !text) { status = "INVALID"; reasons.push("The provider did not locate a valid chapter content payload"); }
  else if (identityMismatch(chapter.title, chapter.extractedTitle)) { status = "INVALID"; reasons.push("The returned chapter title does not match the requested chapter identity"); }
  else if (preview) { status = "TRUNCATED"; reasons.push("The response contains preview or read-more indicators"); }
  else if (incompleteEnding) { status = "TRUNCATED"; reasons.push("The chapter ending indicates that another content page is missing"); }
  else if (expected && extracted < expected * ratio) { status = "TRUNCATED"; reasons.push(`Only ${extracted} of approximately ${expected} advertised characters were extracted`); }
  else if (looksLikeAdvertisement(text)) { status = "INVALID"; reasons.push("The extracted body is predominantly navigation or advertising text"); }
  else if (extracted < minimum) { status = "TRUNCATED"; reasons.push(`The extracted chapter is suspiciously short (${extracted} characters)`); }
  else reasons.push("A real content container and plausible complete chapter text were found");

  return {
    status,
    evidence: {
      extractedCharacters: extracted,
      expectedCharacters: expected,
      contentContainerFound: contentLocated,
      expectedChapterIdentity: chapter.title,
      extractedChapterIdentity: chapter.extractedTitle,
      indicators: [...new Set(indicators)],
      reasons,
    },
  };
}

function matching(patterns: RegExp[], value: string) {
  for (const pattern of patterns) { const result = pattern.exec(value); if (result) return result[0].slice(0, 120); }
  return undefined;
}

function identityMismatch(expected?: string, actual?: string) {
  if (!expected || !actual) return false;
  const a = normalizeIdentity(expected); const b = normalizeIdentity(actual);
  if (!a || !b) return false;
  const aNumber = chapterNumber(a); const bNumber = chapterNumber(b);
  if (aNumber !== undefined && bNumber !== undefined) return aNumber !== bNumber;
  return !(a.includes(b) || b.includes(a));
}

function normalizeIdentity(value: string) { return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ""); }
function chapterNumber(value: string) { const match = /(?:第)?(\d+)(?:章|话|話|节|節)?/u.exec(value); return match ? Number(match[1]) : undefined; }

function looksLikeAdvertisement(text: string) {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.filter((line) => ADS.some((pattern) => pattern.test(line))).length / lines.length >= 0.6;
}
