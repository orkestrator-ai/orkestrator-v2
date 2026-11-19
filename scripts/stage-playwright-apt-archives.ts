import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** Stage regular cache files whose names and SHA-256 match apt-cache dumpavail. */
export async function stagePlaywrightAptArchives(
  cacheDir: string,
  stageDir: string,
  packageRecords: AsyncIterable<string>,
): Promise<number> {
  const restored = new Set(
    (await readdir(cacheDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".deb"))
      .map((entry) => entry.name),
  );
  const expected = new Map<string, string | null>();
  let fields: Record<string, string> = {};
  // dumpavail emits Deb822 stanzas separated by blank lines. The runner's
  // signed package indexes supply Filename and SHA256. dpkg status does not.
  for await (const line of packageRecords) {
    if (line) {
      const match = /^(Package|Version|Architecture|Filename|SHA256): (\S+)$/.exec(line);
      if (match) fields[match[1]!] = match[2]!;
      continue;
    }
    const { Package, Version, Architecture, Filename, SHA256 } = fields;
    fields = {};
    if (!Package || !Version || !Architecture || !Filename?.endsWith(".deb")) continue;
    if (!SHA256 || !/^[0-9a-f]{64}$/.test(SHA256)) continue;
    // APT names completed archives from the package identity, including the
    // escaped epoch. The remote Filename can omit the epoch.
    const name = `${Package}_${Version.replaceAll(":", "%3a")}_${Architecture}.deb`;
    if (!restored.has(name)) continue;
    const previous = expected.get(name);
    expected.set(name, previous === undefined || previous === SHA256 ? SHA256 : null);
  }

  let staged = 0;
  for (const [name, digest] of expected) {
    if (!digest) continue;
    const destination = join(stageDir, name);
    await copyFile(join(cacheDir, name), destination);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(destination)) hash.update(chunk);
    if (hash.digest("hex") === digest) {
      staged += 1;
    } else {
      await unlink(destination);
    }
  }
  return staged;
}

if (import.meta.main) {
  const [cacheDir, stageDir] = Bun.argv.slice(2);
  if (!cacheDir || !stageDir)
    throw new Error("Expected a cache directory and a private staging directory");
  const records = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const staged = await stagePlaywrightAptArchives(cacheDir, stageDir, records);
  console.log(`Verified ${staged} cached APT archives`);
}
