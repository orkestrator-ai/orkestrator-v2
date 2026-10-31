import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { StorageService } from "./storage.js";

/** The persisted agent-mail store, as far as these tests edit it. */
export type StoredMail = {
  mailboxes: Record<string, { messages: Array<{ createdAt: string; wakeAdmittedAt?: string }> }>;
  counterparts?: Record<string, { createdAt: string }>;
};

export async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-agent-mail-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  for (const projectId of ["p1", "p2"]) {
    await storage.addProject({
      id: projectId,
      name: projectId,
      gitUrl: `https://example.invalid/${projectId}.git`,
      localPath: null,
      addedAt: new Date(0).toISOString(),
      order: 0,
    });
  }
  for (const [environmentId, projectId] of [
    ["e1", "p1"],
    ["e2", "p1"],
    ["e3", "p2"],
  ] as const) {
    await storage.addEnvironment({
      id: environmentId,
      projectId,
      name: environmentId,
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
      setupPhase: "ready",
      setupScriptsComplete: true,
    });
    await storage.savePaneLayout(
      environmentId,
      {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "pane",
        root: {
          kind: "leaf",
          id: "pane",
          tabs: [
            {
              id: "agent",
              type: "agent-native",
              displayTitle: `${environmentId} agent`,
              nativeAgentData: { environmentId, platform: "claude" },
            },
          ],
          activeTabId: "agent",
        },
      },
      0,
    );
  }
  await storage.synchronizeAgentMailboxes();
  return { storage, dataDir };
}
