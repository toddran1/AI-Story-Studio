# WFXS / 微風小說網 source

Provider `wfxs` accepts HTTPS book, numbered directory-page, and chapter URLs on **m.wfxs.tw**. Other hosts, credentials in URLs, nonstandard ports, and unrelated pagination links are rejected. Desktop support is not advertised: the desktop-domain probe did not establish working access.

Acquisition uses the shared WebHttpClient (bounded requests, retries, cache, cookies and existing challenge handling), followed by the existing inspection, validation, provenance and import pipeline. A dedicated adapter follows the site's actual `/booklist/<book>/<page>.html` links because the configurable selector adapter cannot convey partial directory coverage and advertised-count discrepancies. Page 1 is the root directory alias. Every linked range is inspected, with at most 500 pages, visited-URL tracking and repeated-content detection. Chapter IDs remain opaque; numbers come from titles. Failed/repeated pages and conflicts block imports; gaps and advertised-count discrepancies appear in warnings and coverage metadata. Refresh inspection revalidates cached metadata and every directory page.

Only individual HTML chapters, including book/range acquisition, are offered. Search exists on the website at `/s/` as a GET form with `search` and `sort` inputs, but this adapter does not implement search and advertises `search: false`. Book, directory and chapter inspection exposed app-download links, not a verified native full TXT/ZIP/EPUB download. No native full-book download is offered or invented. A locally assembled export is not a native download.

The observed chapter layout uses `h1.title` and `#read_conent_box` paragraphs. Extraction retains Traditional Chinese, digits, arrows and punctuation. Navigation, scripts, ads and controls are removed by element, not by rewriting prose. Wrong chapter titles, absent containers, challenge pages and suspiciously short content fail validation. Observed chapters are single-page; any future continuation control is reported as truncated rather than following the next chapter.

## Add the book to Sovereign Ashes

1. Open **Add chapters** and select the existing **Sovereign Ashes** story.
2. Select the URL source mode and paste `https://m.wfxs.tw/xiaoshuo/8076783/`.
3. Click **Add source to this story**. This associates the differently titled edition, `亡靈召喚師殺瘋了，你卻說他弱？`, without importing chapters, changing the story's title/language/naming settings, or starting production.
4. Use **Configured fallbacks** to set its priority and enabled state, then **Save source order**.
5. For an explicit import, choose a range (for example 593–593), inspect the preview, and use **Add / update**. Replacements require the established confirmation and mark affected production stale; generation remains a separate action. Each imported chapter displays its provider.

## Verification (October 1, 2026)

Mocked tests cover URL restrictions and normalization, registry/capabilities, shared-client allowlisting and redirect rejection, multiple directory pages, opaque IDs, ordering/deduplication, gaps/conflicts, repeated pages, page failures, stale-cache refresh, numeric/Traditional Chinese preservation through import, chapter validation, and configuration-only story association.

Live checks used the adapter and existing WebHttpClient without LLM/TTS calls or writing story content:

- Book metadata: expected title; advertised count 1670.
- Directory: all 56 pages; 1670 chapter references; no gaps/warnings; final opaque ID `84252048`.
- Chapter 593: COMPLETE, 2210 extracted characters; required values `2000000`, `20000000`, `32000000`, `320900138/60000000`, and `40000000` present. The browser also confirmed each upgrade context.
- Chapter 1670: COMPLETE, 2276 extracted characters.

Initial curl requests returned Cloudflare “Just a moment” pages, while browser reads and subsequent application-client checks succeeded. Access is variable: the existing solver handles its established JS redirect challenge, not arbitrary Cloudflare verification. Unsupported challenges remain blocked and are never imported. No browser-assisted acquisition/session bridge was needed or added.

When Cloudflare blocks the client outright, the **Inspection needs attention** modal offers a guided fix: **Open verification window** launches a visible Chrome window (via `playwright-core`, using the installed system Chrome — no bundled browser download) at the blocked URL. Solve the challenge there, then click **I've cleared the challenge — retry**. The studio harvests that session's cookies and exact User-Agent, seeds its cookie jar (disk and memory), applies the User-Agent to its HTTP client, and retries inspection automatically. The same flow is available through the API: `POST /api/source-verification/open` (`{url}`), `/complete`, and `/cancel`.

If Chrome is not installed (or the window cannot launch), the manual fallback still works: write `{"host":"m.wfxs.tw","cookies":{"cf_clearance":"..."},"savedAt":"<iso timestamp>"}` to the cookie jar at `<STUDIO_DATA_ROOT>/cache/cookies/m.wfxs.tw.json` (the `cookies` directory beside `WEB_CACHE_DIR`) and set `WEB_USER_AGENT` to the exact User-Agent of the browser that earned the cookie, since clearance is bound to it. The cookie jar is loaded as-is; an expired or mismatched clearance simply returns to the blocked/challenge behavior above.

Final validation: 207 source/import/server/UI tests passed, including 16 WFXS tests. Typecheck and web build passed (Vite reports its existing bundle-size warning). Full `npm test`: 1808 passed, 3 skipped, 13 failed. All 13 failures are in `pipeline.test.ts` and `qa-recovery-transactional.test.ts`; the same 13 failures reproduced in an isolated archive of the unchanged Git HEAD (22 other tests in those two files passed). They are existing QA recovery failures, outside this source addition.
