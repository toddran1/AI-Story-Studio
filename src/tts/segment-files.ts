/** Ignore filesystem metadata sidecars such as macOS `._0001.mp3`. */
export function visibleMp3SegmentFiles(entries: readonly string[]): string[] {
  return entries.filter((entry) => !entry.startsWith(".") && entry.endsWith(".mp3")).sort();
}
