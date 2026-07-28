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
      `${JSON.stringify([{
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
      }], null, 2)}\n`,
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
      await backend.invoke("save_build_pipeline", {
        pipelineId: "pipeline-1",
        projectId: "p1",
        environmentId: "",
        version: 1,
        snapshot: { id: "pipeline-1" },
      });
      await backend.invoke("save_prompt_queue", {
        queueKey: "claude env-e1:tab-1",
        environmentId: "e1",
        messages: [{ id: "m1" }],
      });

      expect(events).toContainEqual({
        event: RESOURCE_CHANGED_EVENT,
        payload: expect.objectContaining({
          resource: "build-pipeline",
          id: "pipeline-1",
        }),
      });
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
