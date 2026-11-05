import { describe, expect, test } from "bun:test";
import { actionHash, coordinatorLaunchIdentity } from "./coordinator-action-scope.js";

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
