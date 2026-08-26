import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";

describe("StorageService control job tabs", () => {
  test("retries converge on one durable tab and bind the provider session", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ork-control-job-tab-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    await storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
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
      worktreePath: dataDir,
    });

    try {
      const first = await storage.ensureNativeAgentJobTab({
        environmentId: "env-1",
        tabId: "agent-job-stable",
        agent: "codex",
        title: "Independent job",
      });
      const second = await storage.ensureNativeAgentJobTab({
        environmentId: "env-1",
        tabId: "agent-job-stable",
        agent: "codex",
        providerSessionId: "provider-session-1",
        title: "Independent job",
      });

      expect(second.revision).toBe(first.revision + 1);
      expect(second.root).toMatchObject({
        kind: "leaf",
        tabs: [
          {
            id: "agent-job-stable",
            type: "agent-native",
            displayTitle: "Independent job",
            nativeAgentData: {
              platform: "codex",
              environmentId: "env-1",
              isLocal: true,
              sessionId: "provider-session-1",
            },
          },
        ],
      });
      const root = JSON.parse(JSON.stringify(second.root)) as {
        tabs: Array<{ id: string }>;
      };
      expect(root.tabs.filter(({ id }) => id === "agent-job-stable")).toHaveLength(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
