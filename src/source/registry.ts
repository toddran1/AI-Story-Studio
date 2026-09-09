import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { DocxSource } from "./docx-source.js";
import { EpubSource } from "./epub-source.js";
import { TxtSource } from "./txt-source.js";
import { SourceType, StorySourceProvider } from "./types.js";

export class SourceProviderRegistry {
  private readonly providers = new Map<SourceType, StorySourceProvider>();
  constructor(providers: StorySourceProvider[] = [new TxtSource(), new EpubSource(), new DocxSource()]) {
    for (const provider of providers) this.providers.set(provider.type, provider);
  }
  async resolve(sourcePath: string, requested?: SourceType): Promise<{ provider: StorySourceProvider; semanticType: SourceType }> {
    const semanticType = requested ?? await detectType(sourcePath);
    const providerType = semanticType === "manual" || semanticType === "original" ? "text" : semanticType;
    const provider = this.providers.get(providerType);
    if (!provider) throw new Error(`Source type '${semanticType}' is not supported in Milestone 3`);
    return { provider, semanticType };
  }
}

async function detectType(sourcePath: string): Promise<SourceType> {
  const absolute = resolve(sourcePath); const info = await stat(absolute); if (info.isDirectory()) return "text";
  const extension = extname(absolute).toLowerCase();
  if (extension === ".txt") return "text"; if (extension === ".epub") return "epub"; if (extension === ".docx") return "docx";
  throw new Error(`Cannot detect source type from '${sourcePath}'. Use --type.`);
}
