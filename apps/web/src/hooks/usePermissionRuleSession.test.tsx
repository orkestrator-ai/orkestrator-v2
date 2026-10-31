import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PermissionRuleApplication } from "@orkestrator/protocol/permission-rules";
import * as realBackend from "@/lib/backend";
import { dispatchResourceChange, resetResourceSync } from "@/lib/resource-sync";

/**
 * The transcript note's data on returning to an environment (todo 0723,
 * task 5): a rule may answer while the environment is not on screen and its
 * tab is unmounted, so the tab mounted on return must read what was answered,
 * and a tab for another environment must never show it.
 */

function application(
  environmentId: string,
  interactionId: string,
  appliedAt: number,
): PermissionRuleApplication {
  return {
    ruleId: "rule-1",
    kind: "command-prefix",
    pattern: "npm test",
    scope: "project",
    environmentId,
    agent: "codex",
    logicalSessionKey: "tab-1",
    interactionId,
    appliedAt,
  };
}

let stored: PermissionRuleApplication[] = [];
const listPermissionRules = mock(
  async (filter: { environmentId?: string; agent?: string; logicalSessionKey?: string }) => ({
    rules: [],
    applications: stored.filter(
      (entry) =>
        entry.environmentId === filter.environmentId &&
        entry.agent === filter.agent &&
        entry.logicalSessionKey === filter.logicalSessionKey,
    ),
  }),
);

mock.module("@/lib/backend", () => ({ ...realBackend, listPermissionRules }));

const { usePermissionRuleSession } = await import("./usePermissionRuleSession");

afterEach(() => {
  cleanup();
  resetResourceSync();
  stored = [];
  listPermissionRules.mockClear();
});

afterAll(() => {
  mock.module("@/lib/backend", () => realBackend);
});

describe("usePermissionRuleSession", () => {
  test("a tab mounted on return reads what a rule answered while it was away", async () => {
    // Answered by the backend's sweep with no tab mounted.
    stored = [application("env-1", "a1", 10)];
    const { result } = renderHook(() => usePermissionRuleSession("env-1", "codex", "tab-1"));
    await waitFor(() => expect(result.current.applications).toHaveLength(1));
    expect(result.current.applications[0]).toMatchObject({ interactionId: "a1" });
    expect(listPermissionRules).toHaveBeenCalledWith({
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: "tab-1",
    });
  });

  test("a permission-rule hint re-reads, so a mounted tab picks up a later answer", async () => {
    const { result } = renderHook(() => usePermissionRuleSession("env-1", "codex", "tab-1"));
    await waitFor(() => expect(listPermissionRules).toHaveBeenCalledTimes(1));
    expect(result.current.applications).toEqual([]);

    stored = [application("env-1", "a1", 10)];
    dispatchResourceChange({ resource: "permission-rule", id: "rule-1", revision: 1 });
    await waitFor(() => expect(result.current.applications).toHaveLength(1));
  });

  test("switching to another environment never shows the previous one's notes", async () => {
    stored = [application("env-1", "a1", 10)];
    const { result, rerender } = renderHook(
      ({ environmentId }) => usePermissionRuleSession(environmentId, "codex", "tab-1"),
      { initialProps: { environmentId: "env-1" } },
    );
    await waitFor(() => expect(result.current.applications).toHaveLength(1));

    rerender({ environmentId: "env-2" });
    // Before env-2's own read lands, env-1's notes are already gone.
    expect(result.current.applications).toEqual([]);
    await waitFor(() =>
      expect(listPermissionRules).toHaveBeenLastCalledWith({
        environmentId: "env-2",
        agent: "codex",
        logicalSessionKey: "tab-1",
      }),
    );
    expect(result.current.applications).toEqual([]);
  });
});
