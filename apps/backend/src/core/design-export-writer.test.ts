import { afterEach, describe, expect, mock, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { DesignError } from "./design-errors.js";
import {
  DESIGN_EXPORT_CONTAINER_INSPECTOR,
  DESIGN_EXPORT_CONTAINER_WRITER,
  DESIGN_EXPORT_MAX_BYTES,
  DESIGN_EXPORT_PATH,
  designExportDigest,
  inspectDesignExportTarget,
  planDefaultDesignExportPath,
  validateDesignExportPath,
  writeDesignExport,
  type DesignExportDestination,
  type DesignExportSpawn,
} from "./design-export-writer.js";

const temporaryRoots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ork-design-export-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function expectDesignError(promise: Promise<unknown>, code: string): Promise<DesignError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DesignError);
    expect((error as DesignError).code).toBe(code as DesignError["code"]);
    return error as DesignError;
  }
  throw new Error(`expected DesignError ${code}`);
}

async function tempFiles(root: string): Promise<string[]> {
  return (await fs.readdir(root)).filter((name) => name.endsWith(".tmp"));
}

function doc(label: string, size = 64): Buffer<ArrayBuffer> {
  return Buffer.from(JSON.stringify({ label, padding: label.repeat(size) }));
}

/**
 * Maps the docker invocation onto the same helper run locally, with a temp
 * directory standing in for `/workspace`, so the container path is exercised
 * end to end without Docker.
 */
function localContainerSpawn(root: string): DesignExportSpawn {
  return (command, args) => {
    expect(command).toBe("docker");
    expect(args.slice(0, 5)).toEqual(["exec", "-i", "container-1", "node", "-e"]);
    expect(args[6]).toBe("--");
    expect(args[7]).toBe("/workspace");
    return spawn(process.execPath, ["-e", args[5]!, "--", root, ...args.slice(8)], {
      stdio: "pipe",
    });
  };
}

function runHelper(
  script: string,
  args: string[],
  input?: Buffer,
): Promise<{ code: number | null; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, "--", ...args], { stdio: "pipe" });
    const out: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stdin.on("error", () => undefined);
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        const lines = Buffer.concat(out).toString("utf8").trim().split("\n");
        expect(lines).toHaveLength(1);
        resolve({ code, json: JSON.parse(lines[0]!) as Record<string, unknown> });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number | undefined;
  kill: ReturnType<typeof mock>;
};

function fakeSpawn(behaviour: (child: FakeChild) => void): {
  spawn: DesignExportSpawn;
  children: FakeChild[];
} {
  const children: FakeChild[] = [];
  return {
    children,
    spawn: () => {
      const child = new EventEmitter() as FakeChild;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin.resume();
      child.pid = 4242;
      child.kill = mock(() => true);
      children.push(child);
      setTimeout(() => behaviour(child), 1);
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  };
}

function emitAndClose(child: FakeChild, stdout: string, stderr = "", code = 0): void {
  if (stdout) child.stdout.write(stdout);
  if (stderr) child.stderr.write(stderr);
  setTimeout(() => child.emit("close", code, null), 5);
}

describe("paths and naming", () => {
  test("validateDesignExportPath accepts repository-relative .orkdes paths", () => {
    expect(validateDesignExportPath("canvas-1.orkdes")).toBe("canvas-1.orkdes");
    expect(validateDesignExportPath("designs/canvas-1.orkdes")).toBe("designs/canvas-1.orkdes");
    expect(validateDesignExportPath("a/b.c/d_e/f.orkdes")).toBe("a/b.c/d_e/f.orkdes");
    for (const bad of [
      "../x.orkdes",
      "a/../x.orkdes",
      "a/./x.orkdes",
      "a//x.orkdes",
      "a/.git/x.orkdes",
      ".hidden/x.orkdes",
      "a/b/c/d/e/f/g/h/i.orkdes",
      `${"a".repeat(64)}/${"b".repeat(64)}/${"c".repeat(64)}/${"d".repeat(64)}/x.orkdes`,
      ".hidden.orkdes",
      "x.json",
      "",
      "/abs.orkdes",
      "a\\b.orkdes",
      "-flag.orkdes",
    ]) {
      expect(() => validateDesignExportPath(bad)).toThrow(DesignError);
    }
  });

  test("planDefaultDesignExportPath sanitizes and disambiguates", () => {
    const first = planDefaultDesignExportPath(
      "Untitled design",
      "1234abcd-0000-4000-8000-000000000000",
    );
    const second = planDefaultDesignExportPath(
      "Untitled design",
      "9876fedc-0000-4000-8000-000000000000",
    );
    expect(first).toBe("designs/Untitled-design-1234abcd.orkdes");
    expect(second).not.toBe(first);
    const slash = planDefaultDesignExportPath("a/b", "aaaaaaaa-0000-4000-8000-000000000000");
    const question = planDefaultDesignExportPath("a?b", "bbbbbbbb-0000-4000-8000-000000000000");
    expect(slash).not.toBe(question);
    expect(planDefaultDesignExportPath("  ¿¿  ", "cafebabe")).toBe(
      "designs/design-cafebabe.orkdes",
    );
    expect(planDefaultDesignExportPath("--__a -- b__--", "CAFEBABE")).toBe(
      "designs/a-b-cafebabe.orkdes",
    );
    const long = planDefaultDesignExportPath("x".repeat(200), "not-hex-id");
    expect(long).toMatch(/^designs\/x{60}-[0-9a-f]{8}\.orkdes$/);
    for (const value of [first, second, slash, question, long]) {
      expect(DESIGN_EXPORT_PATH.test(value)).toBe(true);
    }
  });

  test("designExportDigest is a prefixed sha256", () => {
    expect(designExportDigest(Buffer.from(""))).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("local writer", () => {
  test("absent write creates the exact bytes", async () => {
    const root = await createRoot();
    const dest: DesignExportDestination = { kind: "local", worktreePath: root };
    const bytes = doc("one");
    const result = await writeDesignExport(dest, "one.orkdes", bytes, { state: "absent" });
    expect(result).toEqual({ digest: designExportDigest(bytes), replaced: false });
    expect(await fs.readFile(path.join(root, "one.orkdes"))).toEqual(bytes);
    expect(await tempFiles(root)).toEqual([]);
    const state = await inspectDesignExportTarget(dest, "one.orkdes");
    expect(state).toMatchObject({ exists: true, readable: true, digest: result.digest });
    expect(state.bytes).toEqual(bytes);
  });

  test("absent write over an existing file is a collision and leaves it untouched", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "one.orkdes"), "existing");
    const error = await expectDesignError(
      writeDesignExport({ kind: "local", worktreePath: root }, "one.orkdes", doc("new"), {
        state: "absent",
      }),
      "export-collision",
    );
    expect(error.message).not.toContain(root);
    expect(await fs.readFile(path.join(root, "one.orkdes"), "utf8")).toBe("existing");
    expect(await tempFiles(root)).toEqual([]);
  });

  test("an external create between check and publish loses to link()", async () => {
    const root = await createRoot();
    const target = path.join(root, "race.orkdes");
    await expectDesignError(
      writeDesignExport(
        { kind: "local", worktreePath: root },
        "race.orkdes",
        doc("ours"),
        {
          state: "absent",
        },
        {
          faults: { beforePublish: () => fs.writeFile(target, "theirs") },
        },
      ),
      "export-collision",
    );
    expect(await fs.readFile(target, "utf8")).toBe("theirs");
    expect(await tempFiles(root)).toEqual([]);
  });

  test("concurrent absent writes produce one winner and one collision", async () => {
    const root = await createRoot();
    const dest: DesignExportDestination = { kind: "local", worktreePath: root };
    const a = doc("a", 20_000);
    const b = doc("b", 20_000);
    const results = await Promise.allSettled([
      writeDesignExport(dest, "same.orkdes", a, { state: "absent" }),
      writeDesignExport(dest, "same.orkdes", b, { state: "absent" }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.code).toBe("export-collision");
    const winner = results[0]!.status === "fulfilled" ? a : b;
    expect(await fs.readFile(path.join(root, "same.orkdes"))).toEqual(winner);
    expect(await tempFiles(root)).toEqual([]);
  });

  test("present with matching digest replaces and returns the previous bytes", async () => {
    const root = await createRoot();
    const dest: DesignExportDestination = { kind: "local", worktreePath: root };
    const old = doc("old");
    await fs.writeFile(path.join(root, "x.orkdes"), old);
    const next = doc("next");
    const result = await writeDesignExport(dest, "x.orkdes", next, {
      state: "present",
      digest: designExportDigest(old),
    });
    expect(result.replaced).toBe(true);
    expect(result.digest).toBe(designExportDigest(next));
    expect(result.previous).toEqual(old);
    expect(await fs.readFile(path.join(root, "x.orkdes"))).toEqual(next);
    expect((await fs.stat(path.join(root, "x.orkdes"))).mode & 0o777).toBe(0o644);
    expect(await tempFiles(root)).toEqual([]);
  });

  test("present with a stale digest (external modification) is a collision", async () => {
    const root = await createRoot();
    const old = doc("old");
    await fs.writeFile(path.join(root, "x.orkdes"), "edited by someone else");
    await expectDesignError(
      writeDesignExport({ kind: "local", worktreePath: root }, "x.orkdes", doc("next"), {
        state: "present",
        digest: designExportDigest(old),
      }),
      "export-collision",
    );
    expect(await fs.readFile(path.join(root, "x.orkdes"), "utf8")).toBe("edited by someone else");
    expect(await tempFiles(root)).toEqual([]);
  });

  test("present when the file was deleted is a collision", async () => {
    const root = await createRoot();
    await expectDesignError(
      writeDesignExport({ kind: "local", worktreePath: root }, "gone.orkdes", doc("next"), {
        state: "present",
        digest: designExportDigest(doc("old")),
      }),
      "export-collision",
    );
    await expect(fs.stat(path.join(root, "gone.orkdes"))).rejects.toThrow();
  });

  test("a symlinked target is refused and the file outside is untouched", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    const outsideFile = path.join(outside, "victim.txt");
    await fs.writeFile(outsideFile, "outside");
    await fs.symlink(outsideFile, path.join(root, "link.orkdes"));
    const dest: DesignExportDestination = { kind: "local", worktreePath: root };
    const error = await expectDesignError(
      writeDesignExport(dest, "link.orkdes", doc("x"), { state: "absent" }),
      "invalid-input",
    );
    expect(error.message).toContain("refuses to follow a symbolic link");
    await expectDesignError(
      writeDesignExport(dest, "link.orkdes", doc("x"), {
        state: "present",
        digest: designExportDigest(Buffer.from("outside")),
      }),
      "invalid-input",
    );
    expect(await fs.readFile(outsideFile, "utf8")).toBe("outside");
    expect((await fs.lstat(path.join(root, "link.orkdes"))).isSymbolicLink()).toBe(true);
    expect(await inspectDesignExportTarget(dest, "link.orkdes")).toEqual({
      exists: true,
      readable: false,
      symlink: true,
    });
  });

  test("creates missing folders and publishes inside them", async () => {
    const root = await createRoot();
    const dest: DesignExportDestination = { kind: "local", worktreePath: root };
    expect(await inspectDesignExportTarget(dest, "designs/ui/a.orkdes")).toEqual({
      exists: false,
      readable: false,
    });
    expect(await fs.readdir(root)).toEqual([]);
    const bytes = doc("nested");
    const result = await writeDesignExport(dest, "designs/ui/a.orkdes", bytes, { state: "absent" });
    expect(result.digest).toBe(designExportDigest(bytes));
    expect(await fs.readFile(path.join(root, "designs/ui/a.orkdes"))).toEqual(bytes);
    expect(await fs.readdir(path.join(root, "designs/ui"))).toEqual(["a.orkdes"]);
    const next = doc("nested-2");
    await writeDesignExport(dest, "designs/ui/a.orkdes", next, {
      state: "present",
      digest: designExportDigest(bytes),
    });
    expect(await fs.readFile(path.join(root, "designs/ui/a.orkdes"))).toEqual(next);
    // A replacement never invents folders.
    await expectDesignError(
      writeDesignExport(dest, "other/a.orkdes", next, {
        state: "present",
        digest: designExportDigest(bytes),
      }),
      "export-collision",
    );
    await expect(fs.stat(path.join(root, "other"))).rejects.toThrow();
  });

  test("a symlinked or file folder is never traversed", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    await fs.symlink(outside, path.join(root, "linked"));
    await fs.writeFile(path.join(root, "plain"), "file");
    const dest: DesignExportDestination = { kind: "local", worktreePath: root };
    await expectDesignError(
      writeDesignExport(dest, "linked/a.orkdes", doc("x"), { state: "absent" }),
      "invalid-input",
    );
    await expectDesignError(
      writeDesignExport(dest, "linked/deeper/a.orkdes", doc("x"), { state: "absent" }),
      "invalid-input",
    );
    await expectDesignError(
      writeDesignExport(dest, "plain/a.orkdes", doc("x"), { state: "absent" }),
      "export-collision",
    );
    expect(await fs.readdir(outside)).toEqual([]);
    expect(await inspectDesignExportTarget(dest, "linked/a.orkdes")).toEqual({
      exists: true,
      readable: false,
      symlink: true,
    });
    expect(await inspectDesignExportTarget(dest, "plain/a.orkdes")).toEqual({
      exists: true,
      readable: false,
    });
  });

  test("a directory at the target is a collision", async () => {
    const root = await createRoot();
    await fs.mkdir(path.join(root, "dir.orkdes"));
    await expectDesignError(
      writeDesignExport({ kind: "local", worktreePath: root }, "dir.orkdes", doc("x"), {
        state: "absent",
      }),
      "export-collision",
    );
    expect(
      await inspectDesignExportTarget({ kind: "local", worktreePath: root }, "dir.orkdes"),
    ).toEqual({ exists: true, readable: false });
  });

  test("invalid paths are rejected before touching the filesystem", async () => {
    const root = await createRoot();
    for (const bad of ["../x.orkdes", "a/../x.orkdes", "/abs.orkdes", ".hidden.orkdes", "x.json"]) {
      await expectDesignError(
        writeDesignExport({ kind: "local", worktreePath: root }, bad, doc("x"), {
          state: "absent",
        }),
        "invalid-input",
      );
    }
    expect(await fs.readdir(root)).toEqual([]);
    expect(await fs.readdir(path.dirname(root))).not.toContain("x.orkdes");
  });

  test("over-limit bytes are rejected before writing", async () => {
    const root = await createRoot();
    await expectDesignError(
      writeDesignExport(
        { kind: "local", worktreePath: root },
        "big.orkdes",
        Buffer.alloc(DESIGN_EXPORT_MAX_BYTES + 1, 0x20),
        { state: "absent" },
      ),
      "invalid-input",
    );
    await expectDesignError(
      writeDesignExport(
        { kind: "local", worktreePath: root },
        "small.orkdes",
        doc("x"),
        {
          state: "absent",
        },
        { maxBytes: 8 },
      ),
      "invalid-input",
    );
    expect(await fs.readdir(root)).toEqual([]);
  });

  test("an interruption before publish leaves the old complete file and no temp", async () => {
    const root = await createRoot();
    const old = doc("old");
    await fs.writeFile(path.join(root, "x.orkdes"), old);
    const faultError = new Error("simulated crash");
    let sawTemp = false;
    await expect(
      writeDesignExport(
        { kind: "local", worktreePath: root },
        "x.orkdes",
        doc("next"),
        { state: "present", digest: designExportDigest(old) },
        {
          faults: {
            beforePublish: async () => {
              sawTemp = (await tempFiles(root)).length === 1;
              throw faultError;
            },
          },
        },
      ),
    ).rejects.toBeInstanceOf(DesignError);
    expect(sawTemp).toBe(true);
    expect(await fs.readFile(path.join(root, "x.orkdes"))).toEqual(old);
    expect(await tempFiles(root)).toEqual([]);
  });

  test("inspection reports absent, unreadable-by-size, and missing roots", async () => {
    const root = await createRoot();
    const dest: DesignExportDestination = { kind: "local", worktreePath: root };
    expect(await inspectDesignExportTarget(dest, "none.orkdes")).toEqual({
      exists: false,
      readable: false,
    });
    await fs.writeFile(path.join(root, "big.orkdes"), Buffer.alloc(100, 0x20));
    expect(await inspectDesignExportTarget(dest, "big.orkdes", { maxBytes: 50 })).toEqual({
      exists: true,
      readable: false,
    });
    const error = await expectDesignError(
      inspectDesignExportTarget(
        { kind: "local", worktreePath: path.join(root, "missing") },
        "x.orkdes",
      ),
      "storage",
    );
    expect(error.message).not.toContain(root);
  });
});

describe("pinned local parents", () => {
  for (const stage of ["inspect", "create", "publish", "replace"] as const) {
    test(`a swapped parent cannot redirect local ${stage}`, async () => {
      const root = await createRoot(),
        outside = await createRoot();
      await fs.mkdir(path.join(root, "designs"));
      const inside = doc("inside"),
        external = doc("outside"),
        next = doc("next");
      if (stage === "inspect" || stage === "replace")
        await fs.writeFile(path.join(root, "designs/a.orkdes"), inside);
      await fs.writeFile(path.join(outside, "a.orkdes"), external);
      const swap = async () => {
        await fs.rename(path.join(root, "designs"), path.join(root, "retained"));
        await fs.symlink(outside, path.join(root, "designs"));
      };
      const dest = { kind: "local", worktreePath: root } as const;
      if (stage === "inspect") {
        const result = await inspectDesignExportTarget(dest, "designs/a.orkdes", {
          faults: { afterParentsOpened: swap },
        });
        expect(result.bytes).toEqual(inside);
      } else {
        const result = await writeDesignExport(
          dest,
          "designs/a.orkdes",
          next,
          stage === "replace"
            ? { state: "present", digest: designExportDigest(inside) }
            : { state: "absent" },
          { faults: stage === "create" ? { afterParentsOpened: swap } : { beforePublish: swap } },
        );
        if (stage === "replace") expect(result.previous).toEqual(inside);
        expect(await fs.readFile(path.join(root, "retained/a.orkdes"))).toEqual(next);
      }
      expect(await fs.readFile(path.join(outside, "a.orkdes"))).toEqual(external);
      expect(await fs.readdir(outside)).toEqual(["a.orkdes"]);
      expect(await tempFiles(path.join(root, "retained"))).toEqual([]);
    });
  }
});

describe("container helper scripts (run locally)", () => {
  for (const stage of ["inspect", "create", "publish"] as const) {
    test(`a swapped parent cannot redirect container ${stage}`, async () => {
      const root = await createRoot();
      const outside = await createRoot();
      await fs.mkdir(path.join(root, "designs"));
      const inside = doc("inside"),
        external = doc("outside");
      if (stage === "inspect") await fs.writeFile(path.join(root, "designs/a.orkdes"), inside);
      await fs.writeFile(path.join(outside, "a.orkdes"), external);
      const swap = `fs.renameSync(${JSON.stringify(path.join(root, "designs"))}, ${JSON.stringify(path.join(root, "retained"))}); fs.symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(path.join(root, "designs"))});`;
      const script =
        stage === "inspect"
          ? DESIGN_EXPORT_CONTAINER_INSPECTOR.replace(
              "stats = lstatOrNull(target);",
              `${swap}\nstats = lstatOrNull(target);`,
            )
          : DESIGN_EXPORT_CONTAINER_WRITER.replace(
              stage === "create" ? "const before = lstatOrNull(target);" : "let previous;",
              `${swap}\n${stage === "create" ? "const before = lstatOrNull(target);" : "let previous;"}`,
            );
      const result = await runHelper(
        script,
        stage === "inspect"
          ? [root, "designs/a.orkdes", "10000"]
          : [root, "designs/a.orkdes", "absent", "-", "10000", designExportDigest(inside)],
        inside,
      );
      expect(result.json.ok).toBe(true);
      if (stage === "inspect")
        expect(Buffer.from(result.json.bytes as string, "base64")).toEqual(inside);
      else expect(await fs.readFile(path.join(root, "retained/a.orkdes"))).toEqual(inside);
      expect(await fs.readFile(path.join(outside, "a.orkdes"))).toEqual(external);
      expect(await fs.readdir(outside)).toEqual(["a.orkdes"]);
      expect(await tempFiles(path.join(root, "retained"))).toEqual([]);
    });
  }
  test("writer creates, collides, replaces, and refuses symlinks", async () => {
    const root = await createRoot();
    const bytes = doc("c1");
    const created = await runHelper(
      DESIGN_EXPORT_CONTAINER_WRITER,
      [root, "c.orkdes", "absent", "-", String(DESIGN_EXPORT_MAX_BYTES), designExportDigest(bytes)],
      bytes,
    );
    expect(created.code).toBe(0);
    expect(created.json).toEqual({ ok: true, digest: designExportDigest(bytes), replaced: false });
    expect(await fs.readFile(path.join(root, "c.orkdes"))).toEqual(bytes);

    const again = await runHelper(
      DESIGN_EXPORT_CONTAINER_WRITER,
      [root, "c.orkdes", "absent", "-", String(DESIGN_EXPORT_MAX_BYTES), designExportDigest(bytes)],
      bytes,
    );
    expect(again.code).toBe(1);
    expect(again.json).toMatchObject({ ok: false, code: "export-collision", reason: "exists" });

    const next = doc("c2");
    const replaced = await runHelper(
      DESIGN_EXPORT_CONTAINER_WRITER,
      [
        root,
        "c.orkdes",
        "present",
        designExportDigest(bytes),
        String(DESIGN_EXPORT_MAX_BYTES),
        designExportDigest(next),
      ],
      next,
    );
    expect(replaced.json).toMatchObject({ ok: true, replaced: true });
    expect(Buffer.from(replaced.json.previous as string, "base64")).toEqual(bytes);
    expect(await fs.readFile(path.join(root, "c.orkdes"))).toEqual(next);

    await fs.symlink("/etc/hostname", path.join(root, "l.orkdes"));
    const symlink = await runHelper(
      DESIGN_EXPORT_CONTAINER_WRITER,
      [root, "l.orkdes", "absent", "-", String(DESIGN_EXPORT_MAX_BYTES), designExportDigest(bytes)],
      bytes,
    );
    expect(symlink.json).toMatchObject({ ok: false, code: "invalid-input", reason: "symlink" });
    expect(await tempFiles(root)).toEqual([]);
  });

  test("writer creates folders, refuses linked folders, and inspector reads nested files", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    const bytes = doc("n1");
    const args = (rel: string) => [
      root,
      rel,
      "absent",
      "-",
      String(DESIGN_EXPORT_MAX_BYTES),
      designExportDigest(bytes),
    ];
    const created = await runHelper(
      DESIGN_EXPORT_CONTAINER_WRITER,
      args("designs/ui/n.orkdes"),
      bytes,
    );
    expect(created.json).toEqual({ ok: true, digest: designExportDigest(bytes), replaced: false });
    expect(await fs.readFile(path.join(root, "designs/ui/n.orkdes"))).toEqual(bytes);
    expect(await tempFiles(path.join(root, "designs/ui"))).toEqual([]);

    const inspected = await runHelper(DESIGN_EXPORT_CONTAINER_INSPECTOR, [
      root,
      "designs/ui/n.orkdes",
      "10000",
    ]);
    expect(inspected.json).toMatchObject({ ok: true, exists: true, readable: true });
    const missing = await runHelper(DESIGN_EXPORT_CONTAINER_INSPECTOR, [
      root,
      "nope/n.orkdes",
      "10000",
    ]);
    expect(missing.json).toMatchObject({ ok: true, exists: false });

    await fs.symlink(outside, path.join(root, "linked"));
    const linked = await runHelper(DESIGN_EXPORT_CONTAINER_WRITER, args("linked/n.orkdes"), bytes);
    expect(linked.json).toMatchObject({ ok: false, code: "invalid-input", reason: "symlink" });
    expect(await fs.readdir(outside)).toEqual([]);
    const linkedInspect = await runHelper(DESIGN_EXPORT_CONTAINER_INSPECTOR, [
      root,
      "linked/n.orkdes",
      "10000",
    ]);
    expect(linkedInspect.json).toMatchObject({
      ok: true,
      exists: true,
      readable: false,
      symlink: true,
    });
    const traversal = await runHelper(DESIGN_EXPORT_CONTAINER_WRITER, args("a/../n.orkdes"), bytes);
    expect(traversal.json).toMatchObject({
      ok: false,
      code: "invalid-input",
      reason: "invalid-path",
    });
  });

  test("writer refuses truncated input, oversized input, and bad names", async () => {
    const root = await createRoot();
    const bytes = doc("full");
    const truncated = await runHelper(
      DESIGN_EXPORT_CONTAINER_WRITER,
      [root, "t.orkdes", "absent", "-", String(DESIGN_EXPORT_MAX_BYTES), designExportDigest(bytes)],
      bytes.subarray(0, 10),
    );
    expect(truncated.json).toMatchObject({
      ok: false,
      code: "storage",
      reason: "incomplete-input",
    });
    const oversized = await runHelper(
      DESIGN_EXPORT_CONTAINER_WRITER,
      [root, "t.orkdes", "absent", "-", "8", designExportDigest(bytes)],
      bytes,
    );
    expect(oversized.json).toMatchObject({ ok: false, code: "invalid-input", reason: "too-large" });
    const badName = await runHelper(
      DESIGN_EXPORT_CONTAINER_WRITER,
      [root, "../t.orkdes", "absent", "-", "100", designExportDigest(bytes)],
      bytes,
    );
    expect(badName.json).toMatchObject({
      ok: false,
      code: "invalid-input",
      reason: "invalid-path",
    });
    expect(await fs.readdir(root)).toEqual([]);
  });

  test("inspector reports state without following symlinks", async () => {
    const root = await createRoot();
    const bytes = doc("inspect");
    await fs.writeFile(path.join(root, "i.orkdes"), bytes);
    await fs.symlink(path.join(root, "i.orkdes"), path.join(root, "s.orkdes"));
    const present = await runHelper(DESIGN_EXPORT_CONTAINER_INSPECTOR, [
      root,
      "i.orkdes",
      String(DESIGN_EXPORT_MAX_BYTES),
    ]);
    expect(present.json).toEqual({
      ok: true,
      exists: true,
      readable: true,
      digest: designExportDigest(bytes),
      bytes: bytes.toString("base64"),
    });
    const absent = await runHelper(DESIGN_EXPORT_CONTAINER_INSPECTOR, [root, "n.orkdes", "10"]);
    expect(absent.json).toEqual({ ok: true, exists: false, readable: false });
    const symlink = await runHelper(DESIGN_EXPORT_CONTAINER_INSPECTOR, [root, "s.orkdes", "10000"]);
    expect(symlink.json).toEqual({ ok: true, exists: true, readable: false, symlink: true });
  });
});

describe("container wrapper", () => {
  const container = { kind: "container", containerId: "container-1" } as const;

  test("round-trips through the helper with a mapped workspace root", async () => {
    const root = await createRoot();
    const spawnFn = localContainerSpawn(root);
    const first = doc("first");
    await writeDesignExport(container, "w.orkdes", first, { state: "absent" }, { spawn: spawnFn });
    const state = await inspectDesignExportTarget(container, "w.orkdes", { spawn: spawnFn });
    expect(state).toMatchObject({
      exists: true,
      readable: true,
      digest: designExportDigest(first),
    });
    expect(state.bytes).toEqual(first);
    const second = doc("second");
    const result = await writeDesignExport(
      container,
      "w.orkdes",
      second,
      { state: "present", digest: designExportDigest(first) },
      { spawn: spawnFn },
    );
    expect(result).toEqual({ digest: designExportDigest(second), replaced: true, previous: first });
    await expectDesignError(
      writeDesignExport(
        container,
        "w.orkdes",
        doc("third"),
        { state: "present", digest: designExportDigest(first) },
        { spawn: spawnFn },
      ),
      "export-collision",
    );
    expect(await fs.readFile(path.join(root, "w.orkdes"))).toEqual(second);
  });

  test("concurrent absent container writes have one winner", async () => {
    const root = await createRoot();
    const spawnFn = localContainerSpawn(root);
    const a = doc("a", 5000);
    const b = doc("b", 5000);
    const results = await Promise.allSettled([
      writeDesignExport(container, "same.orkdes", a, { state: "absent" }, { spawn: spawnFn }),
      writeDesignExport(container, "same.orkdes", b, { state: "absent" }, { spawn: spawnFn }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = results[0]!.status === "fulfilled" ? a : b;
    expect(await fs.readFile(path.join(root, "same.orkdes"))).toEqual(winner);
    expect(await tempFiles(root)).toEqual([]);
  });

  test("a timeout kills the client and reports an unknown outcome", async () => {
    const fake = fakeSpawn(() => undefined);
    const error = await expectDesignError(
      writeDesignExport(
        container,
        "x.orkdes",
        doc("x"),
        { state: "absent" },
        {
          spawn: fake.spawn,
          timeoutMs: 30,
        },
      ),
      "unknown-outcome",
    );
    expect(error.failure.details).toMatchObject({ reason: "timeout" });
    expect(fake.children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
    await expectDesignError(
      inspectDesignExportTarget(container, "x.orkdes", { spawn: fake.spawn, timeoutMs: 30 }),
      "storage",
    );
  });

  test("garbage output is an unknown outcome for writes and storage for inspection", async () => {
    const fake = fakeSpawn((child) => emitAndClose(child, "garbage {not json\n", "", 137));
    await expectDesignError(
      writeDesignExport(
        container,
        "x.orkdes",
        doc("x"),
        { state: "absent" },
        { spawn: fake.spawn },
      ),
      "unknown-outcome",
    );
    await expectDesignError(
      inspectDesignExportTarget(container, "x.orkdes", { spawn: fake.spawn }),
      "storage",
    );
  });

  test("a result that does not match the request is an unknown outcome", async () => {
    const fake = fakeSpawn((child) =>
      emitAndClose(
        child,
        `${JSON.stringify({ ok: true, digest: designExportDigest(Buffer.from("other")), replaced: false })}\n`,
      ),
    );
    await expectDesignError(
      writeDesignExport(
        container,
        "x.orkdes",
        doc("x"),
        { state: "absent" },
        { spawn: fake.spawn },
      ),
      "unknown-outcome",
    );
  });

  test("helper failures map to content-free typed errors", async () => {
    const fake = fakeSpawn((child) =>
      emitAndClose(
        child,
        `${JSON.stringify({ ok: false, code: "storage", reason: "changed", message: "SECRET CONTENT" })}\n`,
        "",
        1,
      ),
    );
    const error = await expectDesignError(
      writeDesignExport(
        container,
        "x.orkdes",
        doc("x"),
        { state: "absent" },
        { spawn: fake.spawn },
      ),
      "export-collision",
    );
    expect(error.message).not.toContain("SECRET");
  });

  test("an unavailable container is a storage failure, not an unknown outcome", async () => {
    const fake = fakeSpawn((child) =>
      emitAndClose(child, "", "Error response from daemon: No such container: container-1\n", 1),
    );
    await expectDesignError(
      writeDesignExport(
        container,
        "x.orkdes",
        doc("x"),
        { state: "absent" },
        { spawn: fake.spawn },
      ),
      "storage",
    );
    const throwing: DesignExportSpawn = () => {
      throw new Error("spawn docker ENOENT");
    };
    await expectDesignError(
      writeDesignExport(container, "x.orkdes", doc("x"), { state: "absent" }, { spawn: throwing }),
      "storage",
    );
    const missingDocker = fakeSpawn((child) => {
      child.pid = undefined;
      child.emit("error", Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }));
    });
    await expectDesignError(
      writeDesignExport(
        container,
        "x.orkdes",
        doc("x"),
        { state: "absent" },
        {
          spawn: missingDocker.spawn,
        },
      ),
      "storage",
    );
  });

  test("unbounded output is cut off and reported as an unknown outcome", async () => {
    const fake = fakeSpawn((child) => {
      child.stdout.write(Buffer.alloc(7 * 1024 * 1024, 0x61));
    });
    const error = await expectDesignError(
      writeDesignExport(
        container,
        "x.orkdes",
        doc("x"),
        { state: "absent" },
        { spawn: fake.spawn },
      ),
      "unknown-outcome",
    );
    expect(error.failure.details).toMatchObject({ reason: "output-overflow" });
    expect(fake.children[0]!.kill).toHaveBeenCalled();
  });

  test("invalid container identifiers are rejected", async () => {
    await expectDesignError(
      writeDesignExport({ kind: "container", containerId: "--privileged" }, "x.orkdes", doc("x"), {
        state: "absent",
      }),
      "invalid-input",
    );
  });
});
