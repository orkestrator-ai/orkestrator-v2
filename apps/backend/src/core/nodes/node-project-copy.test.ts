import { afterEach, describe, expect, jest, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { NodeSummariesResult } from "@orkestrator/protocol/node-summaries";
import { PROJECT_COPY_CHANGED_EVENT } from "@orkestrator/protocol/project-copy";

import { BackendRuntime } from "../backend-runtime.js";
import type { CommandContext } from "../commands-context.js";
import { createCommandRegistry } from "../commands.js";
import { EnvironmentLifecycleTaskTracker } from "../environment-lifecycle-tasks.js";
import { runCommand } from "../shell.js";
import { StorageService } from "../storage.js";
import { NodeFileTransfer } from "./node-file-transfer.js";
import { NodeFiles, type NodeFileScope } from "./node-files.js";
import { NodeProjectCopies } from "./node-project-copy.js";

jest.setTimeout(60_000);

const REMOTE = "https://github.com/acme/site.git";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]) {
  await runCommand("git", ["-C", cwd, ...args]);
}

/** A real origin repository, cloned whenever a node is asked to clone REMOTE. */
async function origin(root: string): Promise<string> {
  const dir = path.join(root, "origin");
  await fs.mkdir(dir, { recursive: true });
  await git(dir, "init", "-b", "main");
  await fs.writeFile(path.join(dir, "README.md"), "tracked\n");
  await fs.writeFile(path.join(dir, ".gitignore"), ".env\nnode_modules/\nconfig/\n");
  await git(dir, "add", "README.md", ".gitignore");
  await git(
    dir,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--no-gpg-sign",
    "-m",
    "init",
  );
  return dir;
}

type Machine = {
  id: string;
  name: string;
  storage: StorageService;
  invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>;
};

async function machine(root: string, id: string, originDir: string): Promise<Machine> {
  const dataDir = path.join(root, id, "data");
  const storage = new StorageService(dataDir);
  await storage.init();
  const config = await storage.loadOwnConfig();
  config.global.defaultProjectsDirectory = path.join(root, id, "projects");
  await storage.saveConfig(config);
  // Clone the fake remote from the local origin.
  const commands = createCommandRegistry({
    projectCreation: {
      runCommand: (command, args = [], options) =>
        runCommand(
          command,
          args.map((arg) => (arg === REMOTE ? originDir : arg)),
          options,
        ),
    },
  });
  const context = {
    storage,
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    runtime: new BackendRuntime({ emit: () => undefined }),
  } as unknown as CommandContext;
  const files = new NodeFiles(storage);
  const fileCommands: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    stat_node_file: (args) => files.stat(args.scope as NodeFileScope, String(args.path)),
    read_node_file: (args) =>
      files.read(
        args.scope as NodeFileScope,
        String(args.path),
        Number(args.offset),
        Number(args.length),
      ),
    begin_node_file_write: (args) =>
      files.beginWrite({
        scope: args.scope as NodeFileScope,
        path: String(args.path),
        size: Number(args.size),
        sha256: String(args.sha256),
        overwrite: args.overwrite === true,
      }),
    append_node_file_write: (args) =>
      files.appendWrite(String(args.uploadId), String(args.contentBase64)),
    commit_node_file_write: (args) => files.commitWrite(String(args.uploadId)),
    abort_node_file_write: (args) => files.abortWrite(String(args.uploadId)),
  };
  const invoke = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
    const file = fileCommands[command];
    if (file) return (await file(args)) as T;
    const handler = commands.get(command);
    if (!handler) throw new Error(`Unknown command: ${command}`);
    // Through a node link, errors arrive as plain messages.
    try {
      return (await handler(structuredClone(args), context)) as T;
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  };
  return { id, name: `${id} machine`, storage, invoke };
}

async function network() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-project-copy-"));
  roots.push(root);
  const originDir = await origin(root);
  const a = await machine(root, "a", originDir);
  const b = await machine(root, "b", originDir);
  const machines = new Map([
    [a.id, a],
    [b.id, b],
  ]);
  const events: Array<{ event: string; payload: unknown }> = [];
  const invokerFor = (nodeId: string) => {
    const target = machines.get(nodeId);
    if (!target) throw new Error(`No machine ${nodeId}`);
    return target.invoke;
  };
  const summaries = async (): Promise<NodeSummariesResult> =>
    ({
      selfId: "a",
      nodes: [{ nodeId: "b", available: true, view: { displayName: b.name } }],
    }) as unknown as NodeSummariesResult;
  const copies = new NodeProjectCopies({
    selfId: async () => "a",
    selfName: async () => a.name,
    summaries,
    invokerFor,
    transfer: new NodeFileTransfer({ invokerFor }),
    emit: (event, payload) => events.push({ event, payload }),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 10)),
  });
  // The source project on A, with files Git does not carry.
  const source = await a.invoke<{ id: string; localPath: string }>("add_project", {
    gitUrl: REMOTE,
    localPath: path.join(root, "a", "projects", "site"),
  });
  await fs.writeFile(path.join(source.localPath, ".env"), "SECRET=1\n");
  await fs.mkdir(path.join(source.localPath, "config", "deep"), {
    recursive: true,
  });
  await fs.writeFile(path.join(source.localPath, "config", "local.json"), "{}");
  await fs.writeFile(path.join(source.localPath, "config", "deep", "more.json"), "[]");
  await fs.mkdir(path.join(source.localPath, "node_modules", "pkg"), {
    recursive: true,
  });
  await fs.writeFile(path.join(source.localPath, "node_modules", "pkg", "index.js"), "x");
  await a.invoke("update_repository_config", {
    projectId: source.id,
    repoConfig: {
      ...(await a.storage.getRepositoryConfig(source.id)),
      prBaseBranch: "develop",
      entryPort: 4321,
    },
  });
  return { root, a, b, copies, events, source };
}

async function projectsOn(m: Machine) {
  return (await m.storage.loadProjects()).filter((project) => project.gitUrl === REMOTE);
}

describe("NodeProjectCopies", () => {
  test("clones on the target, copies the picked files and the repository settings", async () => {
    const { root, a, b, copies, events, source } = await network();

    const started = await copies.start({
      requestKey: "copy-1",
      source: { nodeId: a.id, projectId: source.id },
      target: { nodeId: b.id },
      paths: [".env", "config/"],
      rememberFiles: true,
    });
    await copies.settled(started.copyId);
    const record = copies.get(started.copyId)!;

    expect(record.error).toBeUndefined();
    expect(record.stage).toBe("completed");
    expect(record.reusedProject).toBe(false);
    expect(record.target.location).toBe(path.join(root, "b", "projects", "site"));
    expect(record.progress).toMatchObject({ files: 3, totalFiles: 3 });
    const [copy] = await projectsOn(b);
    expect(copy?.id).toBe(record.target.projectId!);
    const dir = copy!.localPath!;
    expect(await fs.readFile(path.join(dir, "README.md"), "utf8")).toBe("tracked\n");
    expect(await fs.readFile(path.join(dir, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(await fs.readFile(path.join(dir, "config", "deep", "more.json"), "utf8")).toBe("[]");
    // Dependencies were not picked, so they were not copied.
    expect(await fs.stat(path.join(dir, "node_modules")).catch(() => null)).toBeNull();
    const settings = await b.storage.getRepositoryConfig(copy!.id);
    expect(settings.prBaseBranch).toBe("develop");
    expect(settings.entryPort).toBe(4321);
    expect([...(settings.filesToCopy ?? [])].sort()).toEqual([
      ".env",
      "config/deep/more.json",
      "config/local.json",
    ]);
    expect(events.some((entry) => entry.event === PROJECT_COPY_CHANGED_EVENT)).toBe(true);
    // The source is untouched.
    expect(await fs.readFile(path.join(source.localPath, ".env"), "utf8")).toBe("SECRET=1\n");
  });

  test("copies into an existing copy without replacing its files", async () => {
    const { root, a, b, copies, source } = await network();
    const existing = await b.invoke<{ id: string; localPath: string }>("add_project", {
      gitUrl: REMOTE,
      localPath: path.join(root, "b", "elsewhere"),
    });
    await fs.writeFile(path.join(existing.localPath, ".env"), "MINE=1\n");

    const started = await copies.start({
      requestKey: "copy-2",
      source: { nodeId: a.id, projectId: source.id },
      target: { nodeId: b.id },
      paths: [".env", "config/local.json"],
      rememberFiles: false,
    });
    await copies.settled(started.copyId);
    const record = copies.get(started.copyId)!;

    expect(record.stage).toBe("completed");
    expect(record.reusedProject).toBe(true);
    expect(record.target.projectId).toBe(existing.id);
    expect(await projectsOn(b)).toHaveLength(1);
    expect(await fs.readFile(path.join(existing.localPath, ".env"), "utf8")).toBe("MINE=1\n");
    expect(await fs.readFile(path.join(existing.localPath, "config", "local.json"), "utf8")).toBe(
      "{}",
    );
  });

  test("a retry into a copy that was already there still leaves its settings alone", async () => {
    const { root, a, b, source } = await network();
    const existing = await b.invoke<{ id: string; localPath: string }>("add_project", {
      gitUrl: REMOTE,
      localPath: path.join(root, "b", "theirs"),
    });
    await b.invoke("update_repository_config", {
      projectId: existing.id,
      repoConfig: { ...(await b.storage.getRepositoryConfig(existing.id)), prBaseBranch: "theirs" },
    });
    // The first run fails while copying; the second goes through.
    let failWrite = true;
    const invokerFor = (nodeId: string) => {
      const machine = nodeId === a.id ? a : b;
      return async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
        if (command === "begin_node_file_write" && failWrite) {
          failWrite = false;
          throw new Error("disk full");
        }
        return machine.invoke<T>(command, args);
      };
    };
    const copies = new NodeProjectCopies({
      selfId: async () => "a",
      selfName: async () => a.name,
      summaries: async () =>
        ({
          selfId: "a",
          nodes: [{ nodeId: "b", available: true, view: { displayName: b.name } }],
        }) as unknown as NodeSummariesResult,
      invokerFor,
      transfer: new NodeFileTransfer({ invokerFor }),
      emit: () => undefined,
    });
    const input = {
      requestKey: "reuse",
      source: { nodeId: a.id, projectId: source.id },
      target: { nodeId: b.id },
      paths: [".env"],
      rememberFiles: false,
    };
    const first = await copies.start(input);
    await copies.settled(first.copyId);
    expect(copies.get(first.copyId)).toMatchObject({ stage: "failed", reusedProject: true });

    await copies.start(input);
    await copies.settled(first.copyId);
    expect(copies.get(first.copyId)).toMatchObject({ stage: "completed", reusedProject: true });
    expect((await b.storage.getRepositoryConfig(existing.id)).prBaseBranch).toBe("theirs");
    expect(await fs.readFile(path.join(existing.localPath, ".env"), "utf8")).toBe("SECRET=1\n");
  });

  test("starting the same copy twice at once runs it once", async () => {
    const { a, b, copies, source } = await network();
    const input = {
      requestKey: "twice",
      source: { nodeId: a.id, projectId: source.id },
      target: { nodeId: b.id },
      paths: [".env"],
      rememberFiles: false,
    };
    const [one, two] = await Promise.all([copies.start(input), copies.start(input)]);
    expect(two.copyId).toBe(one.copyId);
    await copies.settled(one.copyId);
    expect(copies.list()).toHaveLength(1);
    expect(await projectsOn(b)).toHaveLength(1);
  });

  test("a failed copy runs again under its request key and keeps the clone", async () => {
    const { root, a, b, copies, source } = await network();
    const location = path.join(root, "b", "projects", "site");
    // Something in the way of the clone.
    await fs.mkdir(location, { recursive: true });
    await fs.writeFile(path.join(location, "blocker"), "x");

    const first = await copies.start({
      requestKey: "copy-3",
      source: { nodeId: a.id, projectId: source.id },
      target: { nodeId: b.id, location },
      paths: [".env"],
      rememberFiles: false,
    });
    await copies.settled(first.copyId);
    expect(copies.get(first.copyId)?.stage).toBe("failed");
    expect(await projectsOn(b)).toHaveLength(0);

    await fs.rm(location, { recursive: true, force: true });
    const again = await copies.start({
      requestKey: "copy-3",
      source: { nodeId: a.id, projectId: source.id },
      target: { nodeId: b.id, location },
      paths: [".env"],
      rememberFiles: false,
    });
    expect(again.copyId).toBe(first.copyId);
    await copies.settled(again.copyId);
    const record = copies.get(again.copyId)!;
    expect(record.stage).toBe("completed");
    expect(record.error).toBeUndefined();
    expect(await fs.readFile(path.join(location, ".env"), "utf8")).toBe("SECRET=1\n");
  });

  test("copies from a leaf to the command node", async () => {
    const { root, a, b, copies, source } = await network();
    // First give B a copy, then copy B's back to a fresh A location after removing A's.
    const toB = await copies.start({
      requestKey: "to-b",
      source: { nodeId: a.id, projectId: source.id },
      target: { nodeId: b.id },
      paths: [".env"],
      rememberFiles: false,
    });
    await copies.settled(toB.copyId);
    const leafProjectId = copies.get(toB.copyId)!.target.projectId!;
    await a.invoke("remove_project", { projectId: source.id });

    const back = await copies.start({
      requestKey: "to-a",
      source: { nodeId: b.id, projectId: leafProjectId },
      target: { nodeId: a.id, location: path.join(root, "a", "returned") },
      paths: [".env"],
      rememberFiles: false,
    });
    await copies.settled(back.copyId);

    expect(copies.get(back.copyId)?.stage).toBe("completed");
    expect(await fs.readFile(path.join(root, "a", "returned", ".env"), "utf8")).toBe("SECRET=1\n");
  });

  test("refuses a copy onto its own machine and a project without a remote", async () => {
    const { a, copies, source } = await network();
    await expect(
      copies.start({
        requestKey: "same",
        source: { nodeId: a.id, projectId: source.id },
        target: { nodeId: a.id },
        paths: [],
        rememberFiles: false,
      }),
    ).rejects.toThrow("different machine");

    const local = new NodeProjectCopies({
      selfId: async () => "a",
      selfName: async () => "a machine",
      summaries: async () => ({ selfId: "a", nodes: [] }) as unknown as NodeSummariesResult,
      invokerFor:
        () =>
        async <T>() =>
          ({ id: "p", name: "scratch", gitUrl: "" }) as T,
      transfer: new NodeFileTransfer({
        invokerFor:
          () =>
          async <T>() =>
            ({}) as T,
      }),
      emit: () => undefined,
    });
    await expect(
      local.start({
        requestKey: "no-remote",
        source: { nodeId: "a", projectId: "p" },
        target: { nodeId: "b" },
        paths: [],
        rememberFiles: false,
      }),
    ).rejects.toThrow("no Git remote");
  });

  test("describes the copy: targets, default location and candidate files", async () => {
    const { root, a, copies, source } = await network();

    const options = await copies.copyOptions({
      nodeId: a.id,
      projectId: source.id,
    });

    expect(options.source).toMatchObject({
      nodeName: "a machine",
      gitUrl: REMOTE,
    });
    expect(options.targets).toEqual([
      {
        nodeId: "b",
        nodeName: "b machine",
        available: true,
        hasProject: false,
        projectId: null,
        defaultLocation: path.join(root, "b", "projects", "site"),
      },
    ]);
    const suggested = options.candidates.filter((entry) => entry.suggested).map((e) => e.path);
    expect(suggested).toEqual([".env"]);
    expect(options.candidates.find((entry) => entry.path === "node_modules/")?.heavy).toBe(true);
  });
});
