import { randomUUID } from "node:crypto";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { expect, test } from "./browser-test";
import { invoke, login, reloadApp } from "./container-wiring-support";

// No provider turns: import a failed snapshot with a durable reset intent.
// This covers the renderer wrapper and real gateway command, not a Delete UI
// control (there is currently no caller of deleteBuildPipeline in the UI).
test.use({ trace: "off", screenshot: "off", video: "off" });

test("renderer deletion wrapper removes a pending code rewind through the real gateway", async ({
  page,
}, testInfo) => {
  const projects = await invoke<Array<{ id: string }>>("get_projects");
  expect(projects).toHaveLength(1);
  const projectId = projects[0]!.id;
  const id = `delete-rewind-${randomUUID()}`;
  const at = new Date().toISOString();
  const snapshot: BuildPipeline = {
    id,
    projectId,
    taskId: id,
    environmentId: "",
    environmentType: "local",
    agentType: "codex",
    phase: "failed",
    error: "Pending reset fixture",
    sessions: [],
    currentSessionIndex: -1,
    iteration: 0,
    maxIterations: 1,
    createdAt: at,
    taskTitle: "Pending reset deletion",
    controller: "backend",
    backendRevision: 0,
    taskSnapshot: {
      title: "Pending reset deletion",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    rewinds: [
      {
        id: "rewind",
        at,
        fromPhase: "complete",
        fromIteration: 0,
        iteration: 0,
        step: { kind: "session", phase: "build" },
        supersededSessions: 0,
        code: {
          pending: true,
          from: "a".repeat(40),
          to: "b".repeat(40),
          droppedCommits: 1,
          backupRef: `refs/orkestrator/${id}/rewind`,
        },
      },
    ],
  };
  try {
    expect(
      await invoke("import_legacy_build_pipelines", { projectId, snapshots: [snapshot] }),
    ).toEqual({ importedIds: [id], skipped: 0 });
    await login(page, testInfo);
    const list = () =>
      invoke<Array<{ id: string; snapshot: BuildPipeline }>>("list_build_pipelines", { projectId });
    expect((await list()).find((p) => p.id === id)?.snapshot.rewinds?.[0]?.code?.pending).toBe(
      true,
    );
    // Load the production module via Vite, inside the authenticated renderer.
    // No fetch interception or mocked backend: wrong command wiring fails here.
    await page.evaluate(async (pipelineId) => {
      const modulePath = "/src/lib/backend/workflows.ts";
      const { deleteBuildPipeline } = await import(/* @vite-ignore */ modulePath);
      await deleteBuildPipeline(pipelineId);
    }, id);
    expect((await list()).some((p) => p.id === id)).toBe(false);
    await reloadApp(page, testInfo);
    expect((await list()).some((p) => p.id === id)).toBe(false);
    expect(await invoke("get_build_pipeline", { pipelineId: id })).toBeNull();
  } finally {
    await invoke("delete_build_pipeline", { pipelineId: id });
  }
});
