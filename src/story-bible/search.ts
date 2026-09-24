/**
 * Shared entity search normalization: Unicode NFKD, lowercase, combining marks
 * stripped, and every run of non-letter/non-number characters collapsed to a
 * single space. Applied to both the query and the searchable entity text so
 * "Qain Yi", "qain yi", "QAIN-YI", and "Qain-Yi" are the same tokens.
 */
export function normalizeEntitySearch(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
