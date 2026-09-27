import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkWebAnnotationWorkspacePaths } from "./web-annotation-source-checks.js";

let root: string;
let workspace: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ork-wa-paths-"));
  workspace = path.join(root, "worktree");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "Save.tsx"), "export {};\n");
  await writeFile(path.join(root, "outside.txt"), "secret\n");
  await symlink(path.join(root, "outside.txt"), path.join(workspace, "src", "escape.txt"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("checkWebAnnotationWorkspacePaths", () => {
  test("reports existence and refuses anything that resolves outside the workspace", async () => {
    const checks = await checkWebAnnotationWorkspacePaths(
      { id: "env-a", environmentType: "local", worktreePath: workspace },
      ["src/Save.tsx", "src/Missing.tsx", "src/escape.txt", "../outside.txt", "/etc/passwd"],
    );
    expect(checks).toEqual([
      { path: "src/Save.tsx", status: "exists" },
      { path: "src/Missing.tsx", status: "missing" },
      { path: "src/escape.txt", status: "outside-workspace" },
      { path: "../outside.txt", status: "outside-workspace" },
      { path: "/etc/passwd", status: "outside-workspace" },
    ]);
  });

  test("container workspaces are reported unavailable rather than guessed", async () => {
    const checks = await checkWebAnnotationWorkspacePaths(
      { id: "env-b", environmentType: "docker", containerId: "c1" },
      ["src/Save.tsx", "src/Save.tsx", "../x"],
    );
    expect(checks).toEqual([
      { path: "src/Save.tsx", status: "unavailable" },
      { path: "../x", status: "outside-workspace" },
    ]);
  });
});
