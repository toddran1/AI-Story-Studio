export const audioProviderCatalog = {
  fish: {
    label: "Fish Audio",
    modelLabel: "Fish Audio model",
    referenceLabel: "Fish Audio reference / voice ID",
    previewCostLabel: "May call Fish Audio",
    models: ["s2.1-pro", "s2.1-pro-free", "s2-pro", "s1"],
  },
} as const;

export type AudioProviderId = keyof typeof audioProviderCatalog;

export const audioProviderIds = Object.keys(audioProviderCatalog) as AudioProviderId[];

export function audioProviderDefinition(provider: string) {
  const definition = audioProviderCatalog[provider as AudioProviderId];
  if (!definition) throw new Error(`Unsupported audio provider '${provider}'`);
  return definition;
}
