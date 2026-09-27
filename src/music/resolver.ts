import { Story } from "../domain/story.js";
import { FfmpegTools } from "../audio/ffmpeg.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { getMusicTrack, musicTrackPath } from "./library.js";
import { MUSIC_PRESET_GAIN_DB, backgroundMusicSettingsSchema, exportMusicSelectionSchema, musicOverridesSchema, type ExportMusicSelection, type ResolvedExportMusic } from "./types.js";
import { listMusicBeds } from "./music-bed.js";

export async function resolveExportMusic(root: string, story: Story, rawSelection: ExportMusicSelection = { mode: "none" }, rawOverrides?: unknown, tools = new FfmpegTools()): Promise<ResolvedExportMusic | undefined> {
  const selection = exportMusicSelectionSchema.parse(rawSelection); if (selection.mode === "none") return undefined;
  const overrides = musicOverridesSchema.parse(rawOverrides ?? {});
  const settings = backgroundMusicSettingsSchema.parse({ ...story.backgroundMusic, ...overrides, ducking: { ...story.backgroundMusic.ducking, ...overrides.ducking } });
  const chosen = selection.mode === "story_default" ? settings.defaultSelection : undefined;
  const bedId = selection.mode === "bed" ? selection.bedId : chosen?.type === "bed" ? chosen.id : undefined;
  const id = selection.mode === "track" ? selection.trackId : chosen?.type === "track" ? chosen.id : settings.defaultTrackId;
  const bed = bedId ? (await listMusicBeds(root)).find((item) => item.id === bedId) : undefined;
  if (bedId && !bed) throw new Error("Selected music bed is no longer available.");
  if (bed) {
    const resolved = await Promise.all(bed.tracks.map(async (entry) => { const track = await getMusicTrack(root, entry.trackId); if (!track) throw new Error(`Music bed track ${entry.trackId} is missing`); const path = musicTrackPath(root, track); if (await fileFingerprint(path) !== track.fingerprint) throw new Error(`Music bed track ${track.title} is missing or changed`); const probe = await tools.probe(path); if (!(probe.durationSeconds > 0)) throw new Error("Music bed track has no audio"); return { track, path }; }));
    const gainDb = settings.level === "custom" ? settings.customGainDb! : MUSIC_PRESET_GAIN_DB[settings.level];
    return { mode: selection.mode, track: resolved[0]!.track, path: resolved[0]!.path, bed: { id: bed.id, name: bed.name, fingerprint: bed.revision, playbackMode: bed.playbackMode, crossfadeSeconds: bed.crossfadeSeconds, tracks: resolved }, gainDb, ducking: settings.ducking, fadeInSeconds: settings.fadeInSeconds, fadeOutSeconds: settings.fadeOutSeconds, loopMode: settings.loopMode };
  }
  if (!id) throw new Error("The story has no default background music. Choose a track or export without music.");
  const track = await getMusicTrack(root, id);
  if (!track) throw new Error(selection.mode === "story_default" ? "The story's default background music is no longer available. Choose another track or export without music." : "Selected background music track is no longer available.");
  const path = musicTrackPath(root, track); if (await fileFingerprint(path) !== track.fingerprint) throw new Error("Background music file is missing or changed. Reimport the track before exporting.");
  const probe = await tools.probe(path); if (!(probe.durationSeconds > 0)) throw new Error("Background music has no valid audio stream.");
  const gainDb = settings.level === "custom" ? settings.customGainDb! : MUSIC_PRESET_GAIN_DB[settings.level];
  return { mode: selection.mode, track, path, gainDb, ducking: settings.ducking, fadeInSeconds: settings.fadeInSeconds, fadeOutSeconds: settings.fadeOutSeconds, loopMode: settings.loopMode };
}
