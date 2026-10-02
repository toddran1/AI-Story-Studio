import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

export type BrowserVerificationHarvest = { userAgent: string; cookies: Record<string, string> };

export interface BrowserVerificationSession {
  open(url: string): Promise<void>;
  complete(): Promise<BrowserVerificationHarvest>;
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
  private browser?: Browser; private context?: BrowserContext; private page?: Page;

  status(): "idle" | "open" { return this.browser ? "open" : "idle"; }

  async open(url: string): Promise<void> {
    if (this.browser) throw new BrowserVerificationUnavailableError("A verification window is already open.");
    let browser: Browser;
    try { browser = await chromium.launch({ channel: "chrome", headless: false }); }
    catch (cause) { throw new BrowserVerificationUnavailableError(CHROME_MISSING_HINT, { cause }); }
    this.browser = browser;
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
    const url = page.url();
    let userAgent = "";
    try { userAgent = await page.evaluate(() => navigator.userAgent); } catch { /* The page may be mid-navigation; fall back to the context UA below. */ }
    const cookies: Record<string, string> = {};
    for (const cookie of await context.cookies(url.startsWith("http") ? url : undefined)) cookies[cookie.name] = cookie.value;
    await this.closeQuietly();
    if (!userAgent) throw new BrowserVerificationUnavailableError("The verification window closed before its browser identity could be read. Retry verification.");
    return { userAgent, cookies };
  }

  async cancel(): Promise<void> { await this.closeQuietly(); }

  private async closeQuietly() {
    const browser = this.browser; this.browser = undefined; this.context = undefined; this.page = undefined;
    if (browser) await browser.close().catch(() => { /* The window may already be closed by the user. */ });
  }
}

export const createPlaywrightBrowserVerification: BrowserVerificationFactory = () => new PlaywrightBrowserVerification();
