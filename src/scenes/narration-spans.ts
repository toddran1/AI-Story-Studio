import type { Scene } from "./types.js";
import type { AlignedWord } from "../alignment/types.js";
import { tokenizeNarration } from "../alignment/quality.js";
import { validateSceneCoverage } from "./timing.js";

export function bindNarrationSpans(scenes: Scene[], narration: string) {
  const words = tokenizeNarration(narration);
  if (words.length < scenes.length) throw new Error("Scene count exceeds narration word count");
  const supplied = scenes.every((scene) => scene.narrationStartWord !== undefined && scene.narrationEndWord !== undefined);
  let cursor = 0;
  return scenes.map((scene, index) => {
    const start = supplied ? scene.narrationStartWord! : cursor;
    const end = supplied ? scene.narrationEndWord! : index === scenes.length - 1 ? words.length :
      Math.max(start + 1, Math.min(words.length - (scenes.length - index - 1), Math.round(scene.endSeconds / scenes.at(-1)!.endSeconds * words.length)));
    if (start !== cursor || end <= start || end > words.length || (index === scenes.length - 1 && end !== words.length))
      throw new Error("Scene narration spans must cover all narration words in order without gaps");
    cursor = end;
    return { ...scene, narrationStartWord: start, narrationEndWord: end, narrationText: words.slice(start, end).join(" ") };
  });
}

export function timeNarrationScenes(scenes: Scene[], duration: number, words?: AlignedWord[]) {
  const lastWord = scenes.at(-1)?.narrationEndWord;
  if (!lastWord) throw new Error("Scene narration spans are missing");
  const usable = words?.length === lastWord && words.every((word, index) => word.end > word.start && word.end <= duration && (!index || word.start >= words[index - 1]!.end));
  const active = scenes.filter((scene) => !scene.disabled);
  if (!active.length) throw new Error("Keep at least one scene enabled");
  let cursor = 0;
  const timed = active.map((scene, index) => {
    const next = active[index + 1];
    const end = next ? usable ? words![next.narrationStartWord!]!.start : duration * next.narrationStartWord! / lastWord : duration;
    if (end <= cursor) throw new Error("Scene alignment produced an empty time range; recheck the narration spans");
    const result = { ...scene, startSeconds: cursor, endSeconds: end }; cursor = end; return result;
  });
  validateSceneCoverage(timed, duration);
  return { scenes: timed, timingMethod: usable ? "aligned" as const : "estimated" as const };
}
