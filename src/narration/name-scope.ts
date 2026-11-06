/** Lexical matches cannot establish the referent of a one-word English name. */
export function needsContextualNameResolution(name: string): boolean {
  return [...name.trim()].length < 2 || /^[\p{Script=Latin}\p{M}]+(?:['’-][\p{Script=Latin}\p{M}]+)*$/u.test(name.trim());
}

export type NameIdentity = { canonicalName?: unknown; originalName?: unknown; aliases?: unknown; preferredNarrationName?: unknown; localizedNaming?: unknown };
export function identityNames(entity: NameIdentity): string[] {
  const localized = entity.localizedNaming as { fullName?: unknown; shortName?: unknown } | undefined;
  return [entity.canonicalName, entity.originalName, ...(Array.isArray(entity.aliases) ? entity.aliases : []), entity.preferredNarrationName, localized?.fullName, localized?.shortName]
    .filter((name): name is string => typeof name === 'string' && Boolean(name.trim())).map(name => name.trim());
}
export function nameOccurrences(text: string, name: string): Array<{ start: number; end: number }> {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu'))]
    .map(match => ({ start: match.index, end: match.index + match[0].length }));
}
/** A complete known name shields its parts, even if it has no rendering override. */
export function identitySpans(text: string, entities: NameIdentity[]) {
  return [...new Set(entities.flatMap(identityNames))].filter(name => !needsContextualNameResolution(name))
    .flatMap(name => nameOccurrences(text, name).map(span => ({ ...span, nameLength: name.length })));
}
export const narrationNameScopeGuidance = 'IDENTITY SCOPE: Apply a naming mapping only when the occurrence actually refers to that entity. Match the complete, longest entity name first: Tiger inside Sword Tiger Guild, Tiger’s Might or Tiger Frenzy is not a reference to the character Tiger. Preserve the complete faction, skill, item, place or other entity name unless that complete entity has its own naming rule. Ordinary nouns, animals, generic descriptions and unrelated people that share a name are not aliases of the named entity (a dog is not automatically the character Dog). Short names and descriptive phrases may still refer to the named entity: use the chapter context, dialogue attribution and established identity to resolve Rat to Zi-Shu / Zi-Rat or Tiger to Yin Tiger only when that referent is clear. Do not expand every rat or tiger, and do not suppress a legitimate short-name reference just because it is also an ordinary word. One-word names and aliases require contextual identification; capitalization alone, including at sentence starts, is not proof. When the referent is uncertain, preserve the written form rather than guess or force a substitution.';
