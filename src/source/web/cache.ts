import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteJson } from "../../storage/atomic-write.js";
import { HttpCache, HttpCacheEntry } from "./types.js";

export class FileHttpCache implements HttpCache {
  constructor(private readonly directory: string) {}

  async get(url: string): Promise<HttpCacheEntry | undefined> {
    try {
      const value = JSON.parse(await readFile(this.path(url), "utf8")) as HttpCacheEntry;
      return value.url === url && typeof value.body === "string" ? value : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  async set(url: string, entry: HttpCacheEntry): Promise<void> { await atomicWriteJson(this.path(url), entry); }
  private path(url: string) { return join(this.directory, `${createHash("sha256").update(url).digest("hex")}.json`); }
}
