/**
 * The registered `create_debug_build` handler, wired as the backend runs it:
 * the source tabs come from the environment's stored pane layout and each
 * tab's transcript through the public CLI's session reader on the registry's
 * own commands. Only the build supervisor is faked.
 */
import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StartBuildPipelineInput } from "@orkestrator/protocol/build-pipeline";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { createCommandRegistry, type CommandContext } from "./commands.js";
import { FeatureBuildTasks } from "./features/build-tasks.js";
import type { Environment, Project } from "./models.js";
import { StorageService } from "./storage.js";

describe("create_debug_build registration", () => {
  test("reads the source tabs from the stored layout and their transcripts through the session reader", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-debug-registry-"));
    const storage = new StorageService(dataDir);
    try {
      await storage.init();
      await storage.addProject({
        id: "project-1",
        name: "acme",
        gitUrl: "https://example.invalid/acme.git",
        localPath: "/tmp/acme",
        addedAt: new Date(0).toISOString(),
        order: 0,
      } as Project);
      await storage.addEnvironment({
        id: "env-source",
        projectId: "project-1",
        name: "settings-dialog",
        branch: "settings-dialog",
        containerId: null,
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: "2026-11-14T09:00:00.000Z",
        networkAccessMode: "restricted",
        order: 0,
        environmentType: "local",
        worktreePath: "/tmp/acme-worktrees/settings-dialog",
      } as unknown as Environment);
      await storage.savePaneLayout(
        "env-source",
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "default",
          root: {
            kind: "leaf",
            id: "default",
            activeTabId: "tab-front",
            tabs: [
              {
                id: "tab-front",
                type: "agent-native",
                displayTitle: "Main",
                nativeAgentData: { platform: "claude" },
              },
              { id: "tab-shell", type: "terminal" },
            ],
          },
        } as never,
        0,
      );
      const started: StartBuildPipelineInput[] = [];
      const context = {
        storage,
        runtime: { featureBuilds: new FeatureBuildTasks() },
        buildPipelines: {
          async start(input: StartBuildPipelineInput) {
            started.push(input);
            return { id: "pipeline-1", environmentId: "" };
          },
        },
      } as unknown as CommandContext;

      const handler = createCommandRegistry().get("create_debug_build")!;
      const result = (await handler(
        { environmentId: "env-source", problem: "Settings do not open", requestId: "reg-1" },
        context,
      )) as { taskId: string; pipelineId: string };

      expect(result.pipelineId).toBe("pipeline-1");
      expect(started).toHaveLength(1);
      const task = await storage.kanban.getKanbanTask(result.taskId);
      // The agent tab from the layout, in front; the terminal is not an agent tab.
      expect(task?.description).toContain('"Main" (claude, tab `tab-front`), in front');
      expect(task?.description).not.toContain("tab-shell");
      // The tab has no stored session, which the session reader reports as empty.
      expect(task?.description).toContain("no conversation yet");
      expect(task?.comments).toEqual([]);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
