import { expect, test } from "@playwright/test";
import {
  AGENT_HANDOFF_VERSION,
  createAgentHandoffSnapshot,
} from "@orkestrator/protocol/agent-handoff";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  authenticatedInvoke,
  profileStatus,
  type Environment,
  type Project,
} from "./slash-command-live-support";

const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";

test("backend-owned settings patches, handoff retries and pane layouts survive browser reload", async ({
  page,
}) => {
  const status = profileStatus(profile);
  expect(status.flavor).toBe("agent-test");
  const invoke = await authenticatedInvoke(page, status, profile);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  )!;
  const original = await invoke<{ global: Record<string, unknown> }>("get_config");
  const environment = await invoke<Environment>("create_environment", {
    projectId: fixture.id,
    name: `backend-moves-${Date.now()}`,
    environmentType: "local",
  });
  const handoffId = `handoff-${environment.id}`;
  const source = {
    handoffId,
    environmentId: environment.id,
    sourceAgent: "claude",
    logicalSessionKey: `env-${environment.id}:source`,
    sourceSessionId: "historical-session",
    destinationProvider: "codex",
  };
  try {
    await invoke("patch_global_config", { patch: { claudeBackgroundCommandLimitHours: 24 } });
    await invoke("patch_global_config", { patch: { terminalScrollback: 4321 } });
    const reset = await invoke<{ global: Record<string, unknown> }>("patch_global_config", {
      patch: {},
      unset: ["claudeBackgroundCommandLimitHours"],
    });
    expect(Object.hasOwn(reset.global, "claudeBackgroundCommandLimitHours")).toBe(false);
    expect(reset.global.terminalScrollback).toBe(4321);

    // A historical transfer staged by an older client must be reused by the
    // current create command even after its source session is no longer present.
    const snapshot = createAgentHandoffSnapshot({
      id: handoffId,
      environmentId: environment.id,
      sourceProvider: "claude",
      destinationProvider: "codex",
      sourceSessionId: source.sourceSessionId,
      messages: [
        {
          id: "historical-user",
          role: "user",
          content: "Keep the saved context",
          parts: [],
          createdAt: new Date(0).toISOString(),
        },
      ],
    });
    const saved = await invoke("save_agent_handoff", {
      handoffId,
      environmentId: environment.id,
      version: AGENT_HANDOFF_VERSION,
      snapshot,
    });
    expect(await invoke("create_agent_handoff", source)).toEqual(saved);
    expect(await invoke("get_agent_handoff_capabilities")).toMatchObject({
      create: true,
      delivery: true,
      pruning: true,
    });
    const layout = {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "continued-pane",
      root: {
        kind: "leaf",
        id: "continued-pane",
        activeTabId: "continued-tab",
        tabs: [
          {
            id: "continued-tab",
            type: "agent-native",
            agentHandoffId: handoffId,
            nativeAgentData: { environmentId: environment.id, platform: "codex", isLocal: true },
          },
        ],
      },
    };
    const previousLayout = await invoke<{ revision: number } | null>("get_pane_layout", {
      environmentId: environment.id,
    });
    await invoke("save_pane_layout", {
      environmentId: environment.id,
      expectedRevision: previousLayout?.revision ?? 0,
      layout,
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    const persisted = await invoke("get_pane_layout", {
      environmentId: environment.id,
    });
    expect(persisted).toMatchObject(layout);
    expect(await invoke("create_agent_handoff", source)).toEqual(saved);
    const reloaded = await invoke<{ global: Record<string, unknown> }>("get_config");
    expect(Object.hasOwn(reloaded.global, "claudeBackgroundCommandLimitHours")).toBe(false);
    expect(reloaded.global.terminalScrollback).toBe(4321);

    // A new handoff must obtain a real source transcript. An absent source
    // cannot be replaced by context supplied by a caller.
    const missingId = `${handoffId}-missing`;
    const refusal = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      {
        data: { command: "create_agent_handoff", args: { ...source, handoffId: missingId } },
      },
    );
    expect(refusal.ok()).toBe(false);
    expect(await invoke("get_agent_handoff", { handoffId: missingId })).toBeNull();
  } finally {
    const keys = ["claudeBackgroundCommandLimitHours", "terminalScrollback"];
    await invoke("patch_global_config", {
      patch: Object.fromEntries(
        keys
          .filter((key) => Object.hasOwn(original.global, key))
          .map((key) => [key, original.global[key]]),
      ),
      unset: keys.filter((key) => !Object.hasOwn(original.global, key)),
    });
    await invoke("delete_environment", { environmentId: environment.id });
  }
});
