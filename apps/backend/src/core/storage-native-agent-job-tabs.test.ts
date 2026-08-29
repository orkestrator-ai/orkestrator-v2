import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
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
        isReviewTab: true,
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
            isReviewTab: true,
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

      await storage.savePaneLayout(
        "env-1",
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "pane-right",
          root: {
            kind: "split",
            id: "split",
            direction: "horizontal",
            sizes: [50, 50],
            children: [
              {
                kind: "leaf",
                id: "pane-left",
                tabs: [
                  {
                    id: "agent-job-stable",
                    type: "agent-native",
                    isReviewTab: true,
                    nativeAgentData: {
                      platform: "codex",
                      environmentId: "env-1",
                      isLocal: true,
                      sessionId: "provider-session-1",
                    },
                  },
                ],
                activeTabId: "agent-job-stable",
              },
              {
                kind: "leaf",
                id: "pane-right",
                tabs: [{ id: "terminal-active", type: "terminal" }],
                activeTabId: "terminal-active",
              },
            ],
          },
        },
        second.revision,
      );

      const retried = await storage.ensureNativeAgentJobTab({
        environmentId: "env-1",
        tabId: "agent-job-stable",
        agent: "codex",
        providerSessionId: "provider-session-1",
        activate: true,
      });
      expect(retried).toMatchObject({
        activePaneId: "pane-right",
        root: {
          kind: "split",
          children: [
            { kind: "leaf", activeTabId: "agent-job-stable" },
            { kind: "leaf", activeTabId: "terminal-active" },
          ],
        },
      });

      const activated = await storage.ensureNativeAgentJobTab({
        environmentId: "env-1",
        tabId: "agent-job-active",
        agent: "claude",
        title: "Active job",
        activate: true,
      });
      expect(activated).toMatchObject({
        activePaneId: "pane-right",
        root: {
          kind: "split",
          children: [
            { kind: "leaf", activeTabId: "agent-job-stable" },
            { kind: "leaf", activeTabId: "agent-job-active" },
          ],
        },
      });

      const background = await storage.ensureNativeAgentJobTab({
        environmentId: "env-1",
        tabId: "agent-job-background",
        agent: "codex",
      });
      expect(background).toMatchObject({
        activePaneId: "pane-right",
        root: {
          kind: "split",
          children: [
            { kind: "leaf", activeTabId: "agent-job-stable" },
            { kind: "leaf", activeTabId: "agent-job-active" },
          ],
        },
      });

      await storage.ensureNativeAgentJobTab({
        environmentId: "env-1",
        tabId: "multi-review-fix:multi-1:launch-1",
        agent: "claude",
        isReviewTab: true,
      });
      expect(await storage.removeMultiReviewTabs("env-1", "multi-1")).toEqual([
        "multi-review-fix:multi-1:launch-1",
      ]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
