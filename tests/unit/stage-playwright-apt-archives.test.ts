import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stagePlaywrightAptArchives } from "../../scripts/stage-playwright-apt-archives";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function cacheFixture() {
  const root = await mkdtemp(join(tmpdir(), "ork-ci-apt-"));
  dirs.push(root);
  const cache = join(root, "cache");
  const staging = join(root, "staging");
  await Promise.all([mkdir(cache), mkdir(staging)]);
  return { cache, staging };
}

function packageRecord(name: string, version: string, contents: string): string[] {
  return [
    `Package: ${name}`,
    `Version: ${version}`,
    "Architecture: amd64",
    `Filename: pool/${name}.deb`,
    `SHA256: ${createHash("sha256").update(contents).digest("hex")}`,
    "",
  ];
}

async function* records(...stanzas: string[][]) {
  for (const stanza of stanzas) yield* stanza;
}

test("stages only regular archives matching the candidate filename and SHA-256", async () => {
  const { cache, staging } = await cacheFixture();
  const valid = "valid_2%3a1.0-1_amd64.deb";
  await Promise.all([
    writeFile(join(cache, valid), "valid data"),
    writeFile(join(cache, "corrupt_1_amd64.deb"), "invalid"),
    writeFile(join(cache, "wrong-package_1_amd64.deb"), "valid data"),
    writeFile(join(cache, "ambiguous_1_amd64.deb"), "first"),
    symlink(valid, join(cache, "link_1_amd64.deb")),
  ]);

  const staged = await stagePlaywrightAptArchives(
    cache,
    staging,
    records(
      packageRecord("valid", "2:1.0-1", "valid data"),
      packageRecord("corrupt", "1", "correct"),
      packageRecord("wrong-package", "1", "other data"),
      packageRecord("ambiguous", "1", "first"),
      packageRecord("ambiguous", "1", "other"),
      packageRecord("link", "1", "valid data"),
    ),
  );
  expect(staged).toBe(1);
  expect(await readdir(staging)).toEqual([valid]);
  expect(await readFile(join(staging, valid), "utf8")).toBe("valid data");
});

test("a changed candidate bypasses the old archive and reuses the replacement on a later restore", async () => {
  const { cache, staging } = await cacheFixture();
  await writeFile(join(cache, "pkg_1_amd64.deb"), "old version");
  const candidate = packageRecord("pkg", "2", "new version");
  expect(await stagePlaywrightAptArchives(cache, staging, records(candidate))).toBe(0);
  expect(await readdir(staging)).toEqual([]);

  const replacement = "pkg_2_amd64.deb";
  await writeFile(join(cache, replacement), "new version");
  expect(await stagePlaywrightAptArchives(cache, staging, records(candidate))).toBe(1);
  expect(await readdir(staging)).toEqual([replacement]);
});
