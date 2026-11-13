import { describe, expect, it } from "vitest";
import { atomicWrite } from "../src/storage/atomic-write.js";
import { CENSOR_BLEEP_MARKER, CensorAudioService, FfmpegCensorAudioService, buildCensorToneArgs, planCensoredSpeech, prepareCensorSpeech } from "../src/tts/censor-audio.js";
import { TTSProvider } from "../src/tts/provider.js";
import { FishAudioProvider } from "../src/tts/fish/fish-audio.provider.js";
import { TTSRequest } from "../src/tts/types.js";

const request: TTSRequest = { text: "This shit is fucking crazy.", model: "test", bleepStrongProfanity: true, speed: 1, format: "mp3", sampleRate: 44100, bitrate: 128, normalize: true, maxCharsPerRequest: 500 };

describe("censor audio", () => {
  it.each([
    ["[soft]“What a fucking waste.”", ["[soft]“What a,”", "“waste.”"]],
    ['"What a fucking waste."', ['"What a,"', '"waste."']],
    ["“I said ‘don’t fucking touch that,’ you shithead.”", ["“I said ‘don’t,’”", "“‘touch that,’ you,”"]],
    ['"Done." Fuck!', ['"Done."']],
    ["“You little shit!” He stormed out.", ["“You little,”", "He stormed out."]],
    ['"You little shit", he muttered.', ['"You little,"', 'he muttered.']],
  ])("balances the provider text across bleep boundaries: %s", (source, expected) => {
    const plan = planCensoredSpeech(source);
    expect([...prepareCensorSpeech(plan).values()]).toEqual(expected);
  });

  it("drops empty and punctuation-only quotes without removing neighboring dialogue or the bleep", async () => {
    const calls: TTSRequest[] = [];
    const tools = { validateAvailability: async () => undefined, ffmpeg: async (args: string[]) => { await atomicWrite(args.at(-1)!, new Uint8Array([1, 2, 3])); } };
    const service = new FfmpegCensorAudioService(tools as any);
    const result = await service.synthesize(fakeProvider(calls), {
      ...request, text: '"" "!" "." “…” "Keep this." "And this."\n\n“Fuck!” He left.',
    });
    expect(calls.map(call => call.text)).toEqual(['"Keep this." "And this."', 'He left.']);
    expect(result.censorManifest?.items.map(item => item.kind)).toEqual(["speech", "tone", "speech"]);
  });

  it("removes paired emphasis before bleep splitting without consuming multiplication", () => {
    const source = "*What the absolute fuck? If you want to die, don’t drag me down with you!*";
    expect(planCensoredSpeech(source)).toEqual([
      { kind: "speech", text: "What the absolute" },
      expect.objectContaining({ kind: "censor", original: "fuck" }),
      { kind: "speech", text: "If you want to die, don’t drag me down with you!" },
    ]);
    expect(planCensoredSpeech("2 * 2" )).toEqual([{ kind: "speech", text: "2 * 2" }]);
  });

  it.each(["“Fuck?!”\n\n…", '"Fuck!"\n\n...', "[soft]“Fuck?!”[calm]\n\n…", "「Fuck！」\n…"])("omits empty post-bleep dialogue fragments: %s", (ending) => {
    const plan = planCensoredSpeech(`The statues exploded.\n\n${ending}`);
    expect(plan).toEqual([{kind:"speech",text:"The statues exploded."},expect.objectContaining({kind:"censor",original:"Fuck"})]);
    const provider = new FishAudioProvider("fake");
    for (const segment of plan) if (segment.kind === "speech") expect(provider.prepareSegments({...request,model:"s2.1-pro-free",text:segment.text}).length).toBeGreaterThan(0);
  });

  it("retains real speech, numbers and performed vocalization cues around bleeps", () => {
    const plan = planCensoredSpeech('“Fuck!”\n\n[laughing] He counted 42.\n“Shit!”\n你好。');
    expect(plan.filter(s => s.kind === "speech")).toEqual([
      {kind:"speech",text:expect.stringContaining("[laughing] He counted 42.")},
      {kind:"speech",text:expect.stringContaining("你好。")},
    ]);
    expect(plan.filter(s => s.kind === "censor")).toHaveLength(2);
    expect(planCensoredSpeech('“Fuck!”\n“Shit!”').map(s => s.kind)).toEqual(["censor","censor"]);
  });

  it("assembles chapter-ending bleeps without sending an empty request or losing the tone", async () => {
    const calls:TTSRequest[]=[];
    const tools={validateAvailability:async()=>undefined,ffmpeg:async(args:string[])=>{await atomicWrite(args.at(-1)!,new Uint8Array([1,2,3]));}};
    const fish=new FishAudioProvider("fake");
    const fake=fakeProvider(calls);
    const provider:TTSProvider={...fake,synthesize:async value=>{expect(fish.prepareSegments({...value,model:"s2.1-pro-free"}).length).toBeGreaterThan(0);return fake.synthesize(value);}};
    const result=await new FfmpegCensorAudioService(tools as any).synthesize(provider,{...request,text:'The statues exploded.\n\n“Fuck?!”\n\n…'});
    expect(calls).toHaveLength(1);
    expect(result.censorManifest?.items.map(item=>item.kind)).toEqual(["speech","tone"]);
    expect(result.censor?.segments).toBe(1);
    expect(result.providerRequests).toBe(1);
  });

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

  it("keeps a quote before a bleep with the following dialogue", () => {
    const source = "Leo awkwardly scratched his head and apologized awith a grin.\n\n“Bullshit! You think I’m an idiot? You did that on purpose!”";
    const plan = planCensoredSpeech(source);
    expect(plan).toEqual([
      { kind: "speech", text: "Leo awkwardly scratched his head and apologized awith a grin." },
      expect.objectContaining({ kind: "censor", original: "Bullshit" }),
      { kind: "speech", text: "“You think I’m an idiot? You did that on purpose!”" },
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
