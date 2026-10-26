import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCopyOutput } from "../../apps/backend/src/core/container-replacement";
import { gnuToolPath, missingGnuTools, titleWithSkip } from "./gnu-shell-tools";

/**
 * The verified copy helper (`docker/orkestrator-migrate.sh`), run with the
 * host's GNU tar as an ordinary user. Ownership is whatever the test user
 * extracts, so what is checked here is that the manifest compares it, not
 * that root restores it.
 */
const SCRIPT = resolve(import.meta.dir, "../../docker/orkestrator-migrate.sh");
const SHELL_ENV = { ...process.env, PATH: gnuToolPath };
const NO_GNU_TAR = missingGnuTools("tar");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): { root: string; src: string } {
  const root = mkdtempSync(join(tmpdir(), "ork-migrate-"));
  dirs.push(root);
  const src = join(root, "src", "ws");
  mkdirSync(join(src, "sub", "empty"), { recursive: true });
  writeFileSync(join(src, "a.txt"), "hello\n");
  linkSync(join(src, "a.txt"), join(src, "sub", "hard.txt"));
  symlinkSync("a.txt", join(src, "link"));
  writeFileSync(join(src, "sub", "b.bin"), Buffer.from([0, 1, 2, 255]));
  return { root, src };
}

function archiveOf(root: string): Buffer {
  return execFileSync("tar", ["-C", join(root, "src"), "-cf", "-", "ws"], { env: SHELL_ENV });
}

function runCopy(input: Buffer, destination: string, strip: number, ...wildcards: string[]) {
  const run = spawnSync("bash", [SCRIPT, "copy-stream", destination, String(strip), ...wildcards], {
    input,
    env: SHELL_ENV,
  });
  return run.stdout.toString();
}

function copyStream(input: Buffer, destination: string, strip: number, ...wildcards: string[]) {
  return parseCopyOutput(runCopy(input, destination, strip, ...wildcards));
}

describe.skipIf(NO_GNU_TAR !== undefined)(titleWithSkip("verified copy helper", NO_GNU_TAR), () => {
  test("copies files, hard links, symlinks and empty directories and verifies them", () => {
    const { root } = workspace();
    const archive = archiveOf(root);
    const destination = join(root, "dst");
    const result = copyStream(archive, destination, 1);
    expect(result).toMatchObject({ ok: true, files: 3 });
    // The hard link is a link again, not a second copy.
    expect(statSync(join(destination, "sub", "hard.txt")).ino).toBe(
      statSync(join(destination, "a.txt")).ino,
    );
    expect(statSync(join(destination, "sub", "empty")).isDirectory()).toBe(true);
  });

  test("a destination that differs from the stream is a mismatch, not a copy", () => {
    const { root } = workspace();
    const archive = archiveOf(root);
    const extraFile = join(root, "extra-file");
    mkdirSync(extraFile);
    writeFileSync(join(extraFile, "stale.txt"), "left over");
    expect(copyStream(archive, extraFile, 1)).toEqual({ ok: false, reason: "mismatch:files" });
    const extraDir = join(root, "extra-dir");
    mkdirSync(join(extraDir, "stale-dir"), { recursive: true });
    expect(runCopy(archive, extraDir, 1)).toContain("status=mismatch kind=dirs");
  });

  test("a selective copy does not count the parent directories it creates", () => {
    const { root } = workspace();
    const archive = archiveOf(root);
    expect(copyStream(archive, join(root, "selected"), 1, "ws/sub/b.bin")).toMatchObject({
      ok: true,
      files: 1,
    });
  });

  test("a selective copy that matches nothing is a complete, empty copy", () => {
    // A legacy ~/.codex always exists (the entrypoint creates it) but holds no
    // databases until Codex runs; this read as a symlinked root and refused
    // the whole migration.
    const { root, src } = workspace();
    mkdirSync(join(src, ".codex"));
    writeFileSync(join(src, ".codex", "config.toml"), "model = 'x'\n");
    const archive = execFileSync("tar", ["-C", src, "-cf", "-", ".codex"], { env: SHELL_ENV });
    const output = runCopy(
      archive,
      join(root, "no-databases"),
      1,
      ".codex/*.sqlite",
      ".codex/*.sqlite-wal",
      ".codex/*.sqlite-shm",
    );
    expect(output).not.toContain("root-symlink");
    expect(parseCopyOutput(output)).toMatchObject({ ok: true, files: 0, bytes: 0 });
  });

  test("a symlinked root is refused for whole-tree and selective copies", () => {
    const { root } = workspace();
    const linked = join(root, "linked");
    mkdirSync(join(root, "real"));
    writeFileSync(join(root, "real", "state_5.sqlite"), "db");
    mkdirSync(linked);
    symlinkSync("../real", join(linked, ".codex"));
    const archive = execFileSync("tar", ["-C", linked, "-cf", "-", ".codex"], { env: SHELL_ENV });
    expect(runCopy(archive, join(root, "whole"), 1)).toContain("status=root-symlink");
    expect(runCopy(archive, join(root, "selected-link"), 1, ".codex/*.sqlite")).toContain(
      "status=root-symlink",
    );
  });

  test("device nodes are refused", () => {
    const { root } = workspace();
    // A character device member, written without needing mknod.
    const craft = spawnSync("python3", [
      "-c",
      [
        "import sys, tarfile, io",
        "buf = io.BytesIO()",
        "with tarfile.open(fileobj=buf, mode='w') as t:",
        "    d = tarfile.TarInfo('ws'); d.type = tarfile.DIRTYPE; d.mode = 0o755; t.addfile(d)",
        "    c = tarfile.TarInfo('ws/null'); c.type = tarfile.CHRTYPE; c.devmajor = 1; c.devminor = 3; t.addfile(c)",
        "sys.stdout.buffer.write(buf.getvalue())",
      ].join("\n"),
    ]);
    if (craft.status !== 0) throw new Error("python3 is needed to craft the archive");
    const output = runCopy(craft.stdout, join(root, "dev"), 1);
    expect(output).toContain("status=unsupported kind=device");
    expect(parseCopyOutput(output)).toEqual({
      ok: false,
      reason: "unsupported:device",
    });
  });

  test("the manifest compares numeric ownership", () => {
    const script = require("node:fs").readFileSync(SCRIPT, "utf8") as string;
    expect(script).toContain('"$TAR_UID" "$TAR_GID"');
    expect(script).toContain("%U:%G");
    expect(script).toContain("--numeric-owner");
  });

  test("a truncated archive fails extraction instead of reporting a partial copy", () => {
    const { root } = workspace();
    const archive = archiveOf(root);
    const truncated = archive.subarray(0, Math.floor(archive.length / 3));
    const result = copyStream(truncated, join(root, "truncated"), 1);
    expect(result.ok).toBe(false);
  });

  test("a volume copy archives the extended attributes extraction keeps", () => {
    // Extraction keeps `user.*` attributes and file capabilities; a producer
    // without `--xattrs` never put them in the archive, so a volume rebuild
    // dropped file capabilities (seen live on Engine 29). Hosts whose tar has
    // no xattr support only warn, so the copy itself is checked everywhere.
    const script = readFileSync(SCRIPT, "utf8");
    const includes = [
      "--xattrs",
      "--xattrs-include=user.*",
      "--xattrs-include=security.capability",
    ];
    const extractor = script.slice(script.indexOf("tar_filter_args() {"));
    const producer = script.slice(script.indexOf("    copy-volume)"));
    for (const flag of includes) {
      expect(extractor.slice(0, extractor.indexOf("\n}"))).toContain(`"${flag}"`);
      expect(producer.slice(0, producer.indexOf(";;"))).toContain(
        flag.replace("user.*", "'user.*'"),
      );
    }

    const { root, src } = workspace();
    mkdirSync(join(src, ".orkestrator"), { recursive: true });
    writeFileSync(join(src, ".orkestrator", "storage-marker.json"), "{}\n");
    const destination = join(root, "volume-copy");
    const run = spawnSync("bash", [SCRIPT, "copy-volume", src, destination], { env: SHELL_ENV });
    expect(parseCopyOutput(run.stdout.toString())).toMatchObject({ ok: true, files: 3 });
    // The source volume's marker is never copied over the candidate's own.
    expect(() => statSync(join(destination, ".orkestrator", "storage-marker.json"))).toThrow();
    expect(statSync(join(destination, "sub", "hard.txt")).ino).toBe(
      statSync(join(destination, "a.txt")).ino,
    );
  });

  test("a hard link whose target is outside the archive is not a verified copy", () => {
    const { root } = workspace();
    const craft = spawnSync("python3", [
      "-c",
      [
        "import sys, tarfile, io",
        "buf = io.BytesIO()",
        "with tarfile.open(fileobj=buf, mode='w') as t:",
        "    d = tarfile.TarInfo('ws'); d.type = tarfile.DIRTYPE; d.mode = 0o755; t.addfile(d)",
        "    h = tarfile.TarInfo('ws/escape'); h.type = tarfile.LNKTYPE; h.linkname = '../../etc/passwd'; t.addfile(h)",
        "sys.stdout.buffer.write(buf.getvalue())",
      ].join("\n"),
    ]);
    if (craft.status !== 0) throw new Error("python3 is needed to craft the archive");
    const destination = join(root, "escape");
    const result = copyStream(craft.stdout, destination, 1);
    expect(result.ok).toBe(false);
    expect(() => statSync(join(root, "etc"))).toThrow();
  });
});
