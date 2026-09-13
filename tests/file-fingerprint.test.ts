import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileFingerprint, filesFingerprint } from "../src/utils/file-fingerprint.js";
import { fingerprint } from "../src/utils/hash.js";

describe("streaming file fingerprints", () => {
  it("preserves the legacy fingerprints without reading whole files", async () => {
    const root = await mkdtemp(join(tmpdir(), "fingerprint-")); const first = Buffer.alloc(64 * 1024 + 2, 17); const second = Buffer.from("second file");
    const a = join(root, "a.bin"); const b = join(root, "b.bin"); await writeFile(a, first); await writeFile(b, second);
    expect(await fileFingerprint(a)).toBe(fingerprint(first.toString("base64")));
    expect(await filesFingerprint([a, b])).toBe(fingerprint([first.toString("base64"), second.toString("base64")]));
    expect(await fileFingerprint(join(root, "missing"))).toBeUndefined();
  });
});
