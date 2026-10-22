import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NodeFileTransfer } from "./node-file-transfer.js";
import { NodeFiles, parseEnv, seedFilesDir, type NodeFileScope } from "./node-files.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A node with one project whose checkout is a temp directory. */
async function node(
  name: string,
  files: Record<string, string | Buffer> = {},
  filesToCopy: string[] = [],
  uploadTtlMs?: number,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), `ork-node-files-${name}-`));
  dirs.push(root);
  const checkout = path.join(root, "checkout");
  const dataDir = path.join(root, "data");
  await Bun.write(path.join(checkout, ".keep"), "");
  for (const [file, content] of Object.entries(files))
    await Bun.write(path.join(checkout, file), content);
  const storage = {
    getDataDir: () => dataDir,
    getProject: async (id: string) => (id === "p1" ? { id, localPath: checkout } : null),
    getEnvironment: async (id: string) =>
      id === "e1"
        ? { id, projectId: "p1", environmentType: "local", worktreePath: checkout }
        : null,
    getRepositoryConfig: async () => ({ filesToCopy }),
  };
  const files_ = new NodeFiles(storage as never, { uploadTtlMs });
  const commands: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    stat_node_file: (args) => files_.stat(args.scope as NodeFileScope, String(args.path)),
    read_node_file: (args) =>
      files_.read(
        args.scope as NodeFileScope,
        String(args.path),
        Number(args.offset),
        Number(args.length),
      ),
    begin_node_file_write: (args) =>
      files_.beginWrite({
        scope: args.scope as NodeFileScope,
        path: String(args.path),
        size: Number(args.size),
        sha256: String(args.sha256),
        overwrite: args.overwrite === true,
      }),
    append_node_file_write: (args) =>
      files_.appendWrite(String(args.uploadId), String(args.contentBase64)),
    commit_node_file_write: (args) => files_.commitWrite(String(args.uploadId)),
    abort_node_file_write: (args) => files_.abortWrite(String(args.uploadId)),
  };
  return { checkout, dataDir, files: files_, invoke: commands };
}

function framework(nodes: Record<string, Awaited<ReturnType<typeof node>>>) {
  return new NodeFileTransfer({
    invokerFor:
      (nodeId) =>
      async <T>(command: string, args: Record<string, unknown>) =>
        (await nodes[nodeId]!.invoke[command]!(args)) as T,
  });
}

describe("FL-01 the file-transfer framework", () => {
  test("copies files node to node in chunks, verified and atomic, with a content-free receipt", async () => {
    const big = randomBytes(9 * 1024 * 1024);
    const a = await node("a", { "assets/big.bin": big, "notes.txt": "secret notes" });
    const b = await node("b");
    const transfer = framework({ a, b });
    const receipt = await transfer.transfer({
      from: { nodeId: "a", scope: { projectId: "p1" } },
      to: { nodeId: "b", scope: { projectId: "p1" } },
      files: ["assets/big.bin", "notes.txt"],
      overwrite: false,
      actor: "coordinator test",
    });
    expect(receipt.status).toBe("completed");
    expect(receipt.bytes).toBe(big.length + 12);
    expect((await readFile(path.join(b.checkout, "assets/big.bin"))).equals(big)).toBe(true);
    expect(receipt.files[0]!.sha256).toBe(createHash("sha256").update(big).digest("hex"));
    // The receipt names files, sizes and hashes; never their content.
    expect(JSON.stringify(receipt)).not.toContain("secret notes");
  });

  test("never overwrites unless asked, and a failure leaves no partial file", async () => {
    const a = await node("a", { "x.txt": "new" });
    const b = await node("b", { "x.txt": "old" });
    const transfer = framework({ a, b });
    const refused = await transfer.transfer({
      from: { nodeId: "a", scope: { projectId: "p1" } },
      to: { nodeId: "b", scope: { projectId: "p1" } },
      files: ["x.txt"],
      overwrite: false,
      actor: "test",
    });
    expect(refused.status).toBe("failed");
    expect(refused.error?.code).toBe("exists");
    expect(await readFile(path.join(b.checkout, "x.txt"), "utf8")).toBe("old");
    const replaced = await transfer.transfer({
      from: { nodeId: "a", scope: { projectId: "p1" } },
      to: { nodeId: "b", scope: { projectId: "p1" } },
      files: ["x.txt"],
      overwrite: true,
      actor: "test",
    });
    expect(replaced.status).toBe("completed");
    expect(await readFile(path.join(b.checkout, "x.txt"), "utf8")).toBe("new");
  });

  test("paths cannot leave their scope", async () => {
    const a = await node("a", { "x.txt": "x" });
    await expect(a.files.stat({ projectId: "p1" }, "../../etc/passwd")).rejects.toThrow();
    await expect(
      a.files.beginWrite({
        scope: { projectId: "p1" },
        path: "/abs",
        size: 1,
        sha256: "0".repeat(64),
        overwrite: true,
      }),
    ).rejects.toThrow();
  });

  test("a hash mismatch writes nothing", async () => {
    const b = await node("b");
    const { uploadId } = await b.files.beginWrite({
      scope: { projectId: "p1" },
      path: "y.txt",
      size: 3,
      sha256: "0".repeat(64),
      overwrite: false,
    });
    await b.files.appendWrite(uploadId, Buffer.from("abc").toString("base64"));
    await expect(b.files.commitWrite(uploadId)).rejects.toThrow("did not match");
    await expect(stat(path.join(b.checkout, "y.txt"))).rejects.toThrow();
  });
});

describe("FL-06 fingerprints and .env handling", () => {
  test("fingerprints whole files and each .env key under a one-time key, without values", async () => {
    const a = await node("a", { ".env": "API_KEY=abc123\nDEBUG=1\n# comment\n" });
    const key = randomBytes(32);
    const [entry] = await a.files.fingerprints("p1", [".env"], key);
    expect(entry!.exists).toBe(true);
    expect(Object.keys(entry!.envKeys!).sort()).toEqual(["API_KEY", "DEBUG"]);
    expect(JSON.stringify(entry)).not.toContain("abc123");
    // A different key gives unrelated fingerprints.
    const [other] = await a.files.fingerprints("p1", [".env"], randomBytes(32));
    expect(other!.envKeys!.API_KEY).not.toBe(entry!.envKeys!.API_KEY);
  });

  test("applying keys keeps every other line and round-trips quoted values", async () => {
    const a = await node("a", { ".env": "# header\nKEEP=1\nCHANGE=old\nDROP=x\n" });
    await a.files.applyEnvKeys(
      "p1",
      ".env",
      { CHANGE: 'new value with $ and "quotes"', ADDED: "2" },
      ["DROP"],
    );
    const text = await readFile(path.join(a.checkout, ".env"), "utf8");
    expect(text.startsWith("# header\nKEEP=1\n")).toBe(true);
    expect(text).not.toContain("DROP=");
    const values = new Map(parseEnv(text));
    expect(values.get("CHANGE")).toBe('new value with $ and "quotes"');
    expect(values.get("ADDED")).toBe("2");
    expect((await stat(path.join(a.checkout, ".env"))).mode & 0o777).toBe(0o600);
    await expect(a.files.applyEnvKeys("p1", ".env", { BAD: "two\nlines" }, [])).rejects.toThrow();
  });

  test("lists which seed files a project root has", async () => {
    const a = await node("a", { ".env": "A=1", "config/local.json": "{}" }, [
      "config/local.json",
      "certs/dev.pem",
    ]);
    expect(await a.files.seedFiles("p1")).toEqual([
      { path: ".env", exists: true },
      { path: ".env.local", exists: false },
      { path: "config/local.json", exists: true },
      { path: "certs/dev.pem", exists: false },
    ]);
  });
});

describe("CO-06 interrogating an environment's diff, files and tests", () => {
  test("reads git status and diff, a text file and pipeline state, without writing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ork-node-details-"));
    dirs.push(root);
    const worktree = path.join(root, "worktree");
    const { runCommand } = await import("../shell.js");
    await Bun.write(path.join(worktree, "src/app.ts"), "export const a = 1;\n");
    await runCommand("git", ["init", "-q", "-b", "main"], { cwd: worktree });
    await runCommand("git", ["add", "."], { cwd: worktree });
    await runCommand(
      "git",
      ["-c", "user.email=qa@example.com", "-c", "user.name=QA", "commit", "-q", "-m", "init"],
      { cwd: worktree },
    );
    await Bun.write(path.join(worktree, "src/app.ts"), "export const a = 2;\n");
    const files = new NodeFiles({
      getDataDir: () => root,
      getEnvironment: async (id: string) =>
        id === "e1"
          ? { id, projectId: "p1", environmentType: "local", worktreePath: worktree }
          : null,
      getRepositoryConfig: async () => ({ filesToCopy: [] }),
      listBuildPipelines: async () => [
        {
          id: "bp1",
          environmentId: "e1",
          status: "running",
          stages: [{ name: "tests", status: "failed" }],
        },
        { id: "bp2", environmentId: "other", status: "done" },
      ],
    } as never);
    const details = await files.environmentDetails({
      environmentId: "e1",
      include: ["diff", "file", "tests"],
      path: "src/app.ts",
    });
    expect((details.diff as { status: string }).status).toContain("M src/app.ts");
    expect((details.diff as { patch: string }).patch).toContain("+export const a = 2;");
    expect((details.file as { content: string }).content).toBe("export const a = 2;\n");
    expect(details.tests).toEqual([
      {
        id: "bp1",
        status: "running",
        stages: [{ name: "tests", status: "failed" }],
        updatedAt: undefined,
      },
    ]);
  });
});

describe("node file authorization and atomic dotenv regressions", () => {
  test("dot segments and unknown seed IDs cannot read backend data", async () => {
    const a = await node("seed");
    await Bun.write(path.join(a.dataDir, "gateway-auth.json"), "private");
    for (const id of [".", "..", "../x", "a/b", "unknown"]) {
      await expect(
        a.files.read({ seedEnvironmentId: id }, "gateway-auth.json", 0, 100),
      ).rejects.toThrow();
      await expect(
        a.files.beginWrite({
          scope: { seedEnvironmentId: id },
          path: "x",
          size: 0,
          sha256: "0".repeat(64),
          overwrite: true,
        }),
      ).rejects.toThrow();
    }
    expect(() => seedFilesDir(a.dataDir, "..")).toThrow();
    expect(await readFile(path.join(a.dataDir, "gateway-auth.json"), "utf8")).toBe("private");
  });

  test("symlink rejection precedes creation of outside directories; Git writes are protected", async () => {
    const a = await node("symlink");
    const outside = path.join(a.dataDir, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(a.checkout, "escape"));
    const git = path.join(a.checkout, ".git");
    await mkdir(git);
    await symlink(git, path.join(a.checkout, "metadata"));
    for (const target of ["escape/new/sub/x", ".git/config", "metadata/new/sub/x"]) {
      await expect(
        a.files.beginWrite({
          scope: { projectId: "p1" },
          path: target,
          size: 0,
          sha256: "0".repeat(64),
          overwrite: true,
        }),
      ).rejects.toThrow();
    }
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(git)).toEqual([]);
  });

  test("environment detail reads refuse dotenv, selected secrets and directories", async () => {
    const a = await node(
      "details",
      { ".env": "KEY=secret", ".env.local": "KEY=secret", "secret.pem": "private" },
      ["secret.pem"],
    );
    for (const file of [".env", ".env.local", "secret.pem", "."]) {
      await expect(
        a.files.environmentDetails({ environmentId: "e1", include: ["file"], path: file }),
      ).rejects.toThrow();
    }
  });

  test("parallel updates preserve unrelated keys and remove stale duplicate overrides", async () => {
    const a = await node("env", { ".env": "# header\nA=old\nA=stale\nKEEP=yes\n" });
    await Promise.all([
      a.files.applyEnvKeys("p1", ".env", { A: "approved" }, []),
      a.files.applyEnvKeys("p1", ".env", { B: "new" }, []),
    ]);
    const text = await readFile(path.join(a.checkout, ".env"), "utf8");
    expect(new Map(parseEnv(text))).toEqual(
      new Map([
        ["A", "approved"],
        ["KEEP", "yes"],
        ["B", "new"],
      ]),
    );
    expect(text.match(/^A=/gm)).toHaveLength(1);
    await a.files.applyEnvKeys("p1", ".env.local", { CREATED: "yes" }, []);
    expect(await readFile(path.join(a.checkout, ".env.local"), "utf8")).toBe("CREATED=yes\n");
  });

  test("read errors cannot replace an existing dotenv file", async () => {
    const a = await node("read-error");
    // A directory produces EISDIR even when tests run as root, unlike chmod.
    await mkdir(path.join(a.checkout, ".env"));
    await expect(a.files.applyEnvKeys("p1", ".env", { KEY: "new" }, [])).rejects.toThrow();
    expect((await stat(path.join(a.checkout, ".env"))).isDirectory()).toBe(true);
  });
});

test("abandoned uploads expire and remove worktree temporary files", async () => {
  const a = await node("expiry", {}, [], 10);
  const { uploadId } = await a.files.beginWrite({
    scope: { projectId: "p1" },
    path: "partial",
    size: 3,
    sha256: "0".repeat(64),
    overwrite: false,
  });
  await a.files.appendWrite(uploadId, Buffer.from("a").toString("base64"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(
    (await readdir(a.checkout)).some((entry) => entry.startsWith(".orkestrator-upload-")),
  ).toBe(false);
  await expect(a.files.commitWrite(uploadId)).rejects.toThrow("not open");
});
