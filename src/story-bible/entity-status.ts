import type { CanonicalEntity } from "../domain/story-bible.js";

export type EntityStatusOption = { value: string; label: string };

const options = (labels: string[]) => labels.map((label) => ({ value: statusKey(label), label }));
const character = options(["Unknown", "Alive", "Dead", "Presumed dead", "Missing", "Disappeared", "Captured", "Imprisoned", "Detained", "Kidnapped", "Incapacitated", "Unconscious", "Comatose", "Injured", "Critically injured", "Dying", "Recovering", "Resurrected", "Revived", "Reincarnated", "Undead", "Spirit / Ghost", "Possessed", "Controlled", "Corrupted", "Cursed", "Sealed", "Petrified", "Frozen / Suspended", "Hibernating / Dormant", "Transformed", "Ascended", "Exiled", "Banished", "Retired", "In hiding", "Fugitive", "Defected", "Inactive", "Unknown whereabouts"]);
const location = options(["Unknown", "Existing", "Active", "Occupied", "Unoccupied", "Abandoned", "Ruined", "Damaged", "Heavily damaged", "Destroyed", "Rebuilt", "Under construction", "Under repair", "Under siege", "Occupied by enemy", "Contested", "Conquered", "Liberated", "Evacuated", "Quarantined", "Restricted", "Inaccessible", "Hidden", "Discovered", "Lost", "Sealed", "Unsealed", "Collapsed", "Submerged", "Isolated", "Relocated", "Transformed", "Inactive"]);
const organization = options(["Unknown", "Active", "Forming", "Established", "Growing", "Allied", "Neutral", "Hostile", "At war", "At peace", "Divided", "Fractured", "In conflict", "Weakened", "Defeated", "Conquered", "Occupied", "Disbanded", "Dissolved", "Destroyed", "Collapsed", "Absorbed", "Merged", "Reformed", "Reorganized", "Rebuilt", "Exiled", "Underground", "Hidden", "Dormant", "Inactive", "Extinct"]);
const item = options(["Unknown", "Existing", "Intact", "Active", "Inactive", "Equipped", "Unequipped", "Stored", "Hidden", "Lost", "Missing", "Stolen", "Recovered", "Found", "Destroyed", "Damaged", "Broken", "Repaired", "Upgraded", "Transformed", "Sealed", "Unsealed", "Locked", "Unlocked", "Activated", "Deactivated", "Depleted", "Recharged", "Consumed", "Expended", "Duplicated", "Fragmented", "Incomplete", "Completed", "Dormant", "Cursed", "Purified"]);
const ability = options(["Unknown", "Known", "Learned", "Acquired", "Active", "Inactive", "Available", "Unavailable", "Locked", "Unlocked", "Sealed", "Unsealed", "Suppressed", "Disabled", "Lost", "Forgotten", "Restored", "Upgraded", "Evolved", "Awakened", "Mastered", "Partially mastered", "Developing", "Dormant", "Exhausted", "Depleted", "Cooldown", "Temporary", "Permanent", "Removed", "Stolen", "Transferred", "Corrupted"]);
const generic = options(["Unknown", "Active", "Inactive", "Existing", "Ended", "Ongoing", "Pending", "Completed", "Failed", "Cancelled", "Dormant", "Hidden", "Revealed", "Discovered", "Lost", "Destroyed", "Changed", "Transformed", "Deprecated", "Resolved", "Unresolved"]);

export function statusKey(value: string) { return value.trim().toLocaleLowerCase().replaceAll("/", " ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
export function getEntityStatusOptions(type: CanonicalEntity["type"] | string): EntityStatusOption[] {
  if (type === "character") return character;
  if (type === "location") return location;
  if (type === "organization") return organization;
  if (type === "item") return item;
  if (type === "ability") return ability;
  return generic;
}
export function normalizeEntityStatus(type: CanonicalEntity["type"] | string, value: string) {
  const trimmed = value.trim(); const key = statusKey(trimmed);
  return getEntityStatusOptions(type).some((option) => option.value === key) ? key : trimmed;
}
export function isStandardEntityStatus(type: CanonicalEntity["type"] | string, value: string) {
  return getEntityStatusOptions(type).some((option) => option.value === statusKey(value));
}
