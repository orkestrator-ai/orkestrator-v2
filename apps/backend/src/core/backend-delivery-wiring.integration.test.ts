import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { BUILD_PIPELINE_VERSION } from "@orkestrator/protocol/build-pipeline";
import { OrkestratorBackend } from "./index.js";
import type { CommandContext } from "./commands-context.js";
import type { BuildPipelineService } from "./build-pipeline-service.js";
import type { BuildPipelineServiceOptions } from "./build-pipeline-context.js";
import type { Environment } from "./models.js";

// The production constructor supplies both hooks. Only Git uses a subprocess;
// there are no bridges, remote services, or live agents in this qualification.
test("production delivery listener and origin probe use the real ticket and environment", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ork-delivery-wiring-"));
  const backend = new OrkestratorBackend({
    dataDir: path.join(root, "data"),
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    transcriptArtifactRuntime: false,
  });
  const owner = backend as unknown as {
    context: CommandContext;
    buildPipelines: {
      noteTicketDeliveryChange: BuildPipelineService["noteTicketDeliveryChange"];
      options: BuildPipelineServiceOptions;
    };
  };
  const storage = owner.context.storage;
  const pending: Promise<void>[] = [];
  const note = owner.buildPipelines.noteTicketDeliveryChange.bind(owner.buildPipelines);
  const listener = spyOn(owner.buildPipelines, "noteTicketDeliveryChange").mockImplementation(
    (...args) => {
      const result = note(...args);
      pending.push(result);
      return result;
    },
  );
  try {
    await storage.init();
    const ticket = await storage.kanban.addKanbanTask("project-1", "Delivery", "Body");
    const run: BuildPipeline = {
      id: "delivery-run",
      taskId: ticket.id,
      projectId: "project-1",
      environmentId: "delivery-env",
      environmentType: "local",
      agentType: "claude",
      phase: "creating-pr",
      sessions: [],
      currentSessionIndex: -1,
      iteration: 0,
      maxIterations: 3,
      createdAt: "2026-11-02T00:00:00Z",
      taskTitle: ticket.title,
      taskSnapshot: {
        title: ticket.title,
        description: ticket.description,
        acceptanceCriteria: "",
        comments: [],
        images: [],
      },
      source: { type: "kanban", taskId: ticket.id },
      delivery: { policy: "open-pr", decidedAt: "2026-11-02T00:00:01Z" },
      deliveryPolicy: "open-pr",
      backendRevision: 1,
      controller: "backend",
    };
    await storage.addEnvironment({
      id: run.environmentId,
      projectId: run.projectId,
      name: "Delivery",
      environmentType: "local",
      branch: "build",
      worktreePath: path.join(root, "local"),
      status: "running",
      createdAt: "2026-11-02T00:00:00Z",
    } as Environment);
    await storage.saveBuildPipeline(
      run.id,
      run.projectId,
      run.environmentId,
      BUILD_PIPELINE_VERSION,
      run,
      0,
    );
    await storage.kanban.updateKanbanTask(ticket.id, { buildPipelineId: run.id });
    await storage.kanban.updateKanbanTask(ticket.id, {
      sections: { delivery: { policy: "commit-only" } },
    });
    await Promise.all(pending);
    expect(listener).toHaveBeenCalledWith(ticket.id, "project-1", "commit-only");
    expect((await storage.getBuildPipeline(run.id))?.snapshot).toMatchObject({
      deliveryPolicy: "commit-only",
      delivery: { policy: "open-pr" },
    });
    expect(
      (await storage.kanban.getKanbanTask(ticket.id))?.comments.some((comment) =>
        comment.text.includes("Too late for this build"),
      ),
    ).toBe(true);

    const local = path.join(root, "local");
    const remote = path.join(root, "remote.git");
    async function git(args: string[], cwd = root): Promise<string> {
      const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      const [output, error, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      if (code !== 0) throw new Error(`Fixture Git failed: ${error}`);
      return output.trim();
    }
    await git(["init", "--bare", remote]);
    await git(["init", "-b", "build", local]);
    await git(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ],
      local,
    );
    await git(["remote", "add", "origin", remote], local);
    const probe = owner.buildPipelines.options.branchPushState!;
    expect((await probe(run.environmentId)).remoteHead).toBeNull();
    await git(["push", "origin", "build"], local);
    const head = await git(["rev-parse", "HEAD"], local);
    expect(await probe(run.environmentId)).toEqual({ branch: "build", head, remoteHead: head });
  } finally {
    await Promise.allSettled(pending);
    listener.mockRestore();
    await backend.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
