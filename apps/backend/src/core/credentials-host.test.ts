import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { createCredentialHost } from "./credentials-host.js";
import { interactivePolicy } from "./credentials/service-test-support.js";
import { EnvironmentLifecycleTaskTracker } from "./environments/lifecycle-tasks.js";
import { nativeAgentSessionStorageKey } from "./native-agent/service-shared.js";
import { createEnvironment, StorageService } from "./storage/service.js";

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const remove of cleanup.splice(0).reverse()) await remove();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "credential-host-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const storage = new StorageService(join(root, "data"));
  await storage.init();
  cleanup.push(() => storage.close());
  const emit = () => undefined;
  const runtime = new BackendRuntime({ emit });
  const context: CommandContext = {
    storage,
    runtime,
    emit,
    appRoot: root,
    resourceRoot: root,
    runtimeFlavor: "agent-test",
    credentialSources: new Set(),
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
  };
  const environment = await storage.addEnvironment({
    ...createEnvironment("fixture-project", { environmentType: "local" }),
    status: "running",
    worktreePath: root,
  });
  const host = createCredentialHost(context);
  return { storage, runtime, environment, root, host };
}

test("resolves native approval tabs, session and runtime authority from the same database", async () => {
  const { storage, environment, root, host } = await fixture();
  const tabId = "fixture-native";
  const sessionKey = `env-${environment.id}:${tabId}`;
  const policy = interactivePolicy({ approvals: "ask" });
  await storage.getOrCreateNativeAgentSession(
    {
      key: nativeAgentSessionStorageKey(environment.id, "opencode", sessionKey),
      environmentId: environment.id,
      agent: "opencode",
      logicalSessionKey: sessionKey,
      policy,
    },
    async () => "fixture-provider",
  );
  await storage.savePaneLayout(
    environment.id,
    {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "pane",
      root: {
        kind: "leaf",
        id: "pane",
        activeTabId: tabId,
        tabs: [
          { id: tabId, type: "agent-native" },
          { id: "terminal", type: "opencode" },
        ],
      },
    },
    0,
  );
  expect(await host.hasApprovalTab(environment.id, tabId)).toBe(true);
  expect(await host.hasApprovalTab(environment.id, "terminal")).toBe(false);
  expect(await host.hasApprovalTab(environment.id, "missing")).toBe(false);
  const session = await host.session(environment.id, tabId);
  expect(session).toMatchObject({
    agent: "opencode",
    policy,
    providerSessionId: "fixture-provider",
  });
  const runtime = await host.runtime(environment.id);
  expect(runtime).toMatchObject({ runtime: { kind: "worktree" }, identity: `worktree:${root}` });
  expect(
    storage
      .credentialRecordStore()
      .transaction(() => host.dispatchBinding!(environment.id, tabId, "opencode")),
  ).toEqual({ session, runtime });

  await storage.updateEnvironment(environment.id, {
    environmentType: "containerized",
    networkAccessMode: "restricted",
    containerId: "fixture-container",
  });
  expect(await host.runtime(environment.id)).toMatchObject({
    runtime: { kind: "container" },
    identity: "container:fixture-container",
    networkAccess: "restricted",
  });
  const launch = await host.launch(environment.id, tabId);
  expect(launch).toMatchObject({
    target: "container",
    cwd: "/workspace",
    containerId: "fixture-container",
  });
  launch.release?.();
});

test("local launches use the scoped runtime account and enforce the environment work fence", async () => {
  const { storage, environment, root, runtime, host } = await fixture();
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "synthetic-host-fixture-value";
  cleanup.push(() => {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
  });
  const accountId = crypto.randomUUID();
  await storage.agentAccounts.mutateAgentAccounts((store) => ({
    store: {
      ...store,
      active: { codex: accountId },
      accounts: [
        { id: accountId, platform: "codex", label: "Fixture", createdAt: new Date().toISOString() },
      ],
    },
    result: undefined,
  }));
  const release = await host.beginUse!(environment.id, "tab");
  try {
    expect(() => runtime.environments.fence.beginMove(environment.id)).toThrow(
      "submission is still in progress",
    );
  } finally {
    release();
  }
  const launch = await host.launch(environment.id, "tab");
  try {
    expect(launch).toMatchObject({ target: "worktree", cwd: root });
    expect(launch.env.CODEX_HOME).toContain(accountId);
    expect(launch.env.OPENAI_API_KEY).toBeUndefined();
    expect(() => runtime.environments.fence.beginMove(environment.id)).toThrow(
      "submission is still in progress",
    );
  } finally {
    launch.release?.();
  }
  expect(runtime.environments.fence.beginMove(environment.id)).toBe(true);
  try {
    await expect(host.beginUse!(environment.id, "tab")).rejects.toThrow("being moved");
    await expect(host.launch(environment.id, "tab")).rejects.toThrow("being moved");
    expect(() => host.dispatchBinding!(environment.id, "tab", "codex")).toThrow("being moved");
  } finally {
    runtime.environments.fence.endMove(environment.id);
  }
});
