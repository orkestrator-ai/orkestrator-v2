/**
 * Container materialization commands route app-owned evidence through the
 * no-follow writer and the ownership-checked remover. A fake `docker` on
 * PATH runs the in-container `node -e` script against a local directory
 * standing in for `/workspace`, so the real script is exercised.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands.js";
import { makePng } from "./web-annotation-test-support.js";

let root: string;
let workspace: string;
let outside: string;
let previous: { path?: string; workspace?: string; log?: string };

const FAKE_DOCKER = `#!/bin/sh
printf '%s %s %s %s\\n' "$1" "$2" "$3" "$4" >> "$FAKE_DOCKER_LOG"
[ "$1" = exec ] || exit 40
shift 3
[ "$1" = node ] || exit 41
shift
[ "$1" = -e ] || exit 42
shift
script="$1"
shift 3
exec node -e "$script" -- "$FAKE_WORKSPACE" "$@"
`;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ork-wa-docker-"));
  workspace = path.join(root, "workspace");
  outside = path.join(root, "outside");
  await mkdir(path.join(root, "bin"), { recursive: true });
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(path.join(root, "bin", "docker"), FAKE_DOCKER);
  await chmod(path.join(root, "bin", "docker"), 0o755);
  previous = {
    path: process.env.PATH,
    workspace: process.env.FAKE_WORKSPACE,
    log: process.env.FAKE_DOCKER_LOG,
  };
  process.env.PATH = `${path.join(root, "bin")}${path.delimiter}${previous.path ?? ""}`;
  process.env.FAKE_WORKSPACE = workspace;
  process.env.FAKE_DOCKER_LOG = path.join(root, "docker.log");
});

afterEach(async () => {
  for (const [key, value] of [
    ["PATH", previous.path],
    ["FAKE_WORKSPACE", previous.workspace],
    ["FAKE_DOCKER_LOG", previous.log],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

const context = {} as CommandContext;
const RELATIVE = ".orkestrator/annotations/req-1-0123456789abcdef.png";
const png = makePng(4, 3, 11);
const digest = createHash("sha256").update(png).digest("hex");

describe("container evidence commands", () => {
  test("write_container_file writes evidence through the no-follow writer", async () => {
    const commands = createCommandRegistry();
    const written = await commands.get("write_container_file")!(
      { containerId: "container-1", filePath: RELATIVE, base64Data: png.toString("base64") },
      context,
    );
    expect(written).toBe(`/workspace/${RELATIVE}`);
    expect((await readFile(path.join(workspace, RELATIVE))).equals(png)).toBe(true);
    const log = await readFile(path.join(root, "docker.log"), "utf8");
    expect(log).toContain("exec -i container-1 node");
    expect(log).not.toContain("base64 -d");
  });

  test("a symlinked evidence directory cannot redirect the write", async () => {
    await mkdir(path.join(workspace, ".orkestrator"));
    await symlink(outside, path.join(workspace, ".orkestrator", "annotations"));
    const commands = createCommandRegistry();
    await expect(
      commands.get("write_container_file")!(
        { containerId: "container-1", filePath: RELATIVE, base64Data: png.toString("base64") },
        context,
      ),
    ).rejects.toThrow("Symbolic links are not allowed");
    expect(await readdir(outside)).toEqual([]);
  });

  test("delete_container_annotation_evidence removes only matching evidence", async () => {
    await mkdir(path.join(workspace, ".orkestrator", "annotations"), { recursive: true });
    await writeFile(path.join(workspace, RELATIVE), png);
    const commands = createCommandRegistry();
    const remove = (digestValue: string, filePath = RELATIVE) =>
      commands.get("delete_container_annotation_evidence")!(
        { containerId: "container-1", filePath, digest: digestValue },
        context,
      );
    expect(await remove("f".repeat(64))).toBe("mismatch");
    expect(existsSync(path.join(workspace, RELATIVE))).toBe(true);
    expect(await remove(digest)).toBe("removed");
    expect(await remove(digest)).toBe("missing");
    await expect(remove(digest, "src/app.ts")).rejects.toThrow(
      "not an app-generated evidence path",
    );
    await expect(remove("not-a-digest")).rejects.toThrow("digest is invalid");
  });
});
