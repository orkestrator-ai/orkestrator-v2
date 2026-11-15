import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extract } from "tar-stream";

import { DEFAULT_ENV_FILE_PATTERNS } from "@orkestrator/protocol/app-config-defaults";
import { withDockerScript } from "../../tests/container-lifecycle-fixtures.js";
import {
  copyProjectSeedFilesIntoContainer,
  ENV_FILE_PATTERNS_REFUSAL_NAME,
  filesLeftForConfiguredCopy,
  PROJECT_SEED_FILE_MAX_BYTES,
  projectSeedReadPlan,
  readProjectSeedFiles,
  rememberWorktreeSeedRefusals,
  takeWorktreeSeedRefusals,
  writeProjectSeedFilesToWorktree,
} from "./container-project-seed-files.js";
import {
  ENV_FILE_PATTERN_LIMITS,
  findEnvFilePatternCandidates,
  parseEnvFilePattern,
} from "./project-env-file-patterns.js";

// Every link here points at throwaway files these tests create; none names a
// real home file, key or socket.
const directories: string[] = [];
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ork-env-patterns-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function files(root: string, entries: Record<string, string | Buffer>): Promise<void> {
  for (const [name, contents] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), contents);
  }
}

function summary(result: Awaited<ReturnType<typeof readProjectSeedFiles>>) {
  return result.accepted.map(({ name, target, contents }) => [name, target, contents.toString()]);
}

test("the default patterns copy exactly today's .env and .env.local", async () => {
  expect([...DEFAULT_ENV_FILE_PATTERNS]).toEqual([".env", ".env.local"]);
  const project = await tempDir();
  await files(project, {
    ".env": "A=1\n",
    ".env.local": "B=2\n",
    ".env.production": "C=3\n",
    "config/.env": "D=4\n",
  });
  const result = await readProjectSeedFiles(project, { includeOpenCodeConfig: false });
  expect(result.refused).toEqual([]);
  expect(summary(result)).toEqual([
    [".env", "project-env/.env", "A=1\n"],
    [".env.local", "project-env/.env.local", "B=2\n"],
  ]);
});

test("wildcards match within one segment and land under project-files", async () => {
  const project = await tempDir();
  await files(project, {
    ".env": "A=1\n",
    ".env.local": "B=2\n",
    ".env.test": "C=3\n",
    ".envrc": "not matched",
    "config/app.env": "D=4\n",
    "config/deep/app.env": "not matched: * stays in one segment",
    "config/.hidden.env": "not matched: * skips dot names",
  });
  const result = await readProjectSeedFiles(project, {
    envFilePatterns: [".env*.*", ".env", "config/*.env"],
    includeOpenCodeConfig: false,
  });
  expect(result.refused).toEqual([]);
  expect(summary(result)).toEqual([
    [".env.local", "project-env/.env.local", "B=2\n"],
    [".env.test", "project-files/.env.test", "C=3\n"],
    [".env", "project-env/.env", "A=1\n"],
    ["config/app.env", "project-files/config/app.env", "D=4\n"],
  ]);
});

test("a wildcard never matches a dot name it does not start with, nor .git", async () => {
  const project = await tempDir();
  await files(project, {
    "visible.txt": "V",
    ".secret": "S",
    ".git/config": "[remote] url=https://token@example.invalid",
  });
  const found = await findEnvFilePatternCandidates(project, ["*", ".*", "*/config", ".*/config"]);
  expect(found.candidates.map(({ name }) => name)).toEqual(["visible.txt", ".secret"]);
});

test("patterns that could leave the project or name Git's data are refused unread", () => {
  const cases: [string, string][] = [
    ["../outside/.env", "parent-segment"],
    ["config/../../.env", "parent-segment"],
    ["./.env", "parent-segment"],
    ["config//.env", "parent-segment"],
    ["/etc/passwd", "absolute"],
    ["~/.ssh/id_ed25519", "absolute"],
    ["C:/Users/me/.env", "absolute"],
    ["config\\.env", "invalid-character"],
    [".env\u001b[2J", "invalid-character"],
    ["**/.env", "recursive-wildcard"],
    ["config/**", "recursive-wildcard"],
    [".git/config", "git-directory"],
    ["sub/.GIT/hooks", "git-directory"],
    ["a/b/c/d/e/f/g/h/i", "too-deep"],
    [`${"x".repeat(ENV_FILE_PATTERN_LIMITS.patternLength + 1)}`, "too-long"],
  ];
  for (const [pattern, problem] of cases) {
    expect({ pattern, parsed: parseEnvFilePattern(pattern) }).toMatchObject({
      pattern,
      parsed: { ok: false, problem },
    });
  }
  expect(parseEnvFilePattern(" config/*.env ")).toMatchObject({ ok: true, literal: false });
});

test("a refused pattern is reported with its control characters made printable", async () => {
  const project = await tempDir();
  await files(project, { ".env": "A=1\n" });
  const result = await readProjectSeedFiles(project, {
    envFilePatterns: ["../.env", "/etc/hosts", ".env\u0007x", ".env"],
    includeOpenCodeConfig: false,
  });
  expect(result.refused).toEqual([
    { name: "../.env", reason: "invalid-pattern" },
    { name: "/etc/hosts", reason: "invalid-pattern" },
    { name: ".env?x", reason: "invalid-pattern" },
  ]);
  expect(result.accepted.map(({ name }) => name)).toEqual([".env"]);
});

test("patterns beyond the pattern bound are refused once", async () => {
  const project = await tempDir();
  const patterns = Array.from({ length: ENV_FILE_PATTERN_LIMITS.patterns + 3 }, (_, i) => `f${i}`);
  const found = await findEnvFilePatternCandidates(project, patterns);
  expect(found.refused).toEqual([
    { name: `f${ENV_FILE_PATTERN_LIMITS.patterns}`, reason: "too-many-patterns" },
  ]);
});

test("a matched link escaping the project is refused, whether literal or wildcard", async () => {
  const project = await tempDir();
  const outside = await tempDir();
  await files(outside, { "host-secret": "HOST_ONLY=1\n" });
  await symlink(path.join(outside, "host-secret"), path.join(project, ".env.staging"));
  await symlink(
    path.relative(project, path.join(outside, "host-secret")),
    path.join(project, "x.env"),
  );
  const result = await readProjectSeedFiles(project, {
    envFilePatterns: [".env.*", "*.env", "x.env"],
    includeOpenCodeConfig: false,
  });
  expect(result.accepted).toEqual([]);
  expect(result.refused).toEqual([
    { name: ".env.staging", reason: "symlink" },
    { name: "x.env", reason: "symlink" },
  ]);
});

test("matching never descends through a linked directory", async () => {
  const project = await tempDir();
  const outside = await tempDir();
  await files(outside, { ".env": "HOST_ONLY=1\n" });
  await symlink(outside, path.join(project, "config"));
  await files(project, { "real/.env": "R=1\n" });
  const result = await readProjectSeedFiles(project, {
    envFilePatterns: ["config/.env", "*/.env"],
    includeOpenCodeConfig: false,
  });
  expect(result.refused).toEqual([{ name: "config", reason: "symlink" }]);
  expect(summary(result)).toEqual([["real/.env", "project-files/real/.env", "R=1\n"]]);
});

test("a matched directory and an oversized file are refused, the rest copied", async () => {
  const project = await tempDir();
  await mkdir(path.join(project, "a.env"));
  await files(project, {
    "b.env": Buffer.alloc(PROJECT_SEED_FILE_MAX_BYTES + 1),
    "c.env": "C=1\n",
  });
  const result = await readProjectSeedFiles(project, {
    envFilePatterns: ["*.env"],
    includeOpenCodeConfig: false,
  });
  expect(result.refused).toEqual([
    { name: "a.env", reason: "not-a-file" },
    { name: "b.env", reason: "too-large" },
  ]);
  expect(result.accepted.map(({ name }) => name)).toEqual(["c.env"]);
});

test("more matches than the bound copies none of them", async () => {
  const project = await tempDir();
  const many: Record<string, string> = {};
  for (let i = 0; i <= ENV_FILE_PATTERN_LIMITS.matches; i += 1) many[`f${i}.env`] = "X=1\n";
  await files(project, { ...many, "opencode.json": "{}" });
  const result = await readProjectSeedFiles(project, { envFilePatterns: ["*.env"] });
  expect(result.refused).toEqual([
    { name: ENV_FILE_PATTERNS_REFUSAL_NAME, reason: "too-many-matches" },
  ]);
  // opencode.json is not a pattern match and is unaffected.
  expect(result.accepted.map(({ name }) => name)).toEqual(["opencode.json"]);
  expect(result.handled).toContain("f0.env");
});

test("matches totalling more than the byte bound copy none of them", async () => {
  const project = await tempDir();
  const count = Math.floor(ENV_FILE_PATTERN_LIMITS.totalBytes / PROJECT_SEED_FILE_MAX_BYTES) + 1;
  for (let i = 0; i < count; i += 1) {
    await files(project, { [`big${i}.env`]: Buffer.alloc(PROJECT_SEED_FILE_MAX_BYTES) });
  }
  const result = await readProjectSeedFiles(project, {
    envFilePatterns: ["*.env"],
    includeOpenCodeConfig: false,
  });
  expect(result.accepted).toEqual([]);
  expect(result.refused).toEqual([
    { name: ENV_FILE_PATTERNS_REFUSAL_NAME, reason: "matches-too-large" },
  ]);
});

test("a listing past the scan bound copies none of the matches", async () => {
  const project = await tempDir();
  await mkdir(path.join(project, "big"));
  await Promise.all(
    Array.from({ length: ENV_FILE_PATTERN_LIMITS.scannedEntries + 1 }, (_, i) =>
      writeFile(path.join(project, "big", `n${i}`), ""),
    ),
  );
  await files(project, { ".env": "A=1\n" });
  const result = await readProjectSeedFiles(project, {
    envFilePatterns: [".env", "big/*.env"],
    includeOpenCodeConfig: false,
  });
  expect(result.accepted).toEqual([]);
  expect(result.refused).toEqual([{ name: ENV_FILE_PATTERNS_REFUSAL_NAME, reason: "scan-limit" }]);
});

test("a matched name holding a control character is refused and shown printable", async () => {
  const project = await tempDir();
  await files(project, { "a\nb.env": "X=1\n" });
  const result = await readProjectSeedFiles(project, {
    envFilePatterns: ["*.env"],
    includeOpenCodeConfig: false,
  });
  expect(result.accepted).toEqual([]);
  expect(result.refused).toEqual([{ name: "a?b.env", reason: "unsafe-name" }]);
});

test("an empty setting copies no env file; opencode.json still goes to containers", async () => {
  const project = await tempDir();
  await files(project, { ".env": "A=1\n", "opencode.json": "{}" });
  const result = await readProjectSeedFiles(project, { envFilePatterns: [] });
  expect(result.accepted.map(({ name }) => name)).toEqual(["opencode.json"]);
});

test("files-to-copy entries are left to that copy, and command-node seeds fill only literals", async () => {
  const project = await tempDir();
  const fallback = await tempDir();
  await files(project, { "config/app.env": "A=1\n" });
  await files(fallback, { ".env": "SEEDED=1\n", "staged.env": "SEEDED=2\n" });
  const plan = projectSeedReadPlan(
    ["config/*.env", "*.env"],
    ["config/app.env"],
    [".env", "staged.env"],
  );
  expect(plan).toEqual({
    envFilePatterns: ["config/*.env", "*.env", ".env"],
    exclude: ["config/app.env"],
  });
  const result = await readProjectSeedFiles(project, {
    ...plan,
    fallbackPath: fallback,
    fallbackNames: ["config/app.env", ".env", "staged.env"],
    includeOpenCodeConfig: false,
  });
  // `staged.env` came only through a wildcard, which never reads the fallback.
  expect(summary(result)).toEqual([[".env", "project-env/.env", "SEEDED=1\n"]]);
  expect(
    filesLeftForConfiguredCopy(["config/app.env", ".env", "staged.env", "other.txt"], result),
  ).toEqual(["config/app.env", "staged.env", "other.txt"]);
});

test("a reserved name in files-to-copy is still read when the setting omits it", () => {
  expect(projectSeedReadPlan([], [".env.local", "docs/a.md"], [])).toEqual({
    envFilePatterns: [".env.local"],
    exclude: ["docs/a.md"],
  });
});

test("worktree writes keep existing paths, refuse linked parents and create 0600 files", async () => {
  const worktree = await tempDir();
  const outside = await tempDir();
  await files(worktree, { ".env": "COMMITTED=1\n" });
  await symlink(path.join(outside, "dangling"), path.join(worktree, ".env.local"));
  await symlink(outside, path.join(worktree, "linked"));
  const refused = await writeProjectSeedFilesToWorktree(worktree, [
    { name: ".env", target: "project-env/.env", contents: Buffer.from("PROJECT=1\n") },
    { name: ".env.local", target: "project-env/.env.local", contents: Buffer.from("L=1\n") },
    { name: "linked/.env", target: "project-files/linked/.env", contents: Buffer.from("X") },
    { name: "config/new.env", target: "project-files/config/new.env", contents: Buffer.from("N") },
  ]);
  expect(refused).toEqual([{ name: "linked/.env", reason: "linked-destination" }]);
  expect(await readFile(path.join(worktree, ".env"), "utf8")).toBe("COMMITTED=1\n");
  expect(await readlink(path.join(worktree, ".env.local"))).toBe(path.join(outside, "dangling"));
  await expect(lstat(path.join(outside, "dangling"))).rejects.toThrow();
  await expect(lstat(path.join(outside, ".env"))).rejects.toThrow();
  expect(await readFile(path.join(worktree, "config", "new.env"), "utf8")).toBe("N");
  expect((await stat(path.join(worktree, "config", "new.env"))).mode & 0o777).toBe(0o600);
});

test("worktree refusals are held for one setup terminal and then forgotten", () => {
  rememberWorktreeSeedRefusals("env-a", [{ name: ".env", reason: "symlink" }]);
  expect(takeWorktreeSeedRefusals("env-a")).toEqual([{ name: ".env", reason: "symlink" }]);
  expect(takeWorktreeSeedRefusals("env-a")).toEqual([]);
});

test("the container archive creates every directory a nested match needs, owned by node", async () => {
  await withDockerScript(
    `#!/bin/sh
cat > "$FAKE_DOCKER_LOG.tar"
exit 0
`,
    async (log) => {
      await copyProjectSeedFilesIntoContainer("container", [
        { name: ".env", target: "project-env/.env", contents: Buffer.from("A=1") },
        {
          name: "config/deep/app.env",
          target: "project-files/config/deep/app.env",
          contents: Buffer.from("B=2"),
        },
      ]);
      const archive = await readFile(`${log.path}.tar`);
      const entries: { name: string; type: string; mode: number; uid: number }[] = [];
      await new Promise<void>((resolve, reject) => {
        const reader = extract();
        reader.on("entry", (header, stream, next) => {
          entries.push({
            name: header.name,
            type: header.type ?? "file",
            mode: header.mode ?? 0,
            uid: header.uid ?? -1,
          });
          stream.on("end", next);
          stream.resume();
        });
        reader.on("finish", resolve);
        reader.on("error", reject);
        reader.end(archive);
      });
      expect(entries).toEqual([
        { name: "project-env", type: "directory", mode: 0o700, uid: 1000 },
        { name: "project-files", type: "directory", mode: 0o700, uid: 1000 },
        { name: "project-files/config", type: "directory", mode: 0o700, uid: 1000 },
        { name: "project-files/config/deep", type: "directory", mode: 0o700, uid: 1000 },
        { name: "project-env/.env", type: "file", mode: 0o600, uid: 1000 },
        { name: "project-files/config/deep/app.env", type: "file", mode: 0o600, uid: 1000 },
      ]);
    },
  );
});
