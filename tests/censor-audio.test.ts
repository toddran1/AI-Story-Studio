import { describe, expect, it } from "vitest";
import { atomicWrite } from "../src/storage/atomic-write.js";
import { CENSOR_BLEEP_MARKER, CensorAudioService, FfmpegCensorAudioService, buildCensorToneArgs, planCensoredSpeech } from "../src/tts/censor-audio.js";
import { TTSProvider } from "../src/tts/provider.js";
import { TTSRequest } from "../src/tts/types.js";

const request: TTSRequest = { text: "This shit is fucking crazy.", model: "test", bleepStrongProfanity: true, speed: 1, format: "mp3", sampleRate: 44100, bitrate: 128, normalize: true, maxCharsPerRequest: 500 };

describe("censor audio", () => {
  it("keeps ordinary text unchanged when censoring is disabled", async () => {
    const calls: TTSRequest[] = []; const provider = fakeProvider(calls); const service = new FfmpegCensorAudioService() as CensorAudioService;
    // The disabled path never needs FFmpeg and remains provider agnostic.
    await service.synthesize(provider, { ...request, bleepStrongProfanity: false });
    expect(calls).toEqual([expect.objectContaining({ text: request.text, bleepStrongProfanity: false })]);
  });

  it("plans punctuation-safe speech and censor segments at beginning, middle, and end", () => {
    expect(planCensoredSpeech("Fuck! What the fuck are you doing? You're full of shit.")).toEqual([
      expect.objectContaining({ kind: "censor", original: "Fuck" }),
      { kind: "speech", text: "What the" },
      expect.objectContaining({ kind: "censor", original: "fuck" }),
      { kind: "speech", text: "are you doing? You're full of" },
      expect.objectContaining({ kind: "censor", original: "shit" }),
    ]);
    expect(planCensoredSpeech("damn hell ass")).toEqual([{ kind: "speech", text: "damn hell ass" }]);
    expect(planCensoredSpeech("That motherfucking idea is shitty.").filter((segment) => segment.kind === "censor")).toEqual([
      expect.objectContaining({ marker: CENSOR_BLEEP_MARKER, original: "motherfucking" }),
      expect.objectContaining({ marker: CENSOR_BLEEP_MARKER, original: "shitty" }),
    ]);
  });

  it("sends only speech to a provider and inserts deterministic local tone segments", async () => {
    const calls: TTSRequest[] = []; const ffmpegArgs: string[][] = [];
    const tools = { validateAvailability: async () => undefined, ffmpeg: async (args: string[]) => { ffmpegArgs.push(args); await atomicWrite(args.at(-1)!, new Uint8Array([1, 2, 3])); } };
    const service = new FfmpegCensorAudioService(tools as any); const result = await service.synthesize(fakeProvider(calls), request);
    expect(calls.map((value) => value.text)).toEqual(["This,", "is,", "crazy."]);
    expect(calls.every((value) => value.bleepStrongProfanity === false && !/bleep/i.test(value.text) && !value.text.includes(CENSOR_BLEEP_MARKER))).toBe(true);
    expect(result.assembled).toBe(true); expect(result.censor).toMatchObject({ segments: 2 }); expect(result.segments).toHaveLength(3); expect(result.censorManifest?.items).toHaveLength(5);
    expect(ffmpegArgs.filter((args) => args.includes("lavfi"))).toHaveLength(2); expect(ffmpegArgs.at(-1)).toContain("concat");
    const toneArgs = buildCensorToneArgs("tone.mp3", request, .35).join(" ");
    expect(toneArgs).toContain("sine=frequency=1000"); expect(toneArgs).toContain("afade=t=in"); expect(toneArgs).toContain("afade=t=out");
  });
});

function fakeProvider(calls: TTSRequest[]): TTSProvider { return { name: "future-provider", validateConfiguration: async () => undefined, synthesize: async (value) => { calls.push(value); const audio = new Uint8Array([9, 9, 9]); return { audio, segments: [audio], providerRequests: 1 }; } }; }
