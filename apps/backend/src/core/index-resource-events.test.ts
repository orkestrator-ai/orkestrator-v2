import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RESOURCE_CHANGED_EVENT } from "@orkestrator/protocol/resource-events";
import { OrkestratorBackend } from "./index.js";

describe("OrkestratorBackend resource event wiring", () => {
  test("forwards committed prompt and build mutations through the backend emitter", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-backend-events-"));
    const events: Array<{ event: string; payload: unknown }> = [];
    await fs.writeFile(
      path.join(dataDir, "environments.json"),
      `${JSON.stringify(
        [
          {
            id: "e1",
            projectId: "p1",
            name: "Environment",
            branch: "main",
            containerId: null,
            status: "running",
            prUrl: null,
            prState: null,
            hasMergeConflicts: null,
            createdAt: new Date(0).toISOString(),
            networkAccessMode: "restricted",
            order: 0,
            environmentType: "local",
          },
        ],
        null,
        2,
      )}\n`,
    );

    const backend = new OrkestratorBackend({
      dataDir,
      toolchainBinDir: "",
      appRoot: "",
      resourceRoot: "",
      emit: (event, payload) => events.push({ event, payload }),
    });

    try {
      await backend.init();
      const pipeline = await backend.invoke<{ id: string }>("start_build_pipeline", {
        taskId: "task-1",
        projectId: "p1",
        existingEnvironmentId: "e1",
        environmentType: "local",
        agentType: "codex",
        taskTitle: "Backend-owned pipeline",
        taskSnapshot: {
          title: "Backend-owned pipeline",
          description: "",
          acceptanceCriteria: "",
          comments: [],
          images: [],
        },
      });
      await backend.invoke("enqueue_prompt_queue_message", {
        queueKey: "claude env-e1:tab-1",
        environmentId: "e1",
        message: { id: "m1", text: "queued", attachments: [] },
      });
      const claim = await backend.invoke<{ claimToken: string }>("claim_prompt_queue_head", {
        queueKey: "claude env-e1:tab-1",
        environmentId: "e1",
        expectedMessageId: "m1",
      });
      await backend.invoke("reject_prompt_queue_claim", {
        queueKey: "claude env-e1:tab-1",
        environmentId: "e1",
        claimToken: claim.claimToken,
      });
      await backend.invoke("transfer_prompt_queue_message_to_compose_draft", {
        queueKey: "claude env-e1:tab-1",
        environmentId: "e1",
        messageId: "m1",
        draftKey: "compose:e1:tab-1",
        ownerType: "environment",
        ownerId: "e1",
      });
      await backend.invoke("enqueue_prompt_queue_message", {
        queueKey: "claude env-e1:tab-1",
        environmentId: "e1",
        message: { id: "m2" },
      });
      const acknowledged = await backend.invoke<{ claimToken: string }>("claim_prompt_queue_head", {
        queueKey: "claude env-e1:tab-1",
        environmentId: "e1",
        expectedMessageId: "m2",
      });
      await backend.invoke("acknowledge_prompt_queue_claim", {
        queueKey: "claude env-e1:tab-1",
        environmentId: "e1",
        claimToken: acknowledged.claimToken,
      });

      expect(events).toContainEqual({
        event: RESOURCE_CHANGED_EVENT,
        payload: expect.objectContaining({
          resource: "build-pipeline",
          id: pipeline.id,
        }),
      });
      expect(events).toContainEqual({
        event: RESOURCE_CHANGED_EVENT,
        payload: expect.objectContaining({
          resource: "compose-draft",
          id: "e1",
        }),
      });
      expect(
        events.filter(
          ({ payload }) =>
            typeof payload === "object" &&
            payload !== null &&
            (payload as { resource?: string }).resource === "prompt-queue",
        ),
      ).toHaveLength(7);
      expect(events).toContainEqual({
        event: RESOURCE_CHANGED_EVENT,
        payload: expect.objectContaining({
          resource: "prompt-queue",
          id: "e1",
        }),
      });
    } finally {
      await backend.shutdown().catch(() => undefined);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("OrkestratorBackend startup resilience", () => {
  /**
   * A pipeline record whose environment carries a deletion tombstone cannot be
   * adopted: saving it is rejected on purpose. That state is a normal
   * consequence of the app dying part-way through deleting an environment, and
   * it must not stop the backend booting — `main.ts` has no handler around
   * `init()`, so a rejection there means no gateway and no application at all.
   */
  test("boots even when a persisted pipeline can never be restored", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-backend-init-"));
    await fs.writeFile(
      path.join(dataDir, "environments.json"),
      `${JSON.stringify(
        [
          {
            id: "e-doomed",
            projectId: "p1",
            name: "Environment",
            branch: "main",
            containerId: null,
            status: "running",
            prUrl: null,
            prState: null,
            hasMergeConflicts: null,
            createdAt: new Date(0).toISOString(),
            networkAccessMode: "restricted",
            order: 0,
            environmentType: "local",
            deletionRequestedAt: new Date(0).toISOString(),
          },
        ],
        null,
        2,
      )}\n`,
    );
    // Written the way the previous release's renderer wrote it: no `controller`
    // marker, so startup tries to adopt it and the save is refused.
    await fs.writeFile(
      path.join(dataDir, "build-pipelines.json"),
      `${JSON.stringify(
        {
          "pipeline-doomed": {
            version: 2,
            id: "pipeline-doomed",
            projectId: "p1",
            environmentId: "e-doomed",
            revision: 1,
            updatedAt: new Date(0).toISOString(),
            snapshot: {
              id: "pipeline-doomed",
              taskId: "task-1",
              projectId: "p1",
              environmentId: "e-doomed",
              environmentType: "local",
              agentType: "codex",
              phase: "building",
              sessions: [],
              currentSessionIndex: -1,
              iteration: 0,
              maxIterations: 3,
              createdAt: new Date(0).toISOString(),
              taskTitle: "Legacy pipeline",
              taskSnapshot: {
                title: "Legacy pipeline",
                description: "",
                acceptanceCriteria: "",
                comments: [],
                images: [],
              },
              backendRevision: 1,
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const backend = new OrkestratorBackend({
      dataDir,
      toolchainBinDir: "",
      appRoot: "",
      resourceRoot: "",
      emit: () => {},
    });

    try {
      await expect(backend.init()).resolves.toBeUndefined();
      // The gateway is reachable, which is the whole point of surviving.
      await expect(
        backend.invoke("list_build_pipelines", { projectId: "p1" }),
      ).resolves.toBeInstanceOf(Array);
    } finally {
      await backend.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("shuts down local servers even when draining pipelines fails", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-backend-shutdown-"));
    const backend = new OrkestratorBackend({
      dataDir,
      toolchainBinDir: "",
      appRoot: "",
      resourceRoot: "",
      emit: () => {},
    });

    try {
      await backend.init();
      // Skipping the local-server teardown leaves every backend-owned bridge
      // process running as an orphan, so a failed drain must not reach it.
      const supervisor = (
        backend as unknown as {
          buildPipelines: { shutdown: () => Promise<void> };
        }
      ).buildPipelines;
      supervisor.shutdown = async () => {
        throw new Error("drain failed");
      };

      await expect(backend.shutdown()).resolves.toBeUndefined();
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
