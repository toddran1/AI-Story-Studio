import { SubtitleDocument } from "./types.js";
export function toVtt(document: SubtitleDocument) { return `WEBVTT\n\n${document.cues.map((cue) => `${stamp(cue.startSeconds)} --> ${stamp(cue.endSeconds)}\n${cue.text}\n`).join("\n")}\n`; }
function stamp(seconds: number) { const ms = Math.round(seconds * 1000); const hours = Math.floor(ms / 3_600_000); const minutes = Math.floor(ms % 3_600_000 / 60_000); const secs = Math.floor(ms % 60_000 / 1000); return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${String(ms % 1000).padStart(3, "0")}`; }
const pad = (value: number) => String(value).padStart(2, "0");
