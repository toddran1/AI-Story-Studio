import { Story } from "../domain/story.js";
import { FfmpegTools } from "../audio/ffmpeg.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { getMusicTrack, musicTrackPath } from "./library.js";
import { MUSIC_PRESET_GAIN_DB, backgroundMusicSettingsSchema, exportMusicSelectionSchema, musicOverridesSchema, type ExportMusicSelection, type ResolvedExportMusic } from "./types.js";

export async function resolveExportMusic(root: string, story: Story, rawSelection: ExportMusicSelection = { mode: "none" }, rawOverrides?: unknown, tools = new FfmpegTools()): Promise<ResolvedExportMusic | undefined> {
  const selection = exportMusicSelectionSchema.parse(rawSelection); if (selection.mode === "none") return undefined;
  const overrides = musicOverridesSchema.parse(rawOverrides ?? {});
  const settings = backgroundMusicSettingsSchema.parse({ ...story.backgroundMusic, ...overrides, ducking: { ...story.backgroundMusic.ducking, ...overrides.ducking } });
  const id = selection.mode === "track" ? selection.trackId : settings.defaultTrackId;
  if (!id) throw new Error("The story has no default background music. Choose a track or export without music.");
  const track = await getMusicTrack(root, id);
  if (!track) throw new Error(selection.mode === "story_default" ? "The story's default background music is no longer available. Choose another track or export without music." : "Selected background music track is no longer available.");
  const path = musicTrackPath(root, track); if (await fileFingerprint(path) !== track.fingerprint) throw new Error("Background music file is missing or changed. Reimport the track before exporting.");
  const probe = await tools.probe(path); if (!(probe.durationSeconds > 0)) throw new Error("Background music has no valid audio stream.");
  const gainDb = settings.level === "custom" ? settings.customGainDb! : MUSIC_PRESET_GAIN_DB[settings.level];
  return { mode: selection.mode, track, path, gainDb, ducking: settings.ducking, fadeInSeconds: settings.fadeInSeconds, fadeOutSeconds: settings.fadeOutSeconds, loopMode: settings.loopMode };
}
