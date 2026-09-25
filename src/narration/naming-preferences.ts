import type { CanonicalEntity } from "../domain/story-bible.js";

type NamingRule = { alias?: unknown; behavior?: unknown; replacement?: unknown };
type NamingEntity = {
  canonicalName?: unknown;
  originalName?: unknown;
  aliases?: unknown;
  preferredNarrationName?: unknown;
  aliasNarrationRules?: unknown;
  localizedNaming?: unknown;
};

/**
 * Enforces explicit Story Bible narration names after model generation. The
 * matcher is quote-agnostic, so dialogue and exposition follow the same rule,
 * while possessive suffixes and surrounding punctuation remain untouched.
 */
export function applyNarrationNamingPreferences(text: string, context?: unknown): string {
  const entities = namingEntities(context);
  const replacements = new Map<string, { source: string; replacement: string }>();
  const ambiguous = new Set<string>();
  const preservedAliases = new Set<string>();
  const add = (source: string | undefined, replacement: string | undefined) => {
    if (!source || !replacement || source.toLocaleLowerCase() === replacement.toLocaleLowerCase()) return;
    const key = source.toLocaleLowerCase();
    if (replacements.has(key) && replacements.get(key)!.replacement.toLocaleLowerCase() !== replacement.toLocaleLowerCase()) ambiguous.add(key);
    else replacements.set(key, { source, replacement });
  };

  for (const entity of entities) {
    const localized = entity.localizedNaming && typeof entity.localizedNaming === "object" ? entity.localizedNaming as { usageMode?: unknown; fullName?: unknown; shortName?: unknown } : undefined;
    // Contextual and manual localization have no single safe output form.
    const preferred = localized?.usageMode === "always_full" ? stringValue(localized.fullName) : localized?.usageMode === "always_short" ? stringValue(localized.shortName) : localized ? undefined : stringValue(entity.preferredNarrationName);
    const rules = new Map<string, NamingRule>();
    if (Array.isArray(entity.aliasNarrationRules)) for (const raw of entity.aliasNarrationRules) {
      if (!raw || typeof raw !== "object") continue;
      const rule = raw as NamingRule; const alias = stringValue(rule.alias);
      if (alias) rules.set(alias.toLocaleLowerCase(), rule);
    }
    for (const source of [stringValue(entity.canonicalName), stringValue(entity.originalName)]) {
      if (!source) continue;
      const rule = rules.get(source.toLocaleLowerCase());
      if (rule?.behavior === "no_override") { preservedAliases.add(source); continue; }
      add(source, rule?.behavior === "custom" ? stringValue(rule.replacement) : preferred);
    }
    if (Array.isArray(entity.aliases)) for (const rawAlias of entity.aliases) {
      const alias = stringValue(rawAlias); if (!alias) continue;
      const rule = rules.get(alias.toLocaleLowerCase());
      if (rule?.behavior === "no_override") { preservedAliases.add(alias); continue; }
      const replacement = rule?.behavior === "custom" ? stringValue(rule.replacement) : preferred;
      add(alias, replacement);
    }
  }

  for (const key of ambiguous) replacements.delete(key);
  const ordered = [...replacements.values()].sort((left, right) => right.source.length - left.source.length);
  if (!ordered.length) return text;
  const pattern = ordered.map((item) => escapeRegExp(item.source)).join("|");
  const sourcePattern = new RegExp(`(?<![\\p{L}\\p{N}_])(${pattern})(?![\\p{L}\\p{N}_])`, "giu");
  const sourceSpans = [...text.matchAll(sourcePattern)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  // Already-correct renderings and system panels are protected before any
  // shorter alias is replaced (for example King inside Tarkatan King).
  const protectedSpans: Array<{ start: number; end: number }> = [];
  for (const target of new Set(ordered.map((item) => item.replacement))) {
    const targetPattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(target)}(?![\\p{L}\\p{N}_])`, "giu");
    for (const match of text.matchAll(targetPattern)) {
      const end = match.index + match[0].length;
      if (!sourceSpans.some((span) => span.start <= match.index && span.end >= end && span.end - span.start > match[0].length)) protectedSpans.push({ start: match.index, end });
    }
  }
  for (const alias of preservedAliases) {
    const aliasPattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(alias)}(?![\\p{L}\\p{N}_])`, "giu");
    for (const match of text.matchAll(aliasPattern)) protectedSpans.push({ start: match.index, end: match.index + match[0].length });
  }
  for (const match of text.matchAll(/\[[^\]]*\]/gsu)) protectedSpans.push({ start: match.index, end: match.index + match[0].length });
  return text.replace(sourcePattern, (match, _capture: string, offset: number) => protectedSpans.some((span) => span.start < offset + match.length && span.end > offset) ? match : replacements.get(match.toLocaleLowerCase())?.replacement ?? match);
}

function namingEntities(context: unknown): NamingEntity[] {
  if (!context || typeof context !== "object") return [];
  const named = context as { canonicalEntities?: unknown; narrationNamingEntities?: unknown };
  const value = Array.isArray(named.narrationNamingEntities) ? named.narrationNamingEntities : named.canonicalEntities;
  return Array.isArray(value) ? value.filter((item): item is NamingEntity => Boolean(item && typeof item === "object")) : [];
}

/** Short, visible instructions keep chapter-specific names from being buried
 * inside the larger Story Bible JSON sent to the narration model. */
export function narrationNameRequirements(context: unknown): string {
  const lines = namingEntities(context).flatMap((entity) => {
    const canonical = stringValue(entity.canonicalName);
    if (!canonical) return [];
    const localized = entity.localizedNaming && typeof entity.localizedNaming === "object" ? entity.localizedNaming as { usageMode?: unknown; fullName?: unknown; shortName?: unknown } : undefined;
    const form = localized?.usageMode === "always_full" ? stringValue(localized.fullName) : localized?.usageMode === "always_short" ? stringValue(localized.shortName) : localized ? undefined : stringValue(entity.preferredNarrationName);
    const base = form ? `${canonical} → ${form} (required in narration)` : localized ? `${canonical}: localized ${String(localized.usageMode)}; full ${stringValue(localized.fullName) ?? "—"}, short ${stringValue(localized.shortName) ?? "—"} (choose by context)` : "";
    const aliases = Array.isArray(entity.aliasNarrationRules) ? entity.aliasNarrationRules.flatMap((raw) => {
      if (!raw || typeof raw !== "object") return [];
      const rule = raw as NamingRule;
      const alias = stringValue(rule.alias);
      if (!alias) return [];
      if (rule.behavior === "no_override") return [`${alias}: preserve when used contextually`];
      if (rule.behavior === "custom") return [`${alias} → ${stringValue(rule.replacement) ?? "?"} (required custom alias)`];
      return form ? [`${alias} → ${form} (required alias)`] : [];
    }) : [];
    return [base, ...aliases].filter(Boolean);
  });
  return lines.length ? `NARRATION NAME REQUIREMENTS FOR THIS CHAPTER:\n${lines.map((line) => `- ${line}`).join("\n")}` : "";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Explicit current narration renderings for one identity. Manual localization
 * requires editorial notes, so it cannot prove a form by itself. */
export function authorizedNarrationNames(entity: CanonicalEntity, sourceName?: string): string[] {
  const names: string[] = [];
  const localized = entity.localizedNaming;
  const source = sourceName?.trim().toLocaleLowerCase();
  const sourceRule = source ? entity.aliasNarrationRules.find((rule) => rule.alias.toLocaleLowerCase() === source) : undefined;
  if (sourceRule?.behavior === "custom") return sourceRule.replacement ? [sourceRule.replacement] : [];
  if (localized) {
    if (localized.usageMode !== "manual" && sourceRule?.behavior !== "no_override") {
      if (localized.usageMode !== "always_short" && localized.fullName) names.push(localized.fullName);
      if (localized.usageMode !== "always_full" && localized.shortName) names.push(localized.shortName);
    }
  } else if (entity.preferredNarrationName && sourceRule?.behavior !== "no_override") names.push(entity.preferredNarrationName);
  for (const rule of entity.aliasNarrationRules) {
    if (source === rule.alias.toLocaleLowerCase() && rule.behavior === "custom" && rule.replacement) names.push(rule.replacement);
  }
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}
