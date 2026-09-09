import { ArtworkError } from "../pipeline/errors.js";
import { ImageProvider } from "./provider.js";

export class ImageProviderRouter {
  constructor(private readonly providers: Map<string, ImageProvider>) {}
  forName(name: string) { const provider = this.providers.get(name); if (!provider) throw new ArtworkError(`Image provider '${name}' is not registered`); return provider; }
}
