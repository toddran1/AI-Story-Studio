import type { Scene } from "./types.js";
import type { AlignedWord } from "../alignment/types.js";
import { tokenizeNarration } from "../alignment/quality.js";
import { boundedDurations, validateSceneCoverage } from "./timing.js";

export function bindNarrationSpans(scenes: Scene[], narration: string) {
  const words = tokenizeNarration(narration);
  if (words.length < scenes.length) throw new Error("Scene count exceeds narration word count");
  const supplied = scenes.every((scene) => scene.narrationStartWord !== undefined && scene.narrationEndWord !== undefined);
  let cursor = 0;
  return scenes.map((scene, index) => {
    const remaining = scenes.length - index - 1;
    // Supplied LLM spans are normalized to a contiguous cover: starts continue
    // where the previous scene ended (absorbing gaps/overlaps), ends are
    // preserved as the beat boundaries but clamped to leave one word per
    // remaining scene.
    const start = cursor;
    const end = supplied
      ? index === scenes.length - 1
        ? words.length
        : Math.max(start + 1, Math.min(scene.narrationEndWord!, words.length - remaining))
      : index === scenes.length - 1 ? words.length :
        Math.max(start + 1, Math.min(words.length - remaining, Math.round(scene.endSeconds / scenes.at(-1)!.endSeconds * words.length)));
    if (start !== cursor || end <= start || end > words.length)
      throw new Error("Scene narration spans must cover all narration words in order without gaps");
    cursor = end;
    return { ...scene, narrationStartWord: start, narrationEndWord: end, narrationText: words.slice(start, end).join(" ") };
  });
}

export function timeNarrationScenes(scenes: Scene[], duration: number, words?: AlignedWord[]) {
  const active = scenes.filter((scene) => !scene.disabled);
  const lastWord = active.at(-1)?.narrationEndWord;
  if (!lastWord) throw new Error("Scene narration spans are missing");
  const usable = words?.length === lastWord && words.every((word, index) => word.end > word.start && word.end <= duration && (!index || word.start >= words[index - 1]!.end));
  if (!active.length) throw new Error("Keep at least one scene enabled");
  // Estimated word timing can leave the final visual beat on screen for a
  // fraction of a second. Keep every scene visible for a useful minimum while
  // still ending exactly with the mastered audio.
  const estimatedDurations = usable ? undefined : boundedDurations(
    active.map((scene, index) => Math.max(1, (active[index + 1]?.narrationStartWord ?? lastWord) - scene.narrationStartWord!)),
    duration, Math.min(2, duration / active.length), duration);
  let cursor = 0;
  const timed = active.map((scene, index) => {
    const next = active[index + 1];
    const end = next ? usable ? words![next.narrationStartWord!]!.start : cursor + estimatedDurations![index]! : duration;
    if (end <= cursor) throw new Error("Scene alignment produced an empty time range; recheck the narration spans");
    const result = { ...scene, startSeconds: cursor, endSeconds: end }; cursor = end; return result;
  });
  validateSceneCoverage(timed, duration);
  return { scenes: timed, timingMethod: usable ? "aligned" as const : "estimated" as const };
}

/** Chapter stills follow spoken beat boundaries when a current alignment is
 * available. Fall back to bounded word-weighted pacing, never stale timings. */
export function timeChapterNarrationScenes(scenes: Scene[], duration: number, settings: import("./types.js").SceneSettings, words?: AlignedWord[], preferWordWeights = true) {
  const lastWord = scenes.at(-1)?.narrationEndWord;
  const usable = Boolean(lastWord && words?.length === lastWord && words.every((word,index) => word.end > word.start && word.end <= duration && (!index || word.start >= words[index-1]!.end)));
  if (usable) {
    const aligned = scenes.map((scene,index) => ({ ...scene, startSeconds: index ? words![scene.narrationStartWord!]!.start : 0, endSeconds: index === scenes.length-1 ? duration : words![scenes[index+1]!.narrationStartWord!]!.start }));
    try { validateSceneCoverage(aligned,duration,settings); return aligned; } catch { /* The requested minimum/maximum still duration remains authoritative. */ }
  }
  if (!preferWordWeights) return scenes;
  const durations = boundedDurations(scenes.map(s => Math.max(1,(s.narrationEndWord ?? 1)-(s.narrationStartWord ?? 0))),duration,Math.min(duration,settings.minimumDurationSeconds),settings.maximumDurationSeconds);
  let cursor=0;
  return scenes.map((scene,index) => { const start=cursor; cursor=index===scenes.length-1?duration:cursor+durations[index]!; return { ...scene,startSeconds:Math.round(start * 1000) / 1000,endSeconds:Math.round(cursor * 1000) / 1000 }; });
}
