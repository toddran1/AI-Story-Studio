import type { CanonicalEntity } from "../domain/story-bible.js";
import { normalizeEntityName } from "./updater.js";

export const namingCollisionTypeValues = ["canonical-canonical", "canonical-alias", "canonical-narration", "alias-narration", "localized"] as const;
export type NamingCollisionType = (typeof namingCollisionTypeValues)[number];

export type NamingCollisionEntity = { id: string; canonicalName: string; type: string; field: string };
export type NamingCollision = {
  id: string;
  type: NamingCollisionType;
  name: string;
  entities: NamingCollisionEntity[];
  chapters: number[];
  hasMergeRelationship: boolean;
  confidence: "high";
  reason: string;
};

type NameField = { field: string; value: string | undefined; kind: "canonical" | "alias" | "narration" | "localized" };

const FIELD_LABEL: Record<NameField["kind"], string> = {
  canonical: "canonical name",
  alias: "alias/original name",
  narration: "preferred narration name",
  localized: "localized name",
};

function fieldsOf(entity: CanonicalEntity): NameField[] {
  return [
    { field: "canonicalName", value: entity.canonicalName, kind: "canonical" },
    { field: "originalName", value: entity.originalName, kind: "alias" },
    ...entity.aliases.map((value) => ({ field: "aliases", value, kind: "alias" as const })),
    { field: "preferredNarrationName", value: entity.preferredNarrationName, kind: "narration" },
    { field: "localizedNaming.fullName", value: entity.localizedNaming?.fullName, kind: "localized" },
    { field: "localizedNaming.shortName", value: entity.localizedNaming?.shortName, kind: "localized" },
  ];
}

function collisionType(kinds: Set<NameField["kind"]>): NamingCollisionType {
  if (kinds.has("localized")) return "localized";
  if (kinds.has("narration")) return kinds.has("canonical") ? "canonical-narration" : "alias-narration";
  return kinds.has("canonical") && kinds.has("alias") ? "canonical-alias" : "canonical-canonical";
}

/**
 * Deterministic naming-collision detection: exact normalized-name matches
 * across the naming fields of DIFFERENT active entities. This is deliberately
 * distinct from fuzzy duplicate detection — collisions never feed merge
 * automation; they only surface for human review.
 *
 * Callers pass the active entity list: suppressed and merged-away records are
 * already absent from the overlaid bible. When two colliding entities still
 * carry a merge relationship (one lists the other in mergedFromIds, e.g.
 * inconsistent data), the collision is flagged instead of reported as open.
 */
export function findNamingCollisions(entities: CanonicalEntity[]): NamingCollision[] {
  const byName = new Map<string, Array<{ entity: CanonicalEntity; field: NameField }>>();
  for (const entity of entities) {
    const seen = new Set<string>();
    for (const field of fieldsOf(entity)) {
      const key = normalizeEntityName(field.value);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      byName.set(key, [...(byName.get(key) ?? []), { entity, field }]);
    }
  }
  const collisions: NamingCollision[] = [];
  for (const [name, entries] of byName) {
    const involved = new Map<string, { entity: CanonicalEntity; fields: NameField[] }>();
    for (const entry of entries) {
      const current = involved.get(entry.entity.id) ?? { entity: entry.entity, fields: [] };
      current.fields.push(entry.field);
      involved.set(entry.entity.id, current);
    }
    if (involved.size < 2) continue;
    const members = [...involved.values()].sort((a, b) => a.entity.id.localeCompare(b.entity.id));
    const kinds = new Set(members.flatMap((member) => member.fields.map((field) => field.kind)));
    const type = collisionType(kinds);
    const ids = members.map((member) => member.entity.id);
    const hasMergeRelationship = members.some((member) => member.entity.mergedFromIds.some((id) => ids.includes(id)));
    const display = entries.find((entry) => entry.field.value)?.field.value ?? name;
    collisions.push({
      id: `nmc_${[name, ...ids].join("|")}`,
      type,
      name: display,
      entities: members.map((member) => ({
        id: member.entity.id,
        canonicalName: member.entity.canonicalName,
        type: member.entity.type,
        field: [...new Set(member.fields.map((field) => FIELD_LABEL[field.kind]))].join(", "),
      })),
      chapters: members.map((member) => member.entity.firstAppearance).sort((a, b) => a - b),
      hasMergeRelationship,
      confidence: "high",
      reason: `The ${type === "localized" ? "localized name" : "name"} '${display}' is used by ${members.length} different entities (${members.map((member) => `${member.entity.canonicalName} via ${[...new Set(member.fields.map((field) => FIELD_LABEL[field.kind]))].join("/")}`).join("; ")}).`,
    });
  }
  return collisions.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
