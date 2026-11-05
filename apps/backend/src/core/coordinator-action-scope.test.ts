import { describe, expect, test } from "bun:test";
import type { CommandContext } from "./commands-context.js";
import {
  actionHash,
  coordinatorLaunchIdentity,
  requireCoordinatorConversation,
} from "./coordinator-action-scope.js";

describe("requireCoordinatorConversation", () => {
  const context = (lifecycleState: string) =>
    ({
      storage: {
        coordinators: {
          getCoordinatorWorkspaceById: async () => ({
            projectId: "project-1",
            lifecycleState,
            conversations: [
              { id: "main" },
              { id: "side", startupError: "bridge failed" },
              { id: "closed", closedAt: "2026-01-01T00:00:00Z" },
            ],
          }),
        },
      },
    }) as unknown as CommandContext;
  const check = (state: string, conversationId: string) =>
    requireCoordinatorConversation(context(state), "project-1", "coordinator-1", conversationId);

  test("refuses only the conversation that failed to start", async () => {
    await expect(check("ready", "main")).resolves.toBeUndefined();
    await expect(check("ready", "side")).rejects.toThrow("unavailable");
    await expect(check("ready", "closed")).rejects.toThrow("unavailable");
  });

  test("a paused coordinator refuses every conversation", async () => {
    await expect(check("paused", "main")).rejects.toThrow("unavailable");
  });
});

describe("coordinatorLaunchIdentity", () => {
  const launch = (agent: string) => ({
    projectId: "project-1",
    initialPrompt: "Build it.",
    agentSettings: { defaultAgent: agent, platforms: { [agent]: { mode: "native" } } },
  });

  test("a defaulted agent fingerprints as the default, whatever it resolved to", () => {
    // A retry after the user changed their default agent replays the launch.
    expect(actionHash(coordinatorLaunchIdentity(launch("codex"), true))).toBe(
      actionHash(coordinatorLaunchIdentity(launch("claude"), true)),
    );
    // Its platform options (fast mode) are still part of the request.
    const fast = launch("codex");
    fast.agentSettings.platforms.codex = { mode: "native", fastMode: true } as never;
    expect(actionHash(coordinatorLaunchIdentity(fast, true))).not.toBe(
      actionHash(coordinatorLaunchIdentity(launch("codex"), true)),
    );
  });

  test("a named agent is part of the request, and differs from the default", () => {
    expect(coordinatorLaunchIdentity(launch("codex"), undefined)).toEqual(launch("codex"));
    expect(actionHash(coordinatorLaunchIdentity(launch("codex"), undefined))).not.toBe(
      actionHash(coordinatorLaunchIdentity(launch("claude"), undefined)),
    );
    expect(actionHash(coordinatorLaunchIdentity(launch("codex"), true))).not.toBe(
      actionHash(coordinatorLaunchIdentity(launch("codex"), undefined)),
    );
  });
});
