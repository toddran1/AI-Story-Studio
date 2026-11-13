import { SourceAuthenticationRequiredError, SourceValidationError } from "../errors.js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

export type BrowserVerificationHarvest = { userAgent: string; cookies: Record<string, string> };

export interface BrowserVerificationSession {
  open(url: string): Promise<void>;
  complete(): Promise<BrowserVerificationHarvest>;
  readTomatoChapter?(url: string, signal?: AbortSignal): Promise<string>;
  cancel(): Promise<void>;
  status(): "idle" | "open";
}

export type BrowserVerificationFactory = () => BrowserVerificationSession;

const CHROME_MISSING_HINT =
  "Could not launch a verification window. Google Chrome must be installed for in-app browser verification. " +
  "Install Chrome, or seed cookies manually as described in docs/wfxs-source.md.";

export class BrowserVerificationUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "BrowserVerificationUnavailableError"; }
}

/**
 * Opens a visible system Chrome window (no bundled browser download) so the user
 * can clear a source website's browser challenge, then harvests the session's
 * cookies and exact User-Agent.
 */
export class PlaywrightBrowserVerification implements BrowserVerificationSession {
  private browser?: Browser; private context?: BrowserContext; private page?: Page; private sourceUrl?: string;

  status(): "idle" | "open" { return this.browser ? "open" : "idle"; }

  async open(url: string): Promise<void> {
    if (this.browser) throw new BrowserVerificationUnavailableError("A verification window is already open.");
    let browser: Browser;
    try { browser = await chromium.launch({ channel: "chrome", headless: false }); }
    catch (cause) { throw new BrowserVerificationUnavailableError(CHROME_MISSING_HINT, { cause }); }
    this.browser = browser; this.sourceUrl = url;
    try {
      this.context = await browser.newContext();
      this.page = await this.context.newPage();
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch (error) {
      await this.closeQuietly();
      throw new BrowserVerificationUnavailableError(`The verification window could not open ${url}.`, { cause: error });
    }
  }

  async complete(): Promise<BrowserVerificationHarvest> {
    const { context, page } = this;
    if (!context || !page) throw new BrowserVerificationUnavailableError("No verification window is open.");
    const url = this.sourceUrl;
    let userAgent = "";
    try { userAgent = await page.evaluate(() => navigator.userAgent); } catch { /* The page may be mid-navigation; fall back to the context UA below. */ }
    const cookies: Record<string, string> = {};
    for (const cookie of (url ? await context.cookies(url) : [])) cookies[cookie.name] = cookie.value;
    await this.closeQuietly();
    if (!userAgent) throw new BrowserVerificationUnavailableError("The verification window closed before its browser identity could be read. Retry verification.");
    return { userAgent, cookies };
  }

  async readTomatoChapter(input: string, signal?: AbortSignal): Promise<string> {
    const url = new URL(input);
    if (url.origin !== "https://tomatomtl.com" || url.username || url.password || !/^\/book\/\d{1,24}\/\d{1,24}$/u.test(url.pathname)) {
      throw new SourceValidationError("Invalid TomatoMTL chapter URL.");
    }
    const signInRequired = () => new SourceAuthenticationRequiredError("TomatoMTL sign-in required. Open Story Studio’s verification window, sign in there, and leave it open while importing.");
    if (!this.context || !this.browser?.isConnected() || new URL(this.sourceUrl ?? "about:blank").origin !== url.origin) throw signInRequired();
    signal?.throwIfAborted();
    const page = await this.context.newPage();
    const cancel = () => { void page.close().catch(() => undefined); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      signal?.throwIfAborted();
      const response = await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
      if (response?.status() === 401 || /login required|^login$/iu.test(await page.title()) || new URL(page.url()).pathname === "/user/login") throw signInRequired();
      if (response && !response.ok()) throw new SourceValidationError(`TomatoMTL chapter returned HTTP ${response.status()}.`);
      if (new URL(page.url()).origin !== url.origin || new URL(page.url()).pathname !== url.pathname) throw new SourceValidationError("TomatoMTL redirected away from the requested chapter.");
      await page.locator("#chapter_content p").first().waitFor({ state: "visible", timeout: 20_000 });
      // Read only the chapter elements; do not copy the browser session or account page.
      return await page.locator("#chapter_title, #chapter_content").evaluateAll(elements => elements.map(element => element.outerHTML).join("\n"));
    } catch (error) {
      signal?.throwIfAborted();
      if (!this.browser?.isConnected()) throw signInRequired();
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
      await page.close().catch(() => undefined);
    }
  }

  async cancel(): Promise<void> { await this.closeQuietly(); }

  private async closeQuietly() {
    const browser = this.browser; this.browser = undefined; this.context = undefined; this.page = undefined; this.sourceUrl = undefined;
    if (browser) await browser.close().catch(() => { /* The window may already be closed by the user. */ });
  }
}

export const createPlaywrightBrowserVerification: BrowserVerificationFactory = () => new PlaywrightBrowserVerification();
