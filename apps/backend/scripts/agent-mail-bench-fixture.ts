import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { StorageService } from "../src/core/storage.js";

/** Reads a non-negative numeric `--name value` option from the command line. */
export function benchOption(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : Number(process.argv[index + 1]);
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export interface AgentMailBenchFixture {
  dataDir: string;
  storage: StorageService;
  environments: number;
  tabs: number;
  /** Restores the console and removes the data directory. */
  dispose(): Promise<void>;
}

/**
 * A synthetic data directory in the system temporary directory: one project,
 * `environments` local environments with `tabs` native agent tabs each, and
 * `messages` mails of 1.8 KB spread across the mailboxes. The defaults of the
 * agent mail benches (100 × 6 tabs, 600 messages) approximate arktech-mini on
 * 2026-10-28: about 600 mailboxes and a 1.2 MB agent mail store.
 *
 * Silences the console while it exists, because storage and mail logging
 * would otherwise dominate a run; `log` writes a result line regardless.
 */
export async function createAgentMailBenchFixture(options: {
  prefix: string;
  environments: number;
  tabs: number;
  messages: number;
}): Promise<AgentMailBenchFixture & { log: (line: string) => void }> {
  const { environments, tabs, messages } = options;
  const dataDir = await mkdtemp(path.join(tmpdir(), options.prefix));
  const quiet = { log: console.log, info: console.info, warn: console.warn };
  console.log = console.info = console.warn = () => undefined;
  const storage = new StorageService(dataDir);
  const dispose = async () => {
    Object.assign(console, quiet);
    await rm(dataDir, { recursive: true, force: true });
  };
  try {
    await storage.init();
    await storage.addProject({
      id: "project",
      name: "project",
      gitUrl: "https://example.invalid/project.git",
      localPath: null,
      addedAt: new Date(0).toISOString(),
      order: 0,
    });
    for (let index = 0; index < environments; index += 1) {
      const id = `env-${index}`;
      await storage.addEnvironment({
        id,
        projectId: "project",
        name: id,
        branch: "main",
        containerId: null,
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: new Date(0).toISOString(),
        networkAccessMode: "restricted",
        order: index,
        environmentType: "local",
        setupPhase: "ready",
        setupScriptsComplete: true,
      });
      await storage.savePaneLayout(
        id,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "pane",
          root: {
            kind: "leaf",
            id: "pane",
            tabs: Array.from({ length: tabs }, (_, tab) => ({
              id: `tab-${tab}`,
              type: "agent-native" as const,
              displayTitle: `tab ${tab}`,
              nativeAgentData: { environmentId: id, platform: "claude" as const },
            })),
            activeTabId: "tab-0",
          },
        },
        0,
      );
    }
    await storage.synchronizeAgentMailboxes();
    const body = "m".repeat(1_800);
    for (let index = 0; index < messages; index += 1) {
      await storage.sendAgentMail(
        {
          kind: "tab",
          environmentId: `env-${index % environments}`,
          projectId: "project",
          tabId: "tab-0",
        },
        {
          requestId: `bench-${index}`,
          toEnvironmentId: `env-${(index + 1) % environments}`,
          toTabId: `tab-${index % tabs}`,
          body,
        },
      );
    }
  } catch (error) {
    await dispose();
    throw error;
  }
  return { dataDir, storage, environments, tabs, dispose, log: (line) => quiet.log(line) };
}
