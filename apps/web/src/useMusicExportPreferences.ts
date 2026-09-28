import { useEffect, useState } from "react";
import { exportMusicSelectionSchema, musicOverridesSchema } from "../../../src/music/types.js";
import type { MusicSelection, MusicOverrides } from "./BackgroundMusicControls.js";

/** Browser preferences only; these never change book defaults or source media. */
export function useMusicExportPreferences(key: string) {
  const [music, setMusic] = useState<MusicSelection>({ mode: "none" });
  const [overrides, setOverrides] = useState<MusicOverrides>({});
  const [loadedKey, setLoadedKey] = useState("");
  useEffect(() => {
    let selection: MusicSelection = { mode: "none" }, settings: MusicOverrides = {};
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? "null");
      const parsed = exportMusicSelectionSchema.safeParse(raw?.music), mix = musicOverridesSchema.safeParse(raw?.overrides);
      if (parsed.success) selection = parsed.data;
      if (mix.success) settings = mix.data;
    } catch { /* Browser storage is optional. */ }
    setMusic(selection); setOverrides(settings); setLoadedKey(key);
  }, [key]);
  useEffect(() => {
    if (loadedKey !== key) return;
    try { localStorage.setItem(key, JSON.stringify({ music, overrides })); } catch { /* Exporting remains available. */ }
  }, [key, loadedKey, music, overrides]);
  return { music, setMusic, overrides, setOverrides };
}
