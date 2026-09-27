import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJsonIfExists } from "../storage/story-files.js";

export async function storiesUsingMusic(root: string, type: "track" | "bed", id: string) {
  const directory = join(root, "stories"); const entries = await readdir(directory, { withFileTypes: true }).catch(() => []); const matches: string[] = [];
  for (const entry of entries) { if (!entry.isDirectory() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) continue; const raw = await readJsonIfExists(join(directory, entry.name, "story.json")).catch(() => undefined); const settings = (raw as { backgroundMusic?: { defaultTrackId?: string; defaultSelection?: { type?: string; id?: string } } } | undefined)?.backgroundMusic; if (settings?.defaultSelection?.type === type && settings.defaultSelection.id === id || type === "track" && !settings?.defaultSelection && settings?.defaultTrackId === id) matches.push(entry.name); }
  return matches;
}
