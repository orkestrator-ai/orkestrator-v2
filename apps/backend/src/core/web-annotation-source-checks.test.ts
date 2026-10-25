import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONTAINER_PATH_CHECKER,
  checkWebAnnotationWorkspacePaths,
  parseContainerPathStatuses,
  runContainerPathCheck,
} from "./web-annotation-source-checks.js";

/** Run the in-container checker with the host's Node against a local root. */
function runChecker(root: string, paths: unknown, budgetMs = 2_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["-e", CONTAINER_PATH_CHECKER, "--", root, String(budgetMs)], {
      stdio: "pipe",
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`exit ${code}`)),
    );
    child.stdin.end(JSON.stringify(paths));
  });
}

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

  test("container workspaces are checked inside the container when a check is available", async () => {
    const asked: Array<{ containerId: string; paths: readonly string[] }> = [];
    const checks = await checkWebAnnotationWorkspacePaths(
      { id: "env-b", environmentType: "docker", containerId: "c1" },
      ["src/Save.tsx", "src/Missing.tsx", "../x", "src/Save.tsx"],
      {
        checkContainer: async (containerId, paths) => {
          asked.push({ containerId, paths });
          return ["exists", "missing"];
        },
      },
    );
    // Lexically unsafe paths are answered on the host and never sent.
    expect(asked).toEqual([{ containerId: "c1", paths: ["src/Save.tsx", "src/Missing.tsx"] }]);
    expect(checks).toEqual([
      { path: "src/Save.tsx", status: "exists" },
      { path: "src/Missing.tsx", status: "missing" },
      { path: "../x", status: "outside-workspace" },
    ]);
  });

  test("a failed or malformed container check reports unavailable", async () => {
    for (const checkContainer of [
      async () => {
        throw new Error("docker exec failed");
      },
      async () => ["exists"],
      async () => ["exists", "maybe"],
    ]) {
      const checks = await checkWebAnnotationWorkspacePaths(
        { id: "env-b", environmentType: "docker", containerId: "c1" },
        ["src/Save.tsx", "src/Other.tsx"],
        { checkContainer },
      );
      expect(checks.map((check) => check.status)).toEqual(["unavailable", "unavailable"]);
    }
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

describe("CONTAINER_PATH_CHECKER", () => {
  test("applies the local rules: existence, symlinks resolved inside the root, no escape", async () => {
    await mkdir(path.join(workspace, "lib"), { recursive: true });
    await symlink(
      path.join(workspace, "src", "Save.tsx"),
      path.join(workspace, "lib", "alias.tsx"),
    );
    const statuses = await runChecker(workspace, [
      "src/Save.tsx",
      "src/Missing.tsx",
      "lib/alias.tsx",
      "src/escape.txt",
      "../outside.txt",
      "/etc/passwd",
      "src/Save.tsx/child",
    ]);
    expect(statuses).toEqual([
      "exists",
      "missing",
      "exists",
      "outside-workspace",
      "outside-workspace",
      "outside-workspace",
      "missing",
    ]);
  });

  test("paths past the budget are unavailable, and a missing root answers unavailable", async () => {
    expect(await runChecker(workspace, ["src/Save.tsx"], -1)).toEqual(["unavailable"]);
    expect(await runChecker(path.join(root, "nope"), ["src/Save.tsx"])).toEqual(["unavailable"]);
  });

  test("refuses input that is not a bounded list", async () => {
    await expect(runChecker(workspace, { paths: [] })).rejects.toThrow("exit 3");
    await expect(
      runChecker(
        workspace,
        Array.from({ length: 201 }, (_, index) => `f${index}`),
      ),
    ).rejects.toThrow("exit 3");
  });

  test("the answer is parsed strictly", () => {
    expect(parseContainerPathStatuses(["exists", "missing"], 2)).toEqual(["exists", "missing"]);
    expect(() => parseContainerPathStatuses(["exists"], 2)).toThrow();
    expect(() => parseContainerPathStatuses(["exists", "gone"], 2)).toThrow();
    expect(() => parseContainerPathStatuses({}, 0)).toThrow();
  });

  test("runContainerPathCheck runs the checker through docker exec and kills it at the timeout", async () => {
    // Stand in for `docker exec -i <id> node -e SCRIPT -- /workspace <budget>`
    // by running the same script locally against this test's workspace.
    const calls: string[][] = [];
    const fakeSpawn = ((command: string, args: string[]) => {
      calls.push([command, ...args]);
      const script = args[args.indexOf("-e") + 1]!;
      const budget = args.at(-1)!;
      return spawn("node", ["-e", script, "--", workspace, budget], { stdio: "pipe" });
    }) as Parameters<typeof runContainerPathCheck>[0];
    await expect(
      runContainerPathCheck(fakeSpawn, "c1", ["src/Save.tsx", "src/Missing.tsx"]),
    ).resolves.toEqual(["exists", "missing"]);
    expect(calls[0]!.slice(0, 5)).toEqual(["docker", "exec", "-i", "c1", "node"]);
    expect(calls[0]!.slice(-2)).toEqual(["/workspace", "2000"]);

    const hanging = (() =>
      spawn("node", ["-e", "setTimeout(() => {}, 10_000)"], { stdio: "pipe" })) as Parameters<
      typeof runContainerPathCheck
    >[0];
    await expect(
      runContainerPathCheck(hanging, "c1", ["src/Save.tsx"], { timeoutMs: 200 }),
    ).rejects.toThrow("timed out");
  });
});
