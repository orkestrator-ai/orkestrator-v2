import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { StorageService } from "./storage.js";

export async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-agent-mail-service-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addProject({
    id: "project",
    name: "Project",
    gitUrl: "https://example.invalid/project.git",
    localPath: null,
    addedAt: new Date(0).toISOString(),
    order: 0,
  });
  for (const environmentId of ["sender", "recipient"]) {
    await storage.addEnvironment({
      id: environmentId,
      projectId: "project",
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
              nativeAgentData: { environmentId, platform: "claude" },
            },
          ],
          activeTabId: "agent",
        },
      },
      0,
    );
  }
  const config = await storage.loadConfig();
  config.global.agentMessaging = {
    ...config.global.agentMessaging!,
    defaultInjectPolicy: "idle",
  };
  await storage.saveConfig(config);
  await storage.synchronizeAgentMailboxes();
  return { storage, dataDir };
}

export async function replaceRecipientTab(
  storage: StorageService,
  type: "agent-native" | "claude-tmux",
) {
  const layout = await storage.getPaneLayout("recipient");
  if (!layout) throw new Error("recipient layout missing");
  await storage.savePaneLayout(
    "recipient",
    {
      ...layout,
      root: {
        kind: "leaf",
        id: "pane",
        tabs: [
          type === "agent-native"
            ? {
                id: "agent",
                type,
                nativeAgentData: { environmentId: "recipient", platform: "claude" },
              }
            : { id: "agent", type },
        ],
        activeTabId: "agent",
      },
    },
    layout.revision,
  );
  await storage.synchronizeAgentMailboxes();
}
