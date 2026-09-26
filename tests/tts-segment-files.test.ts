import { describe, expect, it } from "vitest";
import { visibleMp3SegmentFiles } from "../src/tts/segment-files.js";

describe("TTS segment directory scanning", () => {
  it("ignores macOS sidecars without hiding unexpected real MP3 files", () => {
    expect(visibleMp3SegmentFiles([
      "._0001.mp3", "0002.mp3", ".DS_Store", "0001.mp3", "._0002.mp3", "unexpected.mp3",
    ])).toEqual(["0001.mp3", "0002.mp3", "unexpected.mp3"]);
  });
});
