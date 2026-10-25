import { promises as fs } from "node:fs";
import path from "node:path";
import { validateRelativeFilePath } from "../path-safety.js";

export const SEED_MANIFEST = ".orkestrator-seed-manifest.json";

/** Only completed, hash-verified uploads belong in the setup copy list. */
export async function readSeedManifest(root: string): Promise<string[]> {
  const text = await fs
    .readFile(path.join(root, SEED_MANIFEST), "utf8")
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "[]";
      throw error;
    });
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("Seed manifest is too large.");
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length > 1000) throw new Error("Invalid seed manifest.");
  return value.map((entry: unknown) => {
    if (typeof entry !== "string") throw new Error("Invalid seed path.");
    const safe = validateRelativeFilePath(entry, "seed file");
    if (safe === SEED_MANIFEST || safe.split(/[\\/]/).some((part) => part.toLowerCase() === ".git"))
      throw new Error("Protected seed path.");
    return safe;
  });
}

export async function recordSeedFile(root: string, relativePath: string): Promise<void> {
  const entries = await readSeedManifest(root);
  if (!entries.includes(relativePath)) entries.push(relativePath);
  if (entries.length > 1000) throw new Error("Seed manifest is full.");
  const file = path.join(root, SEED_MANIFEST);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(entries), { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
}
