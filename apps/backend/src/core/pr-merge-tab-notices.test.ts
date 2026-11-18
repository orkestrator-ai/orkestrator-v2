import { afterEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { AgentMailError } from "@orkestrator/protocol/agent-mail";
import { fixture } from "./agent-mail-storage-test-support.js";
import { deliverPrMergeTabNotices, renderPrMergeTabNotice } from "./pr-merge-tab-notices.js";
import type { CommandContext } from "./commands-context.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import { PrMonitorRuntime } from "./pr-monitor-runtime.js";
import type { StorageService } from "./storage.js";

const PR = "https://github.com/acme/widgets/pull/42";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function world() {
  const { storage, dataDir } = await fixture();
  cleanups.push(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  // e1 gets a second agent tab and a plain terminal, which takes no mail.
  await storage.savePaneLayout(
    "e1",
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
            displayTitle: "first",
            nativeAgentData: { environmentId: "e1", platform: "claude" },
          },
          {
            id: "agent-2",
            type: "agent-native",
            displayTitle: "second",
            nativeAgentData: { environmentId: "e1", platform: "codex" },
          },
          { id: "shell", type: "plain", displayTitle: "shell" },
        ],
        activeTabId: "agent",
      },
    },
    1,
  );
  await storage.synchronizeAgentMailboxes();
  return storage;
}

async function mergeNotices(storage: StorageService, tabId: string) {
  const mailbox = await storage.getAgentMailMailbox("e1", tabId);
  return mailbox.messages.filter((message) => message.from.kind === "system");
}

describe("merge notice marker", () => {
  test("is armed by the write that records the merge, and only that one", async () => {
    const storage = await world();
    await storage.updateEnvironment("e1", { prUrl: PR, prState: "open" });
    expect((await storage.getEnvironment("e1"))?.prMergeNoticePendingUrl).toBeUndefined();

    await storage.updateEnvironment("e1", { prUrl: PR, prState: "merged" });
    expect((await storage.getEnvironment("e1"))?.prMergeNoticePendingUrl).toBe(PR);

    await storage.updateEnvironment("e1", { prMergeNoticePendingUrl: null });
    // The monitor rewrites the same merged reading on every check.
    await storage.updateEnvironment("e1", { prUrl: PR, prState: "merged" });
    expect((await storage.getEnvironment("e1"))?.prMergeNoticePendingUrl).toBeUndefined();
  });

  test("is dropped when the PR it names is replaced or reopened", async () => {
    const storage = await world();
    await storage.updateEnvironment("e1", { prUrl: PR, prState: "merged" });
    await storage.updateEnvironment("e1", { prState: "open" });
    expect((await storage.getEnvironment("e1"))?.prMergeNoticePendingUrl).toBeUndefined();

    await storage.updateEnvironment("e1", { prState: "merged" });
    const replacement = "https://github.com/acme/widgets/pull/43";
    await storage.updateEnvironment("e1", { prUrl: replacement, prState: "open" });
    expect((await storage.getEnvironment("e1"))?.prMergeNoticePendingUrl).toBeUndefined();
  });

  test("cannot be set from outside", async () => {
    const storage = await world();
    await storage.updateEnvironment("e1", { prMergeNoticePendingUrl: PR });
    expect((await storage.getEnvironment("e1"))?.prMergeNoticePendingUrl).toBeUndefined();
  });
});

describe("deliverPrMergeTabNotices", () => {
  test("sends every open agent tab one quiet notice, then clears the marker", async () => {
    const storage = await world();
    await storage.updateEnvironment("e1", {
      prUrl: PR,
      prState: "merged",
      prBaseBranch: "main",
    });

    await deliverPrMergeTabNotices(storage, "e1");
    // Repeating it (every restart's terminal repair does) sends nothing new.
    await deliverPrMergeTabNotices(storage, "e1");

    for (const tabId of ["agent", "agent-2"]) {
      const notices = await mergeNotices(storage, tabId);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.notice).toEqual({
        pullRequest: { url: PR, number: 42 },
        resource: { kind: "watched-pull-request", id: "acme/widgets#42" },
        state: "pr-merged",
        tone: "success",
      });
      expect(notices[0]!.placement).not.toBe("stored");
    }
    expect((await storage.getEnvironment("e1"))?.prMergeNoticePendingUrl).toBeUndefined();
    // Other environments hear nothing.
    expect(await storage.getAgentMailMailbox("e2", "agent")).toMatchObject({ total: 0 });
  });

  test("announces nothing for a merge recorded without the marker", async () => {
    const storage = await world();
    await storage.updateEnvironment("e1", { prUrl: PR, prState: "merged" });
    await storage.updateEnvironment("e1", { prMergeNoticePendingUrl: null });

    await deliverPrMergeTabNotices(storage, "e1");

    expect(await mergeNotices(storage, "agent")).toHaveLength(0);
  });

  test("skips an environment that is deleted after the merge", async () => {
    const storage = await world();
    await storage.updateEnvironment("e1", {
      prUrl: PR,
      prState: "merged",
      cleanupAfterMergeRequestedAt: new Date().toISOString(),
    });

    await deliverPrMergeTabNotices(storage, "e1");

    expect(await mergeNotices(storage, "agent")).toHaveLength(0);
    expect((await storage.getEnvironment("e1"))?.prMergeNoticePendingUrl).toBeUndefined();
  });

  test("keeps the marker when a send fails in a way a retry can fix", async () => {
    const storage = await world();
    await storage.updateEnvironment("e1", { prUrl: PR, prState: "merged" });
    const failing = Object.assign(Object.create(storage) as StorageService, {
      sendAgentMail: async () => {
        throw new AgentMailError("store-full", "full");
      },
    });

    await deliverPrMergeTabNotices(failing, "e1");
    expect((await storage.getEnvironment("e1"))?.prMergeNoticePendingUrl).toBe(PR);

    await deliverPrMergeTabNotices(storage, "e1");
    expect(await mergeNotices(storage, "agent")).toHaveLength(1);
    expect((await storage.getEnvironment("e1"))?.prMergeNoticePendingUrl).toBeUndefined();
  });

  test("stops without retrying when agent messaging is off", async () => {
    const storage = await world();
    await storage.updateEnvironment("e1", { prUrl: PR, prState: "merged" });
    const disabled = Object.assign(Object.create(storage) as StorageService, {
      sendAgentMail: async () => {
        throw new AgentMailError("messaging-disabled", "off");
      },
    });

    await deliverPrMergeTabNotices(disabled, "e1");

    expect((await storage.getEnvironment("e1"))?.prMergeNoticePendingUrl).toBeUndefined();
  });
});

describe("the PR monitor's terminal follow-up", () => {
  test("tells the open tabs of a merge it confirms", async () => {
    const storage = await world();
    await storage.updateEnvironment("e1", { prUrl: PR, prState: "merged" });
    // No monitored environments, so binding the runtime starts no `gh` reads.
    const bound = Object.assign(Object.create(storage) as StorageService, {
      loadEnvironments: async () => [],
    });
    const context = {
      storage: bound,
      emit: () => undefined,
      appRoot: "",
      resourceRoot: "",
      environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    } as unknown as CommandContext;
    const runtime = new PrMonitorRuntime({ scheduleMergeCleanup: mock(() => undefined) });
    try {
      await runtime.sync(context);
      runtime.resumeTerminalEffects("e1", { url: PR, state: "merged" });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await storage.getEnvironment("e1"))?.prMergeNoticePendingUrl === undefined) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await mergeNotices(storage, "agent")).toHaveLength(1);
      expect(await mergeNotices(storage, "agent-2")).toHaveLength(1);
    } finally {
      runtime.shutdown();
    }
  });
});

describe("renderPrMergeTabNotice", () => {
  test("says the branch merged and that no reply is needed", () => {
    const { subject, body } = renderPrMergeTabNotice(
      { branch: "feature/login", prBaseBranch: "main" },
      PR,
    );
    expect(subject).toBe("PR #42 merged");
    expect(body.split("\n")[0]).toBe(
      "The pull request for this environment's branch `feature/login` was merged into `main`.",
    );
    expect(body).toContain("needs no reply");
    expect(body).toContain("without writing anything to the user");
  });

  test("still draws a line for a host it cannot link", () => {
    const { subject, notice } = renderPrMergeTabNotice(
      { branch: "", prBaseBranch: null },
      "https://git.example.com/acme/widgets/pull/7",
    );
    expect(subject).toBe("Pull request merged");
    expect(notice.pullRequest).toBeUndefined();
    expect(notice.resource.kind).toBe("watched-pull-request");
  });
});
