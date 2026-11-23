import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { CoordinatorService } from "./coordinator/service.js";
import { NodeOutcomeUnknownError, NodeUnavailableError } from "./nodes/index.js";
import { MAX_NODE_ROOT_CHANGE_PATCH_BYTES } from "./root-changes-node.js";
import { runCommand } from "./shell.js";
import * as shell from "./shell.js";
import { StorageService, createEnvironment, createProject } from "./storage/service.js";

// The command node's checkout, coordinator, receipts and approval command run
// for real, and so does the leaf's `apply_controller_root_patch` with real
// `git apply` into a real worktree. Only the node link is simulated: it hands
// the routed call to the leaf's registry, and can drop the answer, refuse as
// a disconnected node, or answer as a leaf without the command.

let root: string;
let checkout: string;
let workerPath: string;
let storage: StorageService;
let leaf: StorageService;
let context: CommandContext;
let leafContext: CommandContext;
let commands: Map<string, CommandHandler>;
let scope: { projectId: string; coordinatorId: string; conversationId: string };
let leafProjectId: string;
let workerId: string;
let leafHomeId: string;
let routed: Array<{ command: string; args: Record<string, unknown>; requestKey?: unknown }>;
let link: "ok" | "lose-answer" | "lose-request" | "offline" | "older";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd })).stdout;
}

/** Everything that would show a write to the checkout's Git state. */
async function checkoutState(): Promise<string> {
  const objects: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else objects.push(path.relative(checkout, full));
    }
  };
  await walk(path.join(checkout, ".git", "objects"));
  const index = await readFile(path.join(checkout, ".git", "index"));
  return JSON.stringify({
    objects: objects.toSorted(),
    index: createHash("sha256").update(index).digest("hex"),
    status: await git(checkout, "status", "--porcelain=v1", "--untracked-files=all"),
  });
}

const call = <T = Record<string, unknown>>(command: string, args: Record<string, unknown>) =>
  commands.get(command)!(args, context) as Promise<T>;

/** What the approval executor runs for a worker on the leaf (`executeRootChanges`). */
const applyOnLeaf = (paths: string[], extra: Record<string, unknown> = {}) =>
  call<{ files: string[]; outcomeUnknown?: boolean }>("apply_project_root_changes", {
    projectId: scope.projectId,
    environmentId: workerId,
    paths,
    nodeId: "bk_leaf",
    nodeName: "Build box",
    nodeProjectId: leafProjectId,
    requestKey: "root-changes:approval-1",
    ...extra,
  });

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ork-root-changes-node-"));
  checkout = path.join(root, "checkout");
  workerPath = path.join(root, "leaf-worker");
  await runCommand("git", ["init", "-b", "main", checkout]);
  await git(checkout, "config", "user.email", "test@example.invalid");
  await git(checkout, "config", "user.name", "Test");
  await writeFile(path.join(checkout, "edited.txt"), "one\ntwo\n");
  await writeFile(path.join(checkout, "removed.txt"), "gone soon\n");
  await git(checkout, "add", ".");
  await git(checkout, "commit", "-m", "base");
  // The leaf's worker starts from the same commit.
  await git(checkout, "worktree", "add", "-b", "leaf-worker", workerPath);
  await writeFile(path.join(checkout, "edited.txt"), "one\ntwo\nthree\n");
  await unlink(path.join(checkout, "removed.txt"));
  await writeFile(path.join(checkout, "new.bin"), Buffer.from([0, 1, 2, 255, 0, 10]));

  storage = new StorageService(path.join(root, "data"));
  await storage.init();
  const project = await storage.addProject(
    createProject("https://github.com/acme/site.git", checkout),
  );
  const coordinator = new CoordinatorService(storage, () => ({
    enabled: true,
    running: true,
    error: null,
  }));
  const snapshot = await coordinator.ensure(project.id);
  scope = {
    projectId: project.id,
    coordinatorId: snapshot.workspace.id,
    conversationId: snapshot.workspace.conversations[0]!.id,
  };

  // The leaf's own copy of the project; its uncommitted state is never used.
  await runCommand("git", ["init", "-b", "main", path.join(root, "leaf-checkout")]);
  leaf = new StorageService(path.join(root, "leaf-data"));
  await leaf.init();
  const leafProject = await leaf.addProject(
    createProject("https://github.com/acme/site.git", path.join(root, "leaf-checkout")),
  );
  leafProjectId = leafProject.id;
  const worker = createEnvironment(leafProject.id, {
    name: "remote-worker",
    environmentType: "local",
  });
  Object.assign(worker, { status: "running", setupPhase: "ready", worktreePath: workerPath });
  await leaf.addEnvironment(worker);
  workerId = worker.id;
  const home = createEnvironment(leafProject.id, { name: "home", environmentType: "local" });
  Object.assign(home, { status: "running", setupPhase: "ready", projectHome: true });
  await leaf.addEnvironment(home);
  leafHomeId = home.id;

  commands = createCommandRegistry();
  routed = [];
  link = "ok";
  leafContext = {
    storage: leaf,
    emit: () => undefined,
    runtime: new BackendRuntime({ emit: () => undefined }),
  } as unknown as CommandContext;
  context = {
    storage,
    coordinators: coordinator,
    emit: () => undefined,
    nodes: { status: async () => ({ nodeId: "bk_command", mode: "command" }) },
    nodePortal: {
      summaries: async () => ({
        selfId: "bk_command",
        nodes: [
          {
            nodeId: "bk_leaf",
            available: true,
            view: { displayName: "Build box" },
            projects: [
              { ref: { projectId: leafProject.id }, repositoryHint: "github.com/acme/site" },
            ],
          },
        ],
      }),
      invokeOnNode: async (input: {
        command: string;
        args: Record<string, unknown>;
        requestKey?: unknown;
      }) => {
        routed.push(input);
        if (link === "offline")
          throw new NodeUnavailableError(
            "That node is not connected, so changes to it are disabled.",
          );
        if (link === "lose-request") throw new NodeOutcomeUnknownError("lost before it answered");
        const handler = commands.get(input.command);
        if (link === "older" || !handler)
          throw new Error(unknownBackendCommandMessage(input.command));
        const result = await handler(input.args, leafContext);
        if (link === "lose-answer") return { outcome: "unknown", requestKey: "k", outcomeId: "o" };
        return { outcome: "ok", result };
      },
    },
    runtime: new BackendRuntime({ emit: () => undefined }),
  } as unknown as CommandContext;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("request_root_changes for a worker on another node", () => {
  test("asks the user on this node, naming the worker's node and its project copy", async () => {
    const create = mock(async (_args: Record<string, unknown>) => ({ requestId: "approval-1" }));
    commands.set("create_node_action_request", create as unknown as CommandHandler);
    const input = {
      requestId: "changes",
      environmentId: workerId,
      nodeId: "bk_leaf",
      files: ["edited.txt"],
      reason: "Start from my edits",
    };
    expect(await call("request_coordinator_root_changes", { scope, input })).toMatchObject({
      approvalRequestId: "approval-1",
      state: "pending",
      nodeId: "bk_leaf",
    });
    expect(create.mock.calls[0]![0]).toMatchObject({
      kind: "apply-root-changes",
      targets: [
        {
          nodeId: "bk_leaf",
          nodeName: "Build box",
          nodeProjectId: leafProjectId,
          // The checkout the user picks from is this node's.
          projectId: scope.projectId,
          environmentId: workerId,
          environmentName: "remote-worker",
          files: ["edited.txt"],
        },
      ],
    });
    // Asking reads nothing from the checkout and sends no patch.
    expect(routed.map((entry) => entry.command)).toEqual(["get_environment"]);
    expect(await call("request_coordinator_root_changes", { scope, input })).toMatchObject({
      replayed: true,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("refuses the node's project checkout and an environment it does not have", async () => {
    commands.set("create_node_action_request", (async () => ({
      requestId: "never",
    })) as unknown as CommandHandler);
    await expect(
      call("request_coordinator_root_changes", {
        scope,
        input: { requestId: "home", environmentId: leafHomeId, nodeId: "bk_leaf", reason: "x" },
      }),
    ).rejects.toThrow("not a worker environment");
    await expect(
      call("request_coordinator_root_changes", {
        scope,
        input: { requestId: "missing", environmentId: "nope", nodeId: "bk_leaf", reason: "x" },
      }),
    ).rejects.toThrow();
  });
});

describe("an approved patch applied on another node", () => {
  test("builds the patch here, applies it there whole, and leaves the checkout untouched", async () => {
    const before = await checkoutState();
    const outcome = await applyOnLeaf(["edited.txt", "removed.txt", "new.bin"]);
    expect(outcome.outcomeUnknown).toBeUndefined();
    expect(outcome.files.toSorted()).toEqual(["edited.txt", "new.bin", "removed.txt"]);
    expect(await readFile(path.join(workerPath, "edited.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    expect(await readFile(path.join(workerPath, "new.bin"))).toEqual(
      Buffer.from([0, 1, 2, 255, 0, 10]),
    );
    expect(await readFile(path.join(workerPath, "removed.txt")).catch(() => null)).toBeNull();
    expect(await checkoutState()).toBe(before);
    expect(routed).toHaveLength(1);
    const [sent] = routed;
    expect(sent).toMatchObject({
      command: "apply_controller_root_patch",
      requestKey: "root-changes:approval-1",
      args: { projectId: leafProjectId, environmentId: workerId },
    });
    const patch = Buffer.from(sent!.args.patch as string, "base64");
    expect(sent!.args.sha256).toBe(createHash("sha256").update(patch).digest("hex"));
  });

  test("a patch over the node limit is refused before anything is sent", async () => {
    await writeFile(
      path.join(checkout, "large.txt"),
      "abcdefghijklmnopqrstuvwxyz0123456789\n".repeat(
        Math.ceil((MAX_NODE_ROOT_CHANGE_PATCH_BYTES + 1024 * 1024) / 37),
      ),
    );
    await expect(applyOnLeaf(["large.txt"])).rejects.toThrow(
      /MiB; at most 16 MiB can be sent to Build box\. .*Nothing was sent\./,
    );
    expect(routed).toHaveLength(0);
  }, 30_000);

  test("a selection past the local 32 MiB cap still gets the node limit's refusal", async () => {
    await writeFile(
      path.join(checkout, "huge.txt"),
      "abcdefghijklmnopqrstuvwxyz0123456789\n".repeat(Math.ceil((33 * 1024 * 1024) / 37)),
    );
    await expect(applyOnLeaf(["huge.txt"])).rejects.toThrow(
      /larger than 16 MiB; at most 16 MiB can be sent to Build box\. .*Nothing was sent\./,
    );
    expect(routed).toHaveLength(0);
  }, 30_000);

  for (const [label, config] of [
    ["diff.mnemonicPrefix", [["diff.mnemonicPrefix", "true"]]],
    [
      "custom diff.srcPrefix and diff.dstPrefix",
      [
        ["diff.srcPrefix", "SRC/"],
        ["diff.dstPrefix", "DST/"],
      ],
    ],
    ["diff.noprefix", [["diff.noprefix", "true"]]],
  ] as const)
    test(`the checkout's ${label} does not change the patch the node reads`, async () => {
      for (const [key, value] of config) await git(checkout, "config", key, value);
      const outcome = await applyOnLeaf(["edited.txt", "removed.txt", "new.bin"]);
      expect(outcome.outcomeUnknown).toBeUndefined();
      expect(outcome.files.toSorted()).toEqual(["edited.txt", "new.bin", "removed.txt"]);
      const patch = Buffer.from(routed[0]!.args.patch as string, "base64").toString("utf8");
      const headers = patch.split("\n").filter((line) => line.startsWith("diff --git "));
      expect(headers.toSorted()).toEqual([
        "diff --git a/edited.txt b/edited.txt",
        "diff --git a/new.bin b/new.bin",
        "diff --git a/removed.txt b/removed.txt",
      ]);
      expect(await readFile(path.join(workerPath, "edited.txt"), "utf8")).toBe("one\ntwo\nthree\n");
      expect(await readFile(path.join(workerPath, "new.bin"))).toEqual(
        Buffer.from([0, 1, 2, 255, 0, 10]),
      );
      expect(await readFile(path.join(workerPath, "removed.txt")).catch(() => null)).toBeNull();
    });

  test("a container worker there gets the patch through docker exec, check then apply", async () => {
    await leaf.updateEnvironment(workerId, {
      environmentType: "containerized",
      containerId: "leaf-container",
    });
    const original = shell.runCommand;
    const docker: string[][] = [];
    // The container's /workspace is the worker's worktree here: run the git
    // command docker would have run inside it, with the same stdin.
    const command = spyOn(shell, "runCommand").mockImplementation(
      async (executable, args = [], options) => {
        if (executable !== "docker") return original(executable, args, options);
        docker.push(args);
        return original("git", args.slice(args.indexOf("git") + 1), {
          ...options,
          cwd: workerPath,
        });
      },
    );
    try {
      const outcome = await applyOnLeaf(["edited.txt", "removed.txt", "new.bin"]);
      expect(outcome.files.toSorted()).toEqual(["edited.txt", "new.bin", "removed.txt"]);
    } finally {
      command.mockRestore();
    }
    expect(docker).toEqual([
      [
        "exec",
        "-u",
        "node",
        "-w",
        "/workspace",
        "-i",
        "leaf-container",
        "git",
        "apply",
        "--check",
        "--binary",
        "-",
      ],
      [
        "exec",
        "-u",
        "node",
        "-w",
        "/workspace",
        "-i",
        "leaf-container",
        "git",
        "apply",
        "--binary",
        "-",
      ],
    ]);
    expect(await readFile(path.join(workerPath, "edited.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    expect(await readFile(path.join(workerPath, "new.bin"))).toEqual(
      Buffer.from([0, 1, 2, 255, 0, 10]),
    );
    expect(await readFile(path.join(workerPath, "removed.txt")).catch(() => null)).toBeNull();
  });

  test("a lost answer settles outcome-unknown and is not resent", async () => {
    link = "lose-answer";
    expect(await applyOnLeaf(["edited.txt"])).toMatchObject({ outcomeUnknown: true });
    link = "lose-request";
    expect(await applyOnLeaf(["new.bin"])).toMatchObject({ outcomeUnknown: true });
    expect(routed.map((entry) => entry.command)).toEqual([
      "apply_controller_root_patch",
      "apply_controller_root_patch",
    ]);
  });

  test("a disconnected node and an older node are refused with nothing sent", async () => {
    link = "offline";
    await expect(applyOnLeaf(["edited.txt"])).rejects.toThrow(
      "Build box is not connected. Nothing was sent.",
    );
    link = "older";
    await expect(applyOnLeaf(["edited.txt"])).rejects.toThrow(
      "Build box runs an older Orkestrator that cannot receive uncommitted changes; update that node",
    );
    expect(await readFile(path.join(workerPath, "edited.txt"), "utf8")).toBe("one\ntwo\n");
  });

  test("a patch that does not apply there leaves the worker untouched and says why", async () => {
    await writeFile(path.join(workerPath, "edited.txt"), "something else\n");
    await expect(applyOnLeaf(["edited.txt", "new.bin"])).rejects.toThrow(
      "do not apply to the worker",
    );
    expect(await readFile(path.join(workerPath, "new.bin")).catch(() => null)).toBeNull();
    expect(await readFile(path.join(workerPath, "edited.txt"), "utf8")).toBe("something else\n");
  });

  test("files no longer changed here, and an empty selection, are refused before sending", async () => {
    await expect(applyOnLeaf(["kept.txt"])).rejects.toThrow("no longer changed");
    await expect(applyOnLeaf([])).rejects.toThrow("Pick at least one file.");
    expect(routed).toHaveLength(0);
  });
});

describe("apply_controller_root_patch on the worker's node", () => {
  const patchFor = async (paths: string[]) => {
    const diff = await runCommand("git", ["diff", "--binary", "HEAD", "--", ...paths], {
      cwd: checkout,
    });
    return Buffer.from(diff.stdout);
  };
  const run = (args: Record<string, unknown>) =>
    commands.get("apply_controller_root_patch")!(args, leafContext);

  test("refuses a patch that did not arrive whole, the checkout and another project's worker", async () => {
    const patch = await patchFor(["edited.txt"]);
    const good = {
      projectId: leafProjectId,
      environmentId: workerId,
      patch: patch.toString("base64"),
      sha256: createHash("sha256").update(patch).digest("hex"),
    };
    await expect(run({ ...good, sha256: "0".repeat(64) })).rejects.toThrow("did not arrive whole");
    await expect(run({ ...good, patch: "not base64!" })).rejects.toThrow("Expected a base64 patch");
    await expect(run({ ...good, sha256: undefined })).rejects.toThrow("sha256");
    await expect(run({ ...good, environmentId: leafHomeId })).rejects.toThrow(
      "cannot receive its own changes",
    );
    await expect(run({ ...good, projectId: "other-project" })).rejects.toThrow(
      "not in this project",
    );
    expect(await readFile(path.join(workerPath, "edited.txt"), "utf8")).toBe("one\ntwo\n");
    expect(await run(good)).toEqual({ files: ["edited.txt"] });
    expect(await readFile(path.join(workerPath, "edited.txt"), "utf8")).toBe("one\ntwo\nthree\n");
  });
});
