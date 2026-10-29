import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONTAINER_PINNED_ATTACHMENT_REMOVE,
  CONTAINER_PINNED_ATTACHMENT_WRITE,
} from "./commands-files.js";
import { createCommandRegistry, type CommandContext } from "./commands.js";
import type { EnvironmentCommandRunner } from "./commands-review.js";
import { BackendRuntime } from "./backend-runtime.js";
import { closeEnvironmentCleanupStorage } from "./environment-cleanup-ledger.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import { GraphArtifactStore, removeEnvironmentGraphArtifactFiles } from "./graph-artifacts.js";
import { GraphStorageError } from "./graph-run-errors.js";
import { graphEnvironmentFixture, graphRunFixture } from "./graph-run-test-support.js";
import type { Environment } from "./models.js";
import { runCommand } from "./shell.js";
import { StorageService } from "./storage.js";
import { storageDatabase } from "./storage-test-support.js";

const directories: string[] = [];
const services: StorageService[] = [];

afterEach(async () => {
  closeEnvironmentCleanupStorage();
  for (const service of services.splice(0)) service.close();
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await runCommand("chmod", ["-R", "u+w", directory]).catch(() => undefined);
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

const fence = { beginMutation: () => () => undefined };
const sha256 = (contents: Buffer | string) => createHash("sha256").update(contents).digest("hex");

async function temporary(prefix: string): Promise<string> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

/** A data directory, a Git worktree and a stored local environment and run. */
async function localWorld(environment: Partial<Environment> = {}) {
  const root = await temporary("orkestrator-graph-artifacts-");
  const worktree = path.join(root, "worktree");
  await fs.mkdir(worktree);
  await runCommand("git", ["init", "-q", "-b", "main", worktree]);
  const storage = new StorageService(path.join(root, "data"));
  await storage.init();
  services.push(storage);
  await storage.addEnvironment(graphEnvironmentFixture({ worktreePath: worktree, ...environment }));
  await storage.graphRuns.createGraphRun(graphRunFixture());
  const store = new GraphArtifactStore({ storage, fence });
  return { root, worktree, storage, store };
}

async function expectRefusal(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GraphStorageError);
    expect((error as GraphStorageError).code as string).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

const producer = { nodeId: "package", activation: "package#iter=1#attempt=1", port: "package" };

describe("value artifacts", () => {
  test("are checked against their type in the run's frozen plan", async () => {
    const { store } = await localWorld();
    const value = { branch: "main", headRef: "a".repeat(40), baseRef: null };
    const artifact = await store.putValue({
      runId: "run-1",
      type: "workspace@1",
      producer: { nodeId: "build", activation: "build#iter=1#attempt=1", port: "code" },
      value,
      workspace: { headRef: "a".repeat(40) },
    });
    expect(artifact.body).toEqual({ value });
    expect(await store.verify("run-1", artifact.id)).toEqual({ ok: true, artifact });
    await expectRefusal(
      store.putValue({ runId: "run-1", type: "workspace@1", producer, value: { branch: "main" } }),
      "invalid-artifact",
    );
    await expectRefusal(
      store.putValue({ runId: "run-1", type: "nope@1", producer, value: {} }),
      "invalid-artifact",
    );
    await expectRefusal(
      store.putValue({ runId: "run-1", type: "review-package@2", producer, value: {} }),
      "invalid-artifact",
    );
    await expectRefusal(
      store.putValue({ runId: "run-9", type: "workspace@1", producer, value }),
      "run-not-found",
    );
  });

  test("a value tampered with in the store fails verification", async () => {
    const { storage, store } = await localWorld();
    const artifact = await store.putValue({
      runId: "run-1",
      type: "text@1",
      producer: { nodeId: "build", activation: "build#iter=1#attempt=1", port: "report" },
      value: { text: "original" },
    });
    storageDatabase(storage).updateStoreRow("graph-artifacts", `run-1/${artifact.id}`, () => ({
      result: undefined,
      value: { ...artifact, body: { value: { text: "altered!" } } },
    }));
    expect(await store.verify("run-1", artifact.id)).toMatchObject({ ok: false, code: "identity" });
    await expect(store.requireVerified("run-1", artifact.id)).rejects.toMatchObject({
      code: "identity",
    });
    expect(await store.verify("run-1", "0".repeat(64))).toMatchObject({ code: "not-found" });
  });
});

describe("reference artifacts in a local worktree", () => {
  test("are sealed read-only under the run's directory, Git-excluded and verified", async () => {
    const { worktree, store } = await localWorld();
    const contents = Buffer.from("sealed package contents");
    const artifact = await store.putFile({
      runId: "run-1",
      type: "review-package@2",
      producer,
      contents,
      extension: "json",
    });
    const relative = `.orkestrator/graph-artifacts/run-1/${sha256(contents)}.json`;
    expect(artifact.body).toEqual({
      file: { path: relative, sha256: sha256(contents), bytes: contents.byteLength },
    });
    const file = path.join(worktree, relative);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o444);
    expect(await fs.readFile(file)).toEqual(contents);
    expect((await runCommand("git", ["-C", worktree, "status", "--porcelain"])).stdout).toBe("");
    expect(await store.verify("run-1", artifact.id)).toEqual({ ok: true, artifact });
    expect(await store.usage("run-1")).toMatchObject({
      artifacts: 1,
      diskBytes: contents.byteLength,
    });
  });

  test("a tampered, resized, missing or redirected file fails before any consumer", async () => {
    const { root, worktree, store } = await localWorld();
    const contents = Buffer.from("0123456789");
    const artifact = await store.putFile({
      runId: "run-1",
      type: "review-package@2",
      producer,
      contents,
    });
    const file = path.join(worktree, (artifact.body as { file: { path: string } }).file.path);
    await fs.chmod(file, 0o644);

    await fs.writeFile(file, "9876543210");
    expect(await store.verify("run-1", artifact.id)).toMatchObject({
      ok: false,
      code: "hash-mismatch",
    });
    await expect(store.requireVerified("run-1", artifact.id)).rejects.toMatchObject({
      code: "hash-mismatch",
    });

    await fs.writeFile(file, "0123456789+");
    expect(await store.verify("run-1", artifact.id)).toMatchObject({ code: "size-mismatch" });

    // Same bytes reached through a symbolic link to a file outside the worktree.
    const outside = path.join(root, "outside");
    await fs.writeFile(outside, contents);
    await fs.rm(file);
    await fs.symlink(outside, file);
    expect(await store.verify("run-1", artifact.id)).toMatchObject({ code: "not-confined" });

    await fs.rm(file);
    expect(await store.verify("run-1", artifact.id)).toMatchObject({ code: "missing" });
  });

  test("superseded artifacts are refused to consumers, still readable by the inspector", async () => {
    const { store } = await localWorld();
    const artifact = await store.putFile({
      runId: "run-1",
      type: "review-package@2",
      producer,
      contents: Buffer.from("x"),
    });
    expect(await store.supersede("run-1", [artifact.id], "rewind-1")).toBe(1);
    expect(await store.verify("run-1", artifact.id)).toMatchObject({ code: "superseded" });
    expect(await store.verify("run-1", artifact.id, { allowSuperseded: true })).toMatchObject({
      ok: true,
    });
  });

  test("a file over its type's budget writes nothing", async () => {
    const { worktree, store } = await localWorld();
    await expectRefusal(
      store.putFile({
        runId: "run-1",
        type: "review-package@2",
        producer,
        contents: Buffer.alloc(16 * 1024 * 1024 + 1),
      }),
      "reference-bytes",
    );
    await expect(fs.stat(path.join(worktree, ".orkestrator/graph-artifacts"))).rejects.toThrow();
  });
});

describe("reference artifacts in a container", () => {
  /**
   * A container stand-in: `/workspace` is a host directory, the pinned
   * writer and remover run as they would inside the container, and the
   * runner answers `realpath`, `stat -c %s` and `sha256sum` for container
   * paths. Every command and path the backend issues is recorded.
   */
  async function containerWorld() {
    const root = await temporary("orkestrator-graph-container-");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    const storage = new StorageService(path.join(root, "data"));
    await storage.init();
    services.push(storage);
    await storage.addEnvironment(
      graphEnvironmentFixture({ environmentType: "containerized", containerId: "container-1" }),
    );
    await storage.graphRuns.createGraphRun(graphRunFixture());
    const commands: string[][] = [];
    const host = (target: string) => {
      if (!target.startsWith("/workspace/")) throw new Error(`outside /workspace: ${target}`);
      return path.join(workspace, target.slice("/workspace/".length));
    };
    const runner: EnvironmentCommandRunner = async (command, args) => {
      commands.push([command, ...args]);
      const target = args.at(-1)!;
      switch (command) {
        case "bash":
        case "git":
          return "";
        case "realpath": {
          const resolved = await fs.realpath(host(target));
          return `${resolved === path.resolve(host(target)) ? target : resolved}\n`;
        }
        case "stat":
          return `${(await fs.stat(host(target))).size}\n`;
        case "sha256sum":
          return `${sha256(await fs.readFile(host(target)))}  ${target}\n`;
        case "node": {
          const [, script, , directory] = args;
          const result = spawnSync(process.execPath, ["-e", script!, workspace, directory!]);
          if (result.status !== 0) throw new Error("remove failed");
          return "";
        }
        default:
          throw new Error(`unexpected command ${command}`);
      }
    };
    const spawned: string[][] = [];
    const spawnInContainer = ((command: string, args: string[]) => {
      spawned.push([command, ...args]);
      // `docker exec -i <container> node -e <writer> /workspace <dir> …`
      const [, , container, node, flag, script, workspaceRoot, ...rest] = args;
      expect([command, container, node, flag, workspaceRoot]).toEqual([
        "docker",
        "container-1",
        "node",
        "-e",
        "/workspace",
      ]);
      expect(script).toBe(CONTAINER_PINNED_ATTACHMENT_WRITE);
      return spawn(process.execPath, ["-e", script!, workspace, ...rest], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    }) as never;
    const store = new GraphArtifactStore({
      storage,
      fence,
      createRunner: () => runner,
      spawn: spawnInContainer,
    });
    return { workspace, storage, store, commands, spawned, runner };
  }

  test("writes with the pinned in-container writer and verifies with sha256sum inside it", async () => {
    const { workspace, store, commands, spawned } = await containerWorld();
    const contents = Buffer.from('{"package":true}');
    const artifact = await store.putFile({
      runId: "run-1",
      type: "review-package@2",
      producer,
      contents,
      extension: "json",
    });
    const relative = `.orkestrator/graph-artifacts/run-1/${sha256(contents)}.json`;
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toContain(".orkestrator/graph-artifacts/run-1");
    expect(await fs.readFile(path.join(workspace, relative))).toEqual(contents);
    commands.length = 0;
    expect(await store.verify("run-1", artifact.id)).toEqual({ ok: true, artifact });
    // Hashed at the source: no read of the file's content crosses the boundary.
    expect(commands).toEqual([
      ["realpath", "--", `/workspace/${relative}`],
      ["stat", "-c", "%s", "--", `/workspace/${relative}`],
      ["sha256sum", "--", `/workspace/${relative}`],
    ]);

    const file = path.join(workspace, relative);
    await fs.chmod(file, 0o644);
    await fs.writeFile(file, '{"package":1234}');
    expect(await store.verify("run-1", artifact.id)).toMatchObject({
      ok: false,
      code: "hash-mismatch",
    });
  });

  test("a redirected file in the container is not confined", async () => {
    const { workspace, store } = await containerWorld();
    const contents = Buffer.from("payload");
    const artifact = await store.putFile({
      runId: "run-1",
      type: "review-package@2",
      producer,
      contents,
    });
    const file = path.join(workspace, (artifact.body as { file: { path: string } }).file.path);
    const elsewhere = path.join(workspace, "elsewhere");
    await fs.writeFile(elsewhere, contents);
    await fs.rm(file, { force: true });
    await fs.symlink(elsewhere, file);
    expect(await store.verify("run-1", artifact.id)).toMatchObject({ code: "not-confined" });
  });

  test("environment cleanup removes the run directories inside the container", async () => {
    const { workspace, storage, store, runner, commands } = await containerWorld();
    await store.putFile({
      runId: "run-1",
      type: "review-package@2",
      producer,
      contents: Buffer.from("x"),
    });
    const environment = (await storage.getEnvironment("e1"))!;
    commands.length = 0;
    expect(
      await removeEnvironmentGraphArtifactFiles(environment, {
        storage,
        fence,
        createRunner: () => runner,
      }),
    ).toEqual({ removed: 1, failed: 0 });
    expect(commands).toEqual([
      [
        "node",
        "-e",
        CONTAINER_PINNED_ATTACHMENT_REMOVE,
        "/workspace",
        ".orkestrator/graph-artifacts/run-1",
      ],
    ]);
    await expect(
      fs.stat(path.join(workspace, ".orkestrator/graph-artifacts/run-1")),
    ).rejects.toThrow();
  });
});

describe("environment deletion", () => {
  test("removes the runs' artifact files, records and artifact rows", async () => {
    const root = await temporary("orkestrator-graph-delete-");
    // Outside the backend's worktree root, so the deletion keeps the worktree
    // (as it keeps a project home's): only the graph step can remove the files.
    const worktree = path.join(root, "kept-worktree");
    await fs.mkdir(worktree);
    await runCommand("git", ["init", "-q", "-b", "main", worktree]);
    await fs.writeFile(path.join(worktree, "keep.txt"), "user file");
    const storage = new StorageService(path.join(root, "data"));
    await storage.init();
    services.push(storage);
    await storage.addEnvironment(
      graphEnvironmentFixture({ worktreePath: worktree, status: "stopped" }),
    );
    await storage.addEnvironment(
      graphEnvironmentFixture({ id: "e2", worktreePath: worktree, order: 1 }),
    );
    await storage.graphRuns.createGraphRun(graphRunFixture());
    await storage.graphRuns.createGraphRun(graphRunFixture({ id: "run-2", environmentId: "e2" }));
    const store = new GraphArtifactStore({ storage, fence });
    const artifact = await store.putFile({
      runId: "run-1",
      type: "review-package@2",
      producer,
      contents: Buffer.from("package"),
    });
    await store.putValue({
      runId: "run-1",
      type: "text@1",
      producer: { nodeId: "build", activation: "build#iter=1#attempt=1", port: "report" },
      value: { text: "report" },
    });
    const other = await store.putFile({
      runId: "run-2",
      type: "review-package@2",
      producer,
      contents: Buffer.from("other run"),
    });
    const runDirectory = path.join(worktree, ".orkestrator/graph-artifacts/run-1");
    expect((await fs.readdir(runDirectory)).length).toBe(1);

    const context = {
      storage,
      appRoot: "",
      resourceRoot: "",
      toolchainBinDir: "",
      worktreeDir: path.join(root, "workspaces"),
      environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
      runtime: new BackendRuntime({ emit: () => undefined }),
      emit: () => undefined,
    } as CommandContext;
    await createCommandRegistry().get("delete_environment")!({ environmentId: "e1" }, context);

    expect(await storage.getEnvironment("e1")).toBeNull();
    await expect(fs.stat(runDirectory)).rejects.toThrow();
    expect(await fs.readFile(path.join(worktree, "keep.txt"), "utf8")).toBe("user file");
    expect(await storage.graphRuns.getGraphRun("run-1")).toBeNull();
    expect(await storage.graphRuns.listGraphArtifacts("run-1")).toEqual([]);
    expect(await storage.graphRuns.getGraphArtifact("run-1", artifact.id)).toBeNull();
    // Another environment's run and its files are untouched.
    expect(await storage.graphRuns.getGraphRun("run-2")).not.toBeNull();
    expect(await store.verify("run-2", other.id)).toMatchObject({ ok: true });
  });
});
