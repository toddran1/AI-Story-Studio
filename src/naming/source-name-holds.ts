import { SOURCE_NAME_HOLD_REASON } from "../domain/chapter.js";
import { invalidateNarrationNamingChange } from "../story-bible/narration-names.js";
import { loadAmbiguousSourceNames, loadSourceNameRules, publishSourceNameScan, type SourceNameIndex } from "./source-index.js";

export async function findNewlyHeldSourceRules(root: string, slug: string, ambiguous: string[]) {
  if (!ambiguous.length) return [];
  const previouslyHeld = new Set(await loadAmbiguousSourceNames(root, slug));
  const newlyHeld = new Set(ambiguous.filter(name => !previouslyHeld.has(name)));
  if (!newlyHeld.size) return [];
  const key = (name: string) => name.normalize("NFKC").toLowerCase();
  return Object.values(await loadSourceNameRules(root, slug)).filter(rule =>
    !previouslyHeld.has(key(rule.originalName)) && [rule.originalName, ...rule.aliases].some(name => newlyHeld.has(key(name))));
}

/** Caller holds the exclusive story lock while affected metadata is written. */
export async function publishSourceNameScanWithHolds(root: string, slug: string, report: SourceNameIndex, ambiguous: string[]) {
  const held = await findNewlyHeldSourceRules(root, slug, ambiguous);
  const affected = new Set<number>();
  for (const rule of held) {
    const result = await invalidateNarrationNamingChange(root, slug, rule, { ...rule, localizedNaming: undefined }, SOURCE_NAME_HOLD_REASON);
    for (const chapter of result.affectedChapters) affected.add(chapter);
  }
  const result = await publishSourceNameScan(root, slug, report, ambiguous);
  return { ...result, heldRules: held.length, affectedChapters: [...affected].sort((a, b) => a - b) };
}
