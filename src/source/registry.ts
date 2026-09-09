import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { DocxSource } from "./docx-source.js";
import { EpubSource } from "./epub-source.js";
import { TxtSource } from "./txt-source.js";
import { FanqieSource } from "./fanqie/fanqie-source.js";
import { SourceType, StorySourceProvider } from "./types.js";
import { WebHttpClient } from "./web/http-client.js";

export class SourceProviderRegistry {
  private readonly providers = new Map<SourceType, StorySourceProvider>();
  constructor(providers?: StorySourceProvider[], webClient?: WebHttpClient) {
    for (const provider of providers ?? [new TxtSource(), new EpubSource(), new DocxSource(), new FanqieSource(webClient)]) this.providers.set(provider.type, provider);
  }
  async resolve(sourcePath: string, requested?: SourceType): Promise<{ provider: StorySourceProvider; semanticType: SourceType }> {
    const semanticType = requested ?? await detectType(sourcePath);
    const providerType = semanticType === "manual" || semanticType === "original" ? "text" : semanticType === "web" && isFanqieUrl(sourcePath) ? "fanqie" : semanticType;
    const provider = this.providers.get(providerType);
    if (!provider) throw new Error(`Source type '${semanticType}' is not supported`);
    return { provider, semanticType: providerType };
  }
}

async function detectType(sourcePath: string): Promise<SourceType> {
  if (isUrl(sourcePath)) {
    const url = new URL(sourcePath); if (url.protocol !== "https:") throw new Error(`Only HTTPS web sources are allowed: ${sourcePath}`);
    if (isFanqieUrl(sourcePath)) return "fanqie"; throw new Error(`No web source adapter recognizes '${sourcePath}'`);
  }
  const absolute = resolve(sourcePath); const info = await stat(absolute); if (info.isDirectory()) return "text";
  const extension = extname(absolute).toLowerCase();
  if (extension === ".txt") return "text"; if (extension === ".epub") return "epub"; if (extension === ".docx") return "docx";
  throw new Error(`Cannot detect source type from '${sourcePath}'. Use --type.`);
}

function isUrl(value: string) { try { new URL(value); return true; } catch { return false; } }
function isFanqieUrl(value: string) { try { return ["fanqienovel.com", "www.fanqienovel.com"].includes(new URL(value).hostname.toLowerCase()); } catch { return false; } }
