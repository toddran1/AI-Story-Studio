import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { DocxSource } from "./docx-source.js";
import { EpubSource } from "./epub-source.js";
import { TxtSource } from "./txt-source.js";
import { FanqieSource } from "./fanqie/fanqie-source.js";
import { Ixdzs8Source } from "./ixdzs8/ixdzs8-source.js";
import { ShuhaigeSource } from "./shuhaige/shuhaige-source.js";
import { SourceType, StorySourceProvider } from "./types.js";
import { WebHttpClient } from "./web/http-client.js";
import { NovelProviderId, NovelSearchResult, NovelSourceProvider } from "./novel-provider.js";
import { ProviderCircuitBreaker, providerDescriptor } from "./provider-catalog.js";
import { builtinSelectorSources } from "./html/builtin-selector-sources.js";

export class SourceProviderRegistry {
  private readonly providers = new Map<SourceType, StorySourceProvider>(); private readonly novelProviders = new Map<NovelProviderId, NovelSourceProvider & StorySourceProvider>();
  private readonly breaker: ProviderCircuitBreaker;
  constructor(providers?: StorySourceProvider[], webClient?: WebHttpClient, breaker = new ProviderCircuitBreaker()) {
    this.breaker = breaker;
    const configured = providers ?? [new TxtSource(), new EpubSource(), new DocxSource(), new FanqieSource(webClient), new Ixdzs8Source(webClient), new ShuhaigeSource(webClient), ...builtinSelectorSources(webClient)];
    for (const provider of configured) {
      if (isNovelProvider(provider)) this.novelProviders.set(provider.id, provider);
      if (provider.type !== "web" || !this.providers.has("web")) this.providers.set(provider.type, provider);
    }
  }
  async resolve(sourcePath: string, requested?: SourceType): Promise<{ provider: StorySourceProvider; semanticType: SourceType }> {
    const novel = isUrl(sourcePath) ? [...this.novelProviders.values()].find((provider) => provider.supportsUrl(sourcePath)) : undefined;
    const semanticType = requested ?? novel?.type ?? await detectType(sourcePath);
    const providerType = semanticType === "manual" || semanticType === "original" ? "text" : novel?.type ?? semanticType;
    const provider = novel ?? this.providers.get(providerType);
    if (!provider) throw new Error(`Source type '${semanticType}' is not supported`);
    return { provider, semanticType: providerType };
  }

  getNovelProvider(id: NovelProviderId) { const provider = this.novelProviders.get(id); if (!provider) throw new Error(`Novel provider '${id}' is not registered`); return provider; }
  novelProviderIdForUrl(input: string) { return [...this.novelProviders.values()].find((provider) => provider.supportsUrl(input))?.id; }
  listNovelProviders() { return [...this.novelProviders.values()].map((provider) => ({ ...providerDescriptor(provider), health: this.breaker.state(provider.id) })).sort((a, b) => a.priority - b.priority || a.displayName.localeCompare(b.displayName)); }
  async inspect(provider: StorySourceProvider, source: string, options?: Parameters<StorySourceProvider["inspect"]>[1]) {
    if (!isNovelProvider(provider)) return provider.inspect(source, options);
    return this.execute(provider, () => provider.inspect(source, options));
  }
  async diagnoseNovelProvider(id: NovelProviderId) {
    const provider = this.getNovelProvider(id); if (!provider.healthCheck) return { ...providerDescriptor(provider), health: this.breaker.state(id), checked: false };
    try { await this.execute(provider, () => provider.healthCheck!()); return { ...providerDescriptor(provider), health: this.breaker.state(id), checked: true, reachable: true }; }
    catch (error) { return { ...providerDescriptor(provider), health: this.breaker.state(id), checked: true, reachable: false, error: error instanceof Error ? error.message : String(error) }; }
  }
  disableNovelProvider(id: NovelProviderId) { this.getNovelProvider(id); this.breaker.disable(id); }
  enableNovelProvider(id: NovelProviderId) { this.getNovelProvider(id); this.breaker.enable(id); }
  async searchNovels(query: string, providerIds?: NovelProviderId[], limit = 20): Promise<{ results: NovelSearchResult[]; warnings: Array<{ provider: NovelProviderId; message: string }> }> {
    const pool = providerIds?.length ? providerIds.map((id) => this.getNovelProvider(id)) : [...this.novelProviders.values()].filter((provider) => providerDescriptor(provider).enabledByDefault);
    const selected = pool.filter((provider) => provider.capabilities.search).sort((a, b) => providerDescriptor(a).priority - providerDescriptor(b).priority);
    const settled = await Promise.allSettled(selected.map((provider) => this.execute(provider, () => provider.search(query, limit))));
    const results: NovelSearchResult[] = []; const warnings: Array<{ provider: NovelProviderId; message: string }> = [];
    settled.forEach((item, index) => { const provider = selected[index]!; if (item.status === "fulfilled") results.push(...item.value); else warnings.push({ provider: provider.id, message: item.reason instanceof Error ? item.reason.message : String(item.reason) }); });
    return { results: results.slice(0, Math.max(0, limit)), warnings };
  }
  private async execute<T>(provider: NovelSourceProvider, operation: () => Promise<T>) {
    this.breaker.assertAvailable(provider.id);
    try { const result = await operation(); this.breaker.success(provider.id); return result; }
    catch (error) { this.breaker.failure(provider.id, error); throw error; }
  }
}

async function detectType(sourcePath: string): Promise<SourceType> {
  if (isUrl(sourcePath)) {
    const url = new URL(sourcePath); if (url.protocol !== "https:") throw new Error(`Only HTTPS web sources are allowed: ${sourcePath}`);
    if (isFanqieUrl(sourcePath)) return "fanqie";
    if (isIxdzs8Url(sourcePath) || isShuhaigeUrl(sourcePath)) return "web";
    throw new Error(`No web source adapter recognizes '${sourcePath}'`);
  }
  const absolute = resolve(sourcePath); const info = await stat(absolute); if (info.isDirectory()) return "text";
  const extension = extname(absolute).toLowerCase();
  if (extension === ".txt") return "text"; if (extension === ".epub") return "epub"; if (extension === ".docx") return "docx";
  throw new Error(`Cannot detect source type from '${sourcePath}'. Use --type.`);
}

function isUrl(value: string) { try { new URL(value); return true; } catch { return false; } }
function isFanqieUrl(value: string) { try { return ["fanqienovel.com", "www.fanqienovel.com"].includes(new URL(value).hostname.toLowerCase()); } catch { return false; } }
function isIxdzs8Url(value: string) { try { return ["ixdzs8.com", "www.ixdzs8.com"].includes(new URL(value).hostname.toLowerCase()); } catch { return false; } }
function isShuhaigeUrl(value: string) { try { return ["shuhaige.net", "www.shuhaige.net", "m.shuhaige.net"].includes(new URL(value).hostname.toLowerCase()); } catch { return false; } }
function isNovelProvider(value: StorySourceProvider): value is StorySourceProvider & NovelSourceProvider { return "id" in value && "supportsUrl" in value && "validateChapter" in value; }
