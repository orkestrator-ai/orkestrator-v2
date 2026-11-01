import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackendRuntime } from "../backend-runtime.js";
import { createCommandRegistry } from "../commands-registry.js";
import type { CommandContext } from "../commands-context.js";
import { forkEnvironmentRecord } from "../commands-environment-fork.js";
import { createEnvironment, createProject, StorageService } from "../storage.js";
import { runCommand } from "../shell.js";
import { NodeReadModel } from "./node-read-model.js";
import { TestNodeNetwork, settle } from "./node-network-test-support.js";

test("real node summaries match live pipeline membership through forks and pipeline deletion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ork-node-markers-"));
  const storage = new StorageService(path.join(root, "data"));
  const runtime = new BackendRuntime({ emit: () => undefined });
  const network = new TestNodeNetwork();
  let model: NodeReadModel | undefined;
  try {
    await storage.init();
    const git = (args: string[]) => runCommand("git", ["-C", root, ...args]);
    await git(["init"]);
    await git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ]);
    const commit = (await git(["rev-parse", "HEAD"])).stdout.trim();
    const project = await storage.addProject({ ...createProject(""), localPath: root });
    const source = await storage.addEnvironment({
      ...createEnvironment(project.id, { name: "Build: feature", environmentType: "local" }),
      buildPipelineId: "pipeline-1",
      autoMerge: true,
    });
    const context = { storage, runtime, emit: () => undefined } as unknown as CommandContext;
    const fork = await forkEnvironmentRecord(source, "local", context, {
      base: { branch: source.branch, commit },
    });
    expect(fork.buildPipelineId).toBe("pipeline-1");
    const stale = await storage.addEnvironment({
      ...createEnvironment(project.id, { name: "Build: stale", environmentType: "local" }),
      buildPipelineId: "missing-pipeline",
    });
    await storage.saveBuildPipeline("pipeline-1", project.id, source.id, 1, {});
    const command = await network.add("command", { forceRegistration: true });
    const leaf = await network.add("leaf");
    const registry = createCommandRegistry();
    const invoke = async <T>(name: string, args?: Record<string, unknown>) =>
      (await registry.get(name)!(args ?? {}, context)) as T;
    for (const name of ["get_projects", "get_environment_snapshots"]) {
      leaf.commands.set(name, (args) => invoke(name, args));
    }
    await command.service.addNode({
      routes: [{ id: "primary" as never, kind: "https", enabled: true, origin: leaf.origin }],
      token: leaf.token,
    });
    model = new NodeReadModel({
      nodes: command.service,
      local: { invoke },
      emit: () => undefined,
      fetchImpl: network.fetch,
      refreshDebounceMs: 0,
    });
    storage.setResourceChangeListener((change) => {
      model!.noteLocalEvent("resource-changed", change);
      leaf.emit("resource-changed", change);
    });
    await model.start();
    await settle(40);
    const summaries = await model.summaries(undefined, { includeSelf: true });
    for (const rows of [summaries.self!.environments, summaries.nodes[0]!.environments]) {
      expect(rows.find((row) => row.ref.environmentId === source.id)).toMatchObject({
        buildPipeline: true,
        autoMerge: true,
      });
      for (const id of [fork.id, stale.id]) {
        const row = rows.find((row) => row.ref.environmentId === id)!;
        expect(row).toBeDefined();
        expect(row.buildPipeline).toBeUndefined();
        expect(row.autoMerge).toBeUndefined();
      }
    }
    // No environment write accompanies pipeline deletion. Its own event must
    // refresh remote summaries and invalidate the cached self summary.
    await storage.deleteBuildPipeline("pipeline-1");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await settle(5);
      const rows = (await model.summaries()).nodes[0]!.environments;
      if (!rows.find((row) => row.ref.environmentId === source.id)?.buildPipeline) break;
    }
    const after = await model.summaries(undefined, { includeSelf: true });
    for (const rows of [after.self!.environments, after.nodes[0]!.environments]) {
      const row = rows.find((entry) => entry.ref.environmentId === source.id)!;
      expect(row.buildPipeline).toBeUndefined();
      expect(row.autoMerge).toBe(true);
    }
    expect((await storage.getEnvironment(source.id))!.buildPipelineId).toBe("pipeline-1");
    // A new pipeline can name an environment whose persisted link differs.
    await storage.saveBuildPipeline("pipeline-2", project.id, stale.id, 1, {});
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await settle(5);
      const rows = (await model.summaries()).nodes[0]!.environments;
      if (rows.find((row) => row.ref.environmentId === stale.id)?.buildPipeline) break;
    }
    const created = await model.summaries(undefined, { includeSelf: true });
    for (const rows of [created.self!.environments, created.nodes[0]!.environments]) {
      const row = rows.find((entry) => entry.ref.environmentId === stale.id)!;
      expect(row.buildPipeline).toBe(true);
      expect(row.autoMerge).toBeUndefined();
    }
  } finally {
    model?.stop();
    runtime.shutdown();
    await network.stop();
    storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
