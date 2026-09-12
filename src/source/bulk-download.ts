import { NovelDownloadReference } from "./novel-provider.js";
import { WebBinaryResponse } from "./web/types.js";
import { readSafeZipBytes } from "./zip-safety.js";

export function decodeNovelTextDownload(reference: NovelDownloadReference, response: WebBinaryResponse) {
  const zipped = reference.container === "zip" || /zip/i.test(response.contentType ?? "") || hasZipSignature(response.bytes);
  let bytes = response.bytes;
  if (zipped) {
    const entries = Object.entries(readSafeZipBytes(bytes)).filter(([name]) => /\.txt$/iu.test(name) && !name.startsWith("__MACOSX/"));
    if (!entries.length) throw new Error(`${reference.provider} download ZIP does not contain a TXT manuscript`);
    entries.sort((left, right) => right[1].byteLength - left[1].byteLength); bytes = entries[0]![1];
  }
  const text = decodeChineseText(bytes).trim();
  if (!text) throw new Error(`${reference.provider} full-TXT download is empty`);
  if (/captcha|checking your browser|正在验证浏览器|安全验证|challenge\s*=/iu.test(text.slice(0, 20_000))) throw new Error(`${reference.provider} full-TXT download returned a browser challenge instead of a manuscript`);
  return text;
}

function hasZipSignature(bytes: Uint8Array) { return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07); }
function decodeChineseText(bytes: Uint8Array) { for (const encoding of ["utf-8", "gb18030"] as const) { try { const text = new TextDecoder(encoding, { fatal: encoding === "utf-8" }).decode(bytes); if (text) return text.replace(/^\uFEFF/u, ""); } catch { /* Try the legacy Chinese encoding. */ } } return new TextDecoder().decode(bytes); }
