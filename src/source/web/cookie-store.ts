import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson } from "../../storage/atomic-write.js";
import { CookieStore } from "./types.js";

export class FileCookieStore implements CookieStore {
  constructor(private readonly directory: string) {}

  async get(host: string): Promise<Record<string, string> | undefined> {
    try {
      const value = JSON.parse(await readFile(this.path(host), "utf8")) as { host?: unknown; cookies?: unknown };
      if (value.host !== host || !value.cookies || typeof value.cookies !== "object" || Array.isArray(value.cookies)) return undefined;
      const entries = Object.entries(value.cookies as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "");
      return entries.length ? Object.fromEntries(entries) : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  async set(host: string, cookies: Record<string, string>): Promise<void> {
    await atomicWriteJson(this.path(host), { host, cookies, savedAt: new Date().toISOString() });
  }

  private path(host: string) { return join(this.directory, `${host.replace(/[^a-z0-9.-]/giu, "_")}.json`); }
}
