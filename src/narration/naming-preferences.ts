type NamingRule = { alias?: unknown; behavior?: unknown; replacement?: unknown };
type NamingEntity = {
  canonicalName?: unknown;
  originalName?: unknown;
  aliases?: unknown;
  preferredNarrationName?: unknown;
  aliasNarrationRules?: unknown;
};

/**
 * Enforces explicit Story Bible narration names after model generation. The
 * matcher is quote-agnostic, so dialogue and exposition follow the same rule,
 * while possessive suffixes and surrounding punctuation remain untouched.
 */
export function applyNarrationNamingPreferences(text: string, context?: unknown): string {
  const entities = namingEntities(context);
  const replacements = new Map<string, { source: string; replacement: string }>();

  for (const entity of entities) {
    const preferred = stringValue(entity.preferredNarrationName);
    if (!preferred) continue;
    for (const source of [stringValue(entity.canonicalName), stringValue(entity.originalName)]) {
      if (source && source.toLocaleLowerCase() !== preferred.toLocaleLowerCase()) replacements.set(source.toLocaleLowerCase(), { source, replacement: preferred });
    }

    const rules = new Map<string, NamingRule>();
    if (Array.isArray(entity.aliasNarrationRules)) for (const raw of entity.aliasNarrationRules) {
      if (!raw || typeof raw !== "object") continue;
      const rule = raw as NamingRule; const alias = stringValue(rule.alias);
      if (alias) rules.set(alias.toLocaleLowerCase(), rule);
    }
    if (Array.isArray(entity.aliases)) for (const rawAlias of entity.aliases) {
      const alias = stringValue(rawAlias); if (!alias) continue;
      const rule = rules.get(alias.toLocaleLowerCase());
      if (rule?.behavior === "no_override") continue;
      const replacement = rule?.behavior === "custom" ? stringValue(rule.replacement) : preferred;
      if (replacement && alias.toLocaleLowerCase() !== replacement.toLocaleLowerCase()) replacements.set(alias.toLocaleLowerCase(), { source: alias, replacement });
    }
  }

  const ordered = [...replacements.values()].sort((left, right) => right.source.length - left.source.length);
  if (!ordered.length) return text;
  const pattern = ordered.map((item) => escapeRegExp(item.source)).join("|");
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}_])(${pattern})(?![\\p{L}\\p{N}_])`, "giu"), (match) => replacements.get(match.toLocaleLowerCase())?.replacement ?? match);
}

function namingEntities(context: unknown): NamingEntity[] {
  if (!context || typeof context !== "object") return [];
  const value = (context as { canonicalEntities?: unknown }).canonicalEntities;
  return Array.isArray(value) ? value.filter((item): item is NamingEntity => Boolean(item && typeof item === "object")) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
