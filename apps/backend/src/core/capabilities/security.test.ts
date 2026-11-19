import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CapabilityArtifactStore, STAGED_ARTIFACT_TTL_MS } from "./artifact-store.js";
import {
  CapabilityError,
  confinedPath,
  readPackageTree,
  recoverLocationReplacements,
  replaceDirectoryAtomically,
  treeDigest,
  validatePackageFiles,
} from "./security.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "capability-security-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(relative: string, content: string, mode = 0o644) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, { mode });
}

describe("reading package trees", () => {
  test("reads files with their executable bit, skipping .git", async () => {
    await write("pkg/SKILL.md", "---\nname: a\n---\n");
    await write("pkg/scripts/run.sh", "#!/bin/sh\n", 0o755);
    await write("pkg/.git/config", "x");
    const files = await readPackageTree(path.join(root, "pkg"));
    expect(files.map((file) => [file.path, file.executable])).toEqual([
      ["SKILL.md", false],
      ["scripts/run.sh", true],
    ]);
  });

  test("refuses a symbolic link that leaves the tree", async () => {
    await write("pkg/SKILL.md", "x");
    await write("secret.txt", "s");
    await fs.symlink(path.join(root, "secret.txt"), path.join(root, "pkg", "leak.txt"));
    await expect(readPackageTree(path.join(root, "pkg"))).rejects.toThrow("points outside");
  });

  test("reads a link that stays inside as the file it names", async () => {
    await write("pkg/SKILL.md", "x");
    await fs.symlink("SKILL.md", path.join(root, "pkg", "alias.md"));
    const files = await readPackageTree(path.join(root, "pkg"));
    expect(files.find((file) => file.path === "alias.md")?.content.toString()).toBe("x");
  });

  test("refuses special files and oversized trees", async () => {
    await write("pkg/SKILL.md", "x");
    await expect(readPackageTree(path.join(root, "pkg"), { maxBytes: 0 })).rejects.toThrow(
      "size limit",
    );
    await expect(readPackageTree(path.join(root, "pkg"), { maxFiles: 0 })).rejects.toThrow(
      "more than 0 files",
    );
  });

  test("the digest ignores markers, order and timestamps", () => {
    const a = validatePackageFiles([
      { path: "b.md", content: Buffer.from("b") },
      { path: "a.md", content: Buffer.from("a") },
    ]);
    const b = validatePackageFiles([
      { path: "a.md", content: Buffer.from("a") },
      { path: "b.md", content: Buffer.from("b") },
      { path: ".orkestrator-capability.json", content: Buffer.from("{}") },
    ]);
    expect(treeDigest(a)).toBe(treeDigest(b));
    expect(treeDigest(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("writing", () => {
  test("confined paths refuse traversal and absolute paths", () => {
    expect(() => confinedPath(root, "../x")).toThrow(CapabilityError);
    expect(() => confinedPath(root, "/etc/passwd")).toThrow(CapabilityError);
    expect(confinedPath(root, "a/b")).toBe(path.join(root, "a", "b"));
  });

  test("uploaded files with traversal or duplicate names are refused", () => {
    expect(() => validatePackageFiles([{ path: "../evil", content: Buffer.from("") }])).toThrow(
      "safe relative path",
    );
    expect(() =>
      validatePackageFiles([
        { path: "A.md", content: Buffer.from("") },
        { path: "a.md", content: Buffer.from("") },
      ]),
    ).toThrow("Two files");
  });

  test("recovers an interrupted replacement before observing the location", async () => {
    await write("skills/.review.orkestrator-retired/SKILL.md", "old");
    await write("skills/.review.orkestrator-retired/.orkestrator-capability.json", "{}");
    await recoverLocationReplacements(path.join(root, "skills"));
    expect(await fs.readFile(path.join(root, "skills/review/SKILL.md"), "utf8")).toBe("old");
    await replaceDirectoryAtomically(
      path.join(root, "skills/review"),
      validatePackageFiles([{ path: "SKILL.md", content: Buffer.from("new") }]),
    );
    await recoverLocationReplacements(path.join(root, "skills"));
    expect(await fs.readFile(path.join(root, "skills/review/SKILL.md"), "utf8")).toBe("new");
  });

  test("a directory is replaced whole, never through a link", async () => {
    const destination = path.join(root, "skills", "review");
    await replaceDirectoryAtomically(
      destination,
      validatePackageFiles([{ path: "SKILL.md", content: Buffer.from("v1") }]),
    );
    await replaceDirectoryAtomically(
      destination,
      validatePackageFiles([{ path: "SKILL.md", content: Buffer.from("v2") }]),
    );
    expect(await fs.readFile(path.join(destination, "SKILL.md"), "utf8")).toBe("v2");
    expect((await fs.readdir(path.join(root, "skills"))).sort()).toEqual(["review"]);
    await fs.mkdir(path.join(root, "elsewhere"));
    await fs.symlink(path.join(root, "elsewhere"), path.join(root, "skills", "linked"));
    await expect(
      replaceDirectoryAtomically(
        path.join(root, "skills", "linked"),
        validatePackageFiles([{ path: "x", content: Buffer.from("") }]),
      ),
    ).rejects.toThrow("symbolic link");
  });
});

describe("artifact store", () => {
  test("stores by digest and verifies a chunked transfer before keeping it", async () => {
    const sender = new CapabilityArtifactStore(path.join(root, "a"));
    const receiver = new CapabilityArtifactStore(path.join(root, "b"));
    const files = validatePackageFiles([
      { path: "SKILL.md", content: Buffer.from("x".repeat(3_000_000)) },
      { path: "run.sh", content: Buffer.from("#!/bin/sh"), executable: true },
    ]);
    const digest = await sender.put(files);
    const chunks = CapabilityArtifactStore.bundleChunks(await sender.get(digest));
    expect(chunks.length).toBeGreaterThan(1);
    for (let index = 0; index < chunks.length; index += 1) {
      const answer = await receiver.stageChunk(digest, index, chunks.length, chunks[index]!);
      expect(answer.complete).toBe(index === chunks.length - 1);
    }
    expect((await receiver.get(digest)).find((file) => file.path === "run.sh")?.executable).toBe(
      true,
    );
  });

  test("the cache round-trips uploads with ignored metadata", async () => {
    const store = new CapabilityArtifactStore(root);
    const files = validatePackageFiles(
      ["SKILL.md", ".DS_Store", "nested/.git/config", "node_modules/example/index.js"].map(
        (path) => ({ path, content: Buffer.from("example") }),
      ),
    );
    const digest = await store.put(files);
    expect((await store.get(digest)).map((file) => file.path)).toEqual(["SKILL.md"]);
  });

  test("expires abandoned chunks and preserves recent uploads after restart", async () => {
    const expired = "a".repeat(64);
    const recent = "b".repeat(64);
    const store = new CapabilityArtifactStore(root);
    await store.stageChunk(`sha256:${expired}`, 0, 5, "expired");
    await store.stageChunk(`sha256:${recent}`, 0, 5, "recent");
    const staging = path.join(root, "capability-artifacts", ".staging");
    const now = Date.now();
    const old = new Date(now - STAGED_ARTIFACT_TTL_MS - 1_000);
    await fs.utimes(path.join(staging, expired), old, old);
    await new CapabilityArtifactStore(root).pruneStaged(now);
    expect(await fs.readdir(staging)).toEqual([recent]);
  });

  test("a bundle that does not match the named digest is refused", async () => {
    const store = new CapabilityArtifactStore(root);
    const bundle = JSON.stringify([
      { path: "SKILL.md", executable: false, data: Buffer.from("tampered").toString("base64") },
    ]);
    await expect(store.stageChunk(`sha256:${"0".repeat(64)}`, 0, 1, bundle)).rejects.toThrow(
      "does not match",
    );
    expect(await store.list()).toEqual([]);
  });
});
