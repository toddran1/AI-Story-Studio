import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../apps/web/src/api.js";

afterEach(() => vi.unstubAllGlobals());
describe("binary upload transport", () => {
  it("sends audio blobs as octet-stream while preserving bytes and metadata headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "track" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const audio = new Blob(["audio bytes"], { type: "audio/mpeg" });
    await api("/music/tracks", { method: "POST", body: audio, headers: { "X-File-Name": "Paper_Umbrella.mp3", "X-Music-Metadata": "%7B%7D" } });
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/music/tracks");
    expect(options.body).toBe(audio);
    expect(options.headers).toMatchObject({ "content-type": "application/octet-stream", "X-File-Name": "Paper_Umbrella.mp3", "X-Music-Metadata": "%7B%7D" });
  });
  it("sets octet-stream for ArrayBuffers and keeps JSON requests unchanged", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await api("/upload", { method: "POST", body: new ArrayBuffer(4) });
    await api("/settings", { method: "PUT", body: "{}" });
    expect(fetchMock.mock.calls[0]![1].headers["content-type"]).toBe("application/octet-stream");
    expect(fetchMock.mock.calls[1]![1].headers["content-type"]).toBe("application/json");
  });
});
