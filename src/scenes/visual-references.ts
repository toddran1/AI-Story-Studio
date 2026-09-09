import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fingerprint } from "../utils/hash.js";
import { characterVisualProfileSchema } from "./types.js";

export async function loadCharacterVisualReferences(root: string, slug: string, names: string[]) {
  const base = join(root, "stories", slug, "assets", "characters"); const results: Array<{ name: string; description: string; fingerprint: string }> = [];
  let directories: string[] = []; try { directories = (await readdir(base, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const directory of directories) {
    try { const profile = characterVisualProfileSchema.parse(JSON.parse(await readFile(join(base, directory, "profile.json"), "utf8"))); if (!names.some((name) => name.toLocaleLowerCase() === profile.name.toLocaleLowerCase())) continue;
      let reference: Buffer | undefined; try { reference = await readFile(join(base, directory, "reference.png")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const description = [profile.description, profile.hair && `Hair: ${profile.hair}`, profile.clothing && `Clothing: ${profile.clothing}`, profile.distinctiveFeatures && `Distinctive features: ${profile.distinctiveFeatures}`].filter(Boolean).join(". ");
      results.push({ name: profile.name, description, fingerprint: fingerprint({ profile, reference: reference?.toString("base64") }) });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return results;
}
