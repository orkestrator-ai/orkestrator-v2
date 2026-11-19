import { describe, expect, mock, test } from "bun:test";
import type { BackendClient } from "./client";
import { createProjectsEnvironmentsApi } from "./projects-environments";

function sentArgs(invokeRaw: ReturnType<typeof mock>): string {
  return JSON.stringify(invokeRaw.mock.calls.map((call) => call.slice(0, 2)));
}

describe("createEnvironment", () => {
  test("sends a pinned launch base as the create request's base branch and commit", async () => {
    const invokeRaw = mock(() => Promise.resolve({ id: "env-1" } as never));
    const api = createProjectsEnvironmentsApi({ invokeRaw } as BackendClient);
    const commit = "0123456789abcdef0123456789abcdef01234567";

    await api
      .createEnvironment(
        "project-1",
        undefined,
        undefined,
        undefined,
        undefined,
        "local",
        undefined,
        undefined,
        undefined,
        { branch: "main", commit },
      )
      .catch(() => undefined);

    const sent = sentArgs(invokeRaw);
    expect(sent).toContain('"worktreeBaseBranch":"main"');
    expect(sent).toContain(`"worktreeBaseCommit":"${commit}"`);
    expect(sent).not.toContain("delegationBase");
  });

  test("an unpinned create sends no base, so the start resolves it", async () => {
    const invokeRaw = mock(() => Promise.resolve({ id: "env-1" } as never));
    const api = createProjectsEnvironmentsApi({ invokeRaw } as BackendClient);

    await api.createEnvironment("project-1").catch(() => undefined);

    expect(invokeRaw).toHaveBeenCalled();
    expect(sentArgs(invokeRaw)).not.toContain("worktreeBase");
  });
});
