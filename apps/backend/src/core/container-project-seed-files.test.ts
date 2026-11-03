import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  formatProjectSeedRefusals,
  parseProjectSeedRefusalLabel,
  PROJECT_SEED_FILE_MAX_BYTES,
  projectSeedRefusalLabel,
  readProjectSeedFiles,
} from "./container-project-seed-files.js";

// Every link here points at throwaway files these tests create; none names a
// real home file, key or socket.
const directories: string[] = [];
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ork-project-seed-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function outsideSecret(): Promise<{ dir: string; file: string }> {
  const dir = await tempDir();
  const file = path.join(dir, "host-secret");
  await writeFile(file, "HOST_ONLY=1\n");
  return { dir, file };
}

test("regular files are read with their contents and mapped to their container paths", async () => {
  const project = await tempDir();
  await writeFile(path.join(project, ".env"), "A=1\n");
  await writeFile(path.join(project, ".env.local"), "B=2\n");
  await writeFile(path.join(project, "opencode.json"), '{"model":"x"}');

  const result = await readProjectSeedFiles(project);

  expect(result.refused).toEqual([]);
  expect(
    result.accepted.map(({ name, target, contents }) => [name, target, contents.toString()]),
  ).toEqual([
    [".env", "project-env/.env", "A=1\n"],
    [".env.local", "project-env/.env.local", "B=2\n"],
    ["opencode.json", "opencode-project-json", '{"model":"x"}'],
  ]);
});

test("missing files are neither accepted nor refused", async () => {
  const project = await tempDir();
  expect(await readProjectSeedFiles(project)).toEqual({ accepted: [], refused: [] });
  expect(await readProjectSeedFiles(path.join(project, "missing"))).toEqual({
    accepted: [],
    refused: [],
  });
});

test("an absolute link to a file outside the project is refused", async () => {
  const project = await tempDir();
  const secret = await outsideSecret();
  await symlink(secret.file, path.join(project, ".env"));

  const result = await readProjectSeedFiles(project);

  expect(result.accepted).toEqual([]);
  expect(result.refused).toEqual([{ name: ".env", reason: "symlink" }]);
});

test("a relative link climbing out of the project is refused", async () => {
  const project = await tempDir();
  const secret = await outsideSecret();
  await symlink(path.relative(project, secret.dir), path.join(project, ".env.local"));
  await symlink(path.relative(project, secret.file), path.join(project, "opencode.json"));

  const result = await readProjectSeedFiles(project);

  expect(result.accepted).toEqual([]);
  expect(result.refused).toEqual([
    { name: ".env.local", reason: "symlink" },
    { name: "opencode.json", reason: "symlink" },
  ]);
});

test("a link to another file inside the project is still refused", async () => {
  const project = await tempDir();
  await writeFile(path.join(project, "shared.env"), "A=1\n");
  await symlink("shared.env", path.join(project, ".env"));

  const result = await readProjectSeedFiles(project);

  expect(result.refused).toEqual([{ name: ".env", reason: "symlink" }]);
});

test("a dangling link is refused rather than treated as missing", async () => {
  const project = await tempDir();
  await symlink(path.join(project, "nowhere"), path.join(project, ".env"));

  expect((await readProjectSeedFiles(project)).refused).toEqual([
    { name: ".env", reason: "symlink" },
  ]);
});

test("a directory is refused", async () => {
  const project = await tempDir();
  await mkdir(path.join(project, ".env"));
  await writeFile(path.join(project, ".env", "inner"), "A=1\n");

  expect((await readProjectSeedFiles(project)).refused).toEqual([
    { name: ".env", reason: "not-a-file" },
  ]);
});

test("a FIFO is refused without blocking", async () => {
  const project = await tempDir();
  const made = spawnSync("mkfifo", [path.join(project, "opencode.json")]);
  if (made.status !== 0) return; // No mkfifo on this host.

  expect((await readProjectSeedFiles(project)).refused).toEqual([
    { name: "opencode.json", reason: "not-a-file" },
  ]);
});

test("a file over the size bound is refused", async () => {
  const project = await tempDir();
  await writeFile(path.join(project, ".env"), Buffer.alloc(PROJECT_SEED_FILE_MAX_BYTES + 1));
  await writeFile(path.join(project, ".env.local"), Buffer.alloc(PROJECT_SEED_FILE_MAX_BYTES));

  const result = await readProjectSeedFiles(project);

  expect(result.refused).toEqual([{ name: ".env", reason: "too-large" }]);
  expect(result.accepted.map((file) => [file.name, file.contents.length])).toEqual([
    [".env.local", PROJECT_SEED_FILE_MAX_BYTES],
  ]);
});

test("a project reached through a linked path still accepts its own files", async () => {
  const real = await tempDir();
  await writeFile(path.join(real, ".env"), "A=1\n");
  const alias = path.join(await tempDir(), "project-link");
  await symlink(real, alias);

  const result = await readProjectSeedFiles(alias);

  expect(result.refused).toEqual([]);
  expect(result.accepted.map((file) => file.name)).toEqual([".env"]);
});

test("the refusal label round-trips and ignores entries outside its vocabulary", () => {
  const refused = [
    { name: ".env", reason: "symlink" },
    { name: "opencode.json", reason: "outside-project" },
  ] as const;
  const label = projectSeedRefusalLabel(refused);
  expect(label).toBe(".env=symlink,opencode.json=outside-project");
  expect(parseProjectSeedRefusalLabel(label)).toEqual([...refused]);
  expect(
    parseProjectSeedRefusalLabel("id_rsa=symlink,.env=whatever,.env.local=not-a-file,,="),
  ).toEqual([{ name: ".env.local", reason: "not-a-file" }]);
  expect(parseProjectSeedRefusalLabel(null)).toEqual([]);
});

test("each refusal is explained in one setup terminal line", () => {
  expect(
    formatProjectSeedRefusals([
      { name: ".env", reason: "symlink" },
      { name: "opencode.json", reason: "not-a-file" },
    ]),
  ).toEqual([
    "[orkestrator] Skipped .env from the project folder: it is a symbolic link. Only a regular file inside the project is copied into the container.",
    "[orkestrator] Skipped opencode.json from the project folder: it is not a regular file. Only a regular file inside the project is copied into the container.",
  ]);
});

test("fallback seed links and directories are refused by the same reader", async () => {
  const project = await tempDir();
  const fallback = await tempDir();
  await writeFile(path.join(fallback, "shared.env"), "FALLBACK=1");
  await symlink("shared.env", path.join(fallback, ".env"));
  await mkdir(path.join(fallback, "opencode.json"));
  const result = await readProjectSeedFiles(project, fallback, [".env", "opencode.json"]);
  expect(result.accepted).toEqual([]);
  expect(result.refused).toEqual([
    { name: ".env", reason: "symlink" },
    { name: "opencode.json", reason: "not-a-file" },
  ]);
});
