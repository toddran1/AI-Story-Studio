import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WhisperCppSpeechTranscriber } from "../src/alignment/transcription.js";
import type { CommandRunner } from "../src/audio/ffmpeg.js";

describe("local transcription GPU fallback", () => {
  it("retries a Metal initialization failure on CPU and remembers the working device", async () => {
    const root = await mkdtemp(join(tmpdir(), "transcription-fallback-"));
    const model = join(root, "model.bin");
    await writeFile(model, "fake");
    const calls: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--help")) return { stdout: "", stderr: "" };
      calls.push([...args]);
      if (!args.includes("-ng")) throw new Error("whisper-cli exited with SIGABRT: GGML_ASSERT(buffer) failed");
      const output = args[args.indexOf("-of") + 1]!;
      await writeFile(`${output}.json`, JSON.stringify({ transcription: [{ text: "After all", offsets: { from: 0, to: 1000 } }] }));
      return { stdout: "", stderr: "" };
    };
    try {
      const transcriber = new WhisperCppSpeechTranscriber("whisper-cli", model, 10000, runner, "auto");
      expect(await transcriber.transcribe({ audioPath: "fake.mp3", language: "en-US" })).toHaveLength(2);
      await transcriber.transcribe({ audioPath: "fake.mp3", language: "en-US" });
      expect(calls.map((args) => args.includes("-ng"))).toEqual([false, true, true]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["auto", "gpu"] as const)("does not retry unrelated errors or override explicit GPU selection (%s)", async (device) => {
    const root = await mkdtemp(join(tmpdir(), "transcription-error-"));
    const model = join(root, "model.bin");
    await writeFile(model, "fake");
    let attempts = 0;
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--help")) return { stdout: "", stderr: "" };
      attempts++;
      throw new Error(device === "gpu" ? "GGML_ASSERT(buffer) failed" : "audio file not found");
    };
    try {
      await expect(new WhisperCppSpeechTranscriber("whisper-cli", model, 10000, runner, device).transcribe({ audioPath: "fake.mp3", language: "en-US" })).rejects.toThrow();
      expect(attempts).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
