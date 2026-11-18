import { afterEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { AgentMailError } from "@orkestrator/protocol/agent-mail";
import { fixture } from "./agent-mail-storage-test-support.js";
import { deliverPrMergeTabNotices, renderPrMergeTabNotice } from "./pr-merge-tab-notices.js";
import type { CommandContext } from "./commands-context.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import { PrMonitorRuntime } from "./pr-monitor-runtime.js";
import { StorageService } from "./storage.js";
import { readStoredValue, seedStore } from "./storage-test-support.js";
import type { PersistedAgentMailStore } from "./storage-agent-mail-store.js";
import { AgentMailService } from "./agent-mail-service.js";
import { createLifecycleHarness } from "../../tests/pr-monitor-test-harness.js";

const PR = "https://github.com/acme/widgets/pull/42";

const dirs = new WeakMap<StorageService, string>();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function world() {
  const { storage, dataDir } = await fixture();
  cleanups.push(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  dirs.set(storage, dataDir);
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

    await expect(deliverPrMergeTabNotices(failing, "e1")).rejects.toThrow("remains pending");
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
      await runtime.resumeTerminalEffects("e1", { url: PR, state: "merged" });
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

for (const code of ["store-full", "mailbox-backlog-full"] as const) {
  test(`partial delivery recovers from ${code} after retention and restart`, async () => {
    const storage = await world();
    await storage.updateEnvironment("e1", { prUrl: PR, prState: "merged" });
    const partial = Object.assign(Object.create(storage) as StorageService, {
      sendAgentMail: (...args: Parameters<StorageService["sendAgentMail"]>) => {
        if (args[1].toTabId === "agent-2") throw new AgentMailError(code, "full");
        return storage.sendAgentMail(...args);
      },
    });
    await expect(deliverPrMergeTabNotices(partial, "e1")).rejects.toThrow("pending");
    expect(await mergeNotices(storage, "agent")).toHaveLength(1);
    const dataDir = dirs.get(storage)!;
    const persisted = readStoredValue<PersistedAgentMailStore>(dataDir, "agent-mail.json")!;
    for (const mailbox of Object.values(persisted.mailboxes)) {
      for (const message of mailbox.messages) message.createdAt = new Date(0).toISOString();
    }
    for (const record of Object.values(persisted.idempotency))
      record.createdAt = new Date(0).toISOString();
    seedStore(dataDir, "agent-mail.json", persisted);
    const restarted = new StorageService(dataDir);
    await restarted.init();
    await restarted.pruneAgentMail(1);
    expect(await mergeNotices(restarted, "agent")).toHaveLength(0);
    await deliverPrMergeTabNotices(restarted, "e1");
    expect(await mergeNotices(restarted, "agent")).toHaveLength(0);
    expect(await mergeNotices(restarted, "agent-2")).toHaveLength(1);
  });
}

test("messaging disabled drops earlier retry failures", async () => {
  const storage = await world();
  await storage.updateEnvironment("e1", { prUrl: PR, prState: "merged" });
  let attempt = 0;
  const partial = Object.assign(Object.create(storage) as StorageService, {
    sendAgentMail: async () => {
      throw new AgentMailError(attempt++ === 0 ? "store-full" : "messaging-disabled", "refused");
    },
  });
  await deliverPrMergeTabNotices(partial, "e1");
  await deliverPrMergeTabNotices(storage, "e1");
  expect((await storage.getEnvironment("e1"))?.prMergeNoticePendingUrl).toBeUndefined();
  expect(await mergeNotices(storage, "agent")).toHaveLength(0);
});

for (const change of [
  { prUrl: "https://github.com/acme/widgets/pull/43", prState: "open" as const },
  { deletionRequestedAt: new Date().toISOString() },
]) {
  test(`admission cancels stale delivery: ${JSON.stringify(change)}`, async () => {
    const storage = await world();
    await storage.updateEnvironment("e1", { prUrl: PR, prState: "merged" });
    let first = true;
    const raced = Object.assign(Object.create(storage) as StorageService, {
      sendAgentMail: async (...args: Parameters<StorageService["sendAgentMail"]>) => {
        if (first) {
          first = false;
          await storage.updateEnvironment("e1", change);
        }
        return storage.sendAgentMail(...args);
      },
    });
    await deliverPrMergeTabNotices(raced, "e1");
    expect(await mergeNotices(storage, "agent")).toHaveLength(0);
    expect(await mergeNotices(storage, "agent-2")).toHaveLength(0);
  });
}

test("deletion and mismatched pending markers are cleared before directory access", async () => {
  for (const change of [
    { deletionRequestedAt: new Date().toISOString() },
    { prState: "open" as const },
    { prUrl: "other" },
  ]) {
    const storage = await world();
    await storage.updateEnvironment("e1", { prUrl: PR, prState: "merged" });
    const dataDir = dirs.get(storage)!;
    const envs = readStoredValue<Array<Record<string, unknown>>>(dataDir, "environments.json")!;
    Object.assign(
      envs.find((e) => e.id === "e1")!,
      change,
    );
    seedStore(dataDir, "environments.json", envs);
    const guarded = Object.assign(Object.create(storage) as StorageService, {
      ensureAgentMailDirectoryFresh: async () => {
        throw new Error("must not refresh");
      },
    });
    await deliverPrMergeTabNotices(guarded, "e1");
    expect((await storage.getEnvironment("e1"))?.prMergeNoticePendingUrl).toBeUndefined();
  }
});

test("filters pipeline and pull-only mailboxes while accepting injectable tmux", async () => {
  const storage = await world();
  await storage.updateEnvironment("e1", { prUrl: PR, prState: "merged" });
  const { mailboxes } = await storage.listAgentMailboxes({ environmentId: "e1" });
  const native = mailboxes.find((m) => m.tabId === "agent")!;
  const sent: string[] = [];
  const filtered = Object.assign(Object.create(storage) as StorageService, {
    listAgentMailboxes: async () => ({
      mailboxes: [
        { ...native, tabId: "pipeline", kind: "pipeline" },
        { ...native, tabId: "pull", capabilities: { ...native.capabilities, canInject: false } },
        { ...native, tabId: "tmux", kind: "tmux", tabType: "claude-tmux" },
      ],
    }),
    sendAgentMail: async (_sender: unknown, input: { toTabId: string }) => {
      sent.push(input.toTabId);
    },
  });
  await deliverPrMergeTabNotices(filtered, "e1");
  expect(sent).toEqual(["tmux"]);
});

test("monitor retries runtime delivery in process after a transient failure", async () => {
  const storage = await world();
  await storage.updateEnvironment("e1", { prUrl: PR, prState: "merged" });
  let fail = true;
  const bound = Object.assign(Object.create(storage) as StorageService, {
    loadEnvironments: async () => [],
    sendAgentMail: (...args: Parameters<StorageService["sendAgentMail"]>) => {
      if (fail) throw new AgentMailError("store-full", "full");
      return storage.sendAgentMail(...args);
    },
  });
  const runtime = new PrMonitorRuntime({ scheduleMergeCleanup: () => undefined });
  const harness = createLifecycleHarness({ random: () => 0 });
  try {
    await runtime.sync({
      storage: bound,
      emit: () => undefined,
      environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    } as unknown as CommandContext);
    harness.setResumeHook(async () => {
      await runtime.resumeTerminalEffects("e1", { url: PR, state: "merged" });
    });
    const target = harness.addEnvironment("e1", { prUrl: PR, prState: "merged" });
    harness.github.set("e1", { url: PR, state: "merged" });
    harness.service.sync([target]);
    await harness.advance(300_000);
    for (let i = 0; i < 100 && harness.calls.resume.length === 0; i++)
      await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 30));
    expect(harness.calls.resume.length).toBeGreaterThan(0);
    expect((await storage.getEnvironment("e1"))?.prMergeNoticePendingUrl).toBe(PR);
    fail = false;
    await harness.advance(300_000);
    for (let i = 0; i < 100 && (await storage.getEnvironment("e1"))?.prMergeNoticePendingUrl; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(await mergeNotices(storage, "agent")).toHaveLength(1);
    expect(await mergeNotices(storage, "agent-2")).toHaveLength(1);
    expect((await storage.getEnvironment("e1"))?.prMergeNoticePendingUrl).toBeUndefined();
  } finally {
    harness.service.shutdown();
    runtime.shutdown();
  }
});

test("busy native and tmux tabs wait until idle without interruption", async () => {
  const storage = await world();
  const layout = (await storage.getPaneLayout("e1")) as
    import("@orkestrator/protocol/pane-layout-merge").PaneLayoutMergeInput | null;
  // Use the real terminal mailbox directory and shared drain for tmux delivery.
  if (layout?.root.kind !== "leaf") throw new Error("fixture layout");
  layout.root.tabs.push({ id: "tmux", type: "claude-tmux" });
  await storage.savePaneLayout("e1", layout, 2);
  await storage.synchronizeAgentMailboxes();
  await storage.updateEnvironment("e1", { prUrl: PR, prState: "merged" });
  await deliverPrMergeTabNotices(storage, "e1");
  let busy = true;
  let dispatches = 0;
  const service = new AgentMailService(
    storage,
    {
      reconcileMailInject: async () => "not-dispatched",
      sessionActivitySnapshot: () => (busy ? "working" : "idle"),
      mailInjectPresence: async () => (busy ? "working" : "idle"),
      dispatchMailInject: async () => {
        dispatches++;
        return { outcome: "accepted", requestId: "merge-test" };
      },
    },
    {
      mailInjectPresence: async () => (busy ? "working" : "idle"),
      dispatchMailInject: async () => {
        dispatches++;
        return { outcome: "accepted", requestId: "merge-test" };
      },
    },
  );
  try {
    await service.init();
    await service.drainInjects();
    expect(dispatches).toBe(0);
    busy = false;
    await service.drainInjects();
    expect(dispatches).toBe(3);
  } finally {
    await service.shutdown();
  }
});

test("a full global injection queue recovers after capacity is freed", async () => {
  const storage = await world();
  await storage.updateEnvironment("e1", { prUrl: PR, prState: "merged" });
  const dataDir = dirs.get(storage)!;
  const template = await storage.sendAgentMail(
    { kind: "system", projectId: "p1", source: "workflow", resourceId: "queue-test" },
    { requestId: "queue-template", toEnvironmentId: "e2", toTabId: "agent", body: "queue fixture" },
  );
  const persisted = readStoredValue<PersistedAgentMailStore>(dataDir, "agent-mail.json")!;
  const { AGENT_MAIL_MAX_PENDING_INJECTS } = await import("@orkestrator/protocol/agent-mail");
  persisted.mailboxes["e2\0agent"]!.messages = Array.from(
    { length: AGENT_MAIL_MAX_PENDING_INJECTS },
    (_, i) => ({ ...template, id: `held-${i}`, placement: "pending-inject" }),
  );
  seedStore(dataDir, "agent-mail.json", persisted);
  await expect(deliverPrMergeTabNotices(storage, "e1")).rejects.toThrow("pending");
  expect((await storage.getEnvironment("e1"))?.prMergeNoticePendingUrl).toBe(PR);
  const full = readStoredValue<PersistedAgentMailStore>(dataDir, "agent-mail.json")!;
  full.pendingInject = [];
  full.mailboxes["e2\0agent"]!.messages = [];
  seedStore(dataDir, "agent-mail.json", full);
  await deliverPrMergeTabNotices(storage, "e1");
  expect(await mergeNotices(storage, "agent")).toHaveLength(1);
  expect(await mergeNotices(storage, "agent-2")).toHaveLength(1);
});

for (const phase of ["directory", "second-send"] as const) {
  test(`deletion during ${phase} cancels remaining notices`, async () => {
    const storage = await world();
    await storage.updateEnvironment("e1", { prUrl: PR, prState: "merged" });
    let sends = 0;
    const raced = Object.assign(Object.create(storage) as StorageService, {
      ensureAgentMailDirectoryFresh: async (
        ...args: Parameters<StorageService["ensureAgentMailDirectoryFresh"]>
      ) => {
        await storage.ensureAgentMailDirectoryFresh(...args);
        if (phase === "directory")
          await storage.updateEnvironment("e1", { deletionRequestedAt: new Date().toISOString() });
      },
      sendAgentMail: async (...args: Parameters<StorageService["sendAgentMail"]>) => {
        if (phase === "second-send" && sends++ === 1)
          await storage.updateEnvironment("e1", { deletionRequestedAt: new Date().toISOString() });
        return storage.sendAgentMail(...args);
      },
    });
    await deliverPrMergeTabNotices(raced, "e1");
    expect(await mergeNotices(storage, "agent")).toHaveLength(phase === "directory" ? 0 : 1);
    expect(await mergeNotices(storage, "agent-2")).toHaveLength(0);
  });
}
