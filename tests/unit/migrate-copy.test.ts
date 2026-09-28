import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCopyOutput } from "../../apps/backend/src/core/container-replacement";

/**
 * The verified copy helper (`docker/orkestrator-migrate.sh`), run with the
 * host's GNU tar as an ordinary user. Ownership is whatever the test user
 * extracts, so what is checked here is that the manifest compares it, not
 * that root restores it.
 */
const SCRIPT = resolve(import.meta.dir, "../../docker/orkestrator-migrate.sh");
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

function copyStream(input: Buffer, destination: string, strip: number, ...wildcards: string[]) {
  const run = spawnSync("bash", [SCRIPT, "copy-stream", destination, String(strip), ...wildcards], {
    input,
  });
  return parseCopyOutput(run.stdout.toString());
}

describe("verified copy helper", () => {
  test("copies files, hard links, symlinks and empty directories and verifies them", () => {
    const { root } = workspace();
    const archive = execFileSync("tar", ["-C", join(root, "src"), "-cf", "-", "ws"]);
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
    const archive = execFileSync("tar", ["-C", join(root, "src"), "-cf", "-", "ws"]);
    const extraFile = join(root, "extra-file");
    mkdirSync(extraFile);
    writeFileSync(join(extraFile, "stale.txt"), "left over");
    expect(copyStream(archive, extraFile, 1)).toEqual({ ok: false, reason: "mismatch:files" });
    const extraDir = join(root, "extra-dir");
    mkdirSync(join(extraDir, "stale-dir"), { recursive: true });
    const output = spawnSync("bash", [SCRIPT, "copy-stream", extraDir, "1"], { input: archive });
    expect(output.stdout.toString()).toContain("status=mismatch kind=dirs");
  });

  test("a selective copy does not count the parent directories it creates", () => {
    const { root } = workspace();
    const archive = execFileSync("tar", ["-C", join(root, "src"), "-cf", "-", "ws"]);
    expect(copyStream(archive, join(root, "selected"), 1, "ws/sub/b.bin")).toMatchObject({
      ok: true,
      files: 1,
    });
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
    const output = spawnSync("bash", [SCRIPT, "copy-stream", join(root, "dev"), "1"], {
      input: craft.stdout,
    });
    expect(output.stdout.toString()).toContain("status=unsupported kind=device");
    expect(parseCopyOutput(output.stdout.toString())).toEqual({
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
    const archive = execFileSync("tar", ["-C", join(root, "src"), "-cf", "-", "ws"]);
    const truncated = archive.subarray(0, Math.floor(archive.length / 3));
    const result = copyStream(truncated, join(root, "truncated"), 1);
    expect(result.ok).toBe(false);
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
