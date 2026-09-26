import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTAINER_EVIDENCE_REMOVER,
  CONTAINER_EVIDENCE_WRITER,
  isAnnotationEvidencePath,
  removeLocalEvidence,
} from "./web-annotation-evidence-files.js";
import { makePng } from "./web-annotation-test-support.js";

let workspace: string;
let outside: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "ork-wa-ws-"));
  outside = await mkdtemp(join(tmpdir(), "ork-wa-out-"));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/** Run a container script locally the way `docker exec -i ... node -e` would. */
function runScript(
  script: string,
  args: string[],
  stdin = "",
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["-e", script, "--", ...args], { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

const RELATIVE = ".orkestrator/annotations/req-1-abc.png";
const png = makePng(4, 3, 5);
const digest = createHash("sha256").update(png).digest("hex");

describe("evidence path policy", () => {
  test("only app-generated PNG paths under the evidence directory qualify", () => {
    expect(isAnnotationEvidencePath(RELATIVE)).toBe(true);
    expect(isAnnotationEvidencePath("src/app.ts")).toBe(false);
    expect(isAnnotationEvidencePath(".orkestrator/annotations/../../etc/passwd.png")).toBe(false);
    expect(isAnnotationEvidencePath(".orkestrator/annotations/.hidden.png")).toBe(false);
    expect(isAnnotationEvidencePath(".orkestrator/annotations/x.txt")).toBe(false);
  });
});

describe("container evidence writer", () => {
  test("creates the directory and writes the exact bytes atomically", async () => {
    const result = await runScript(
      CONTAINER_EVIDENCE_WRITER,
      [workspace, RELATIVE, "100000"],
      png.toString("base64"),
    );
    expect(result.code).toBe(0);
    expect((await readFile(join(workspace, RELATIVE))).equals(png)).toBe(true);
    // No temp files are left behind.
    expect(await readdir(join(workspace, ".orkestrator", "annotations"))).toEqual([
      "req-1-abc.png",
    ]);
  });

  test("refuses a symlinked evidence directory and never writes outside the workspace", async () => {
    await mkdir(join(workspace, ".orkestrator"), { recursive: true });
    await symlink(outside, join(workspace, ".orkestrator", "annotations"));
    const result = await runScript(
      CONTAINER_EVIDENCE_WRITER,
      [workspace, RELATIVE, "100000"],
      png.toString("base64"),
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Symbolic links are not allowed");
    expect(await readdir(outside)).toEqual([]);
  });

  test("replaces a symlink planted at the file name instead of following it", async () => {
    await mkdir(join(workspace, ".orkestrator", "annotations"), { recursive: true });
    const victim = join(outside, "victim.txt");
    await writeFile(victim, "keep");
    await symlink(victim, join(workspace, RELATIVE));
    const result = await runScript(
      CONTAINER_EVIDENCE_WRITER,
      [workspace, RELATIVE, "100000"],
      png.toString("base64"),
    );
    // Either refused or the link name was replaced; the target is untouched.
    expect(await readFile(victim, "utf8")).toBe("keep");
    if (result.code === 0) {
      expect((await readFile(join(workspace, RELATIVE))).equals(png)).toBe(true);
    }
  });

  test("refuses a path that escapes the workspace and oversized payloads", async () => {
    const escape = await runScript(
      CONTAINER_EVIDENCE_WRITER,
      [workspace, "../escape.png", "100000"],
      png.toString("base64"),
    );
    expect(escape.code).not.toBe(0);
    expect(existsSync(join(workspace, "..", "escape.png"))).toBe(false);
    const oversized = await runScript(
      CONTAINER_EVIDENCE_WRITER,
      [workspace, RELATIVE, "10"],
      png.toString("base64"),
    );
    expect(oversized.code).not.toBe(0);
    expect(existsSync(join(workspace, RELATIVE))).toBe(false);
  });
});

describe("evidence removal", () => {
  async function place() {
    await mkdir(join(workspace, ".orkestrator", "annotations"), { recursive: true });
    await writeFile(join(workspace, RELATIVE), png);
  }

  test("the container remover deletes only a regular file with the recorded digest", async () => {
    await place();
    const mismatch = await runScript(CONTAINER_EVIDENCE_REMOVER, [
      workspace,
      RELATIVE,
      "0".repeat(64),
      "100000",
    ]);
    expect(mismatch.stdout).toBe("mismatch");
    expect(existsSync(join(workspace, RELATIVE))).toBe(true);
    const removed = await runScript(CONTAINER_EVIDENCE_REMOVER, [
      workspace,
      RELATIVE,
      digest,
      "100000",
    ]);
    expect(removed.stdout).toBe("removed");
    expect(existsSync(join(workspace, RELATIVE))).toBe(false);
    const missing = await runScript(CONTAINER_EVIDENCE_REMOVER, [
      workspace,
      RELATIVE,
      digest,
      "100000",
    ]);
    expect(missing.stdout).toBe("missing");
  });

  test("the container remover never follows a symlinked directory", async () => {
    await mkdir(join(workspace, ".orkestrator"), { recursive: true });
    await writeFile(join(outside, "req-1-abc.png"), png);
    await symlink(outside, join(workspace, ".orkestrator", "annotations"));
    const result = await runScript(CONTAINER_EVIDENCE_REMOVER, [
      workspace,
      RELATIVE,
      digest,
      "100000",
    ]);
    expect(result.stdout).toBe("mismatch");
    expect(existsSync(join(outside, "req-1-abc.png"))).toBe(true);
  });

  test("the local remover applies the same ownership and link rules", async () => {
    await place();
    expect(await removeLocalEvidence(workspace, RELATIVE, "0".repeat(64), 100_000)).toBe(
      "mismatch",
    );
    expect(await removeLocalEvidence(workspace, RELATIVE, digest, 100_000)).toBe("removed");
    expect(await removeLocalEvidence(workspace, RELATIVE, digest, 100_000)).toBe("missing");
    await rm(join(workspace, ".orkestrator"), { recursive: true });
    await mkdir(join(workspace, ".orkestrator"));
    await writeFile(join(outside, "req-1-abc.png"), png);
    await symlink(outside, join(workspace, ".orkestrator", "annotations"));
    expect(await removeLocalEvidence(workspace, RELATIVE, digest, 100_000)).toBe("mismatch");
    expect(existsSync(join(outside, "req-1-abc.png"))).toBe(true);
    await expect(removeLocalEvidence(workspace, "src/app.ts", digest, 100_000)).rejects.toThrow(
      "not an app-generated evidence path",
    );
  });
});
