import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, CommandRunner } from "../audio/ffmpeg.js";
import { ConfigurationError } from "../pipeline/errors.js";
import { access } from "node:fs/promises";
import type { AlignmentObservation } from "./types.js";
import type { SpeechTranscriber } from "../tts/quality-guard.js";
import { parseWhisperJson } from "./whisper-cpp.js";

/** SpeechTranscriber over whisper.cpp. Reuses the same executable/model
 * configuration and JSON parsing as forced alignment; verification degrades to
 * "unverified" when this transcriber is unavailable. */
export class WhisperCppSpeechTranscriber implements SpeechTranscriber {
  readonly name = "whisper-cpp";
  private validation?: Promise<void>;
  constructor(private readonly executable = "whisper-cli", private readonly configuredModel?: string, private readonly timeoutMs = 1_800_000, private readonly runner: CommandRunner = runCommand, private readonly device: "auto" | "cpu" | "gpu" = "auto") {}

  validateConfiguration() { return this.validation ??= this.checkConfiguration(); }

  private async checkConfiguration() {
    if (!this.configuredModel) throw new ConfigurationError("Whisper.cpp transcription requires ALIGNMENT_MODEL to point to a local ggml model file");
    try { await access(this.configuredModel); } catch (error) { throw new ConfigurationError(`Whisper.cpp alignment model was not found at ${this.configuredModel}`, { cause: error }); }
    try { await this.runner(this.executable, ["--help"], Math.min(this.timeoutMs, 60_000)); } catch (error) { throw new ConfigurationError(`Whisper.cpp executable '${this.executable}' is unavailable. Install whisper.cpp or set ALIGNMENT_EXECUTABLE.`, { cause: error }); }
  }

  async transcribe(request: { audioPath: string; language: string }): Promise<AlignmentObservation[]> {
    await this.validateConfiguration();
    const directory = await mkdtemp(join(tmpdir(), "ai-story-transcribe-"));
    const output = join(directory, "whisper");
    try {
      const args = ["-m", this.configuredModel!, "-f", request.audioPath, "-ojf", "-of", output, "-np", "-sow", "-ml", "1", "-l", request.language.trim().toLowerCase().split(/[-_]/)[0] || "auto"];
      if (this.device === "cpu") args.push("-ng");
      await this.runner(this.executable, args, this.timeoutMs);
      return parseWhisperJson(JSON.parse(await readFile(`${output}.json`, "utf8")));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
