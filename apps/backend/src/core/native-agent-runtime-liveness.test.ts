import { describe, expect, test } from "bun:test";
import { bugReportRuntimeId } from "@orkestrator/protocol/bug-report";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import { runtimeStillLive } from "./native-agent-runtime-liveness.js";
import type { StorageService } from "./storage.js";

function storage(options: { closed?: boolean; reports?: Record<string, unknown> } = {}) {
  return {
    loadConfig: async () => ({ global: {} }),
    getProject: async () => ({ id: "p1", localPath: "/checkout" }),
    coordinators: {
      getCoordinatorWorkspaceById: async (id: string) =>
        id === "c1"
          ? {
              id: "c1",
              projectId: "p1",
              lifecycleState: "ready",
              conversations: [
                {
                  id: "conv-1",
                  agent: "opencode",
                  ...(options.closed ? { closedAt: new Date(0).toISOString() } : {}),
                },
              ],
            }
          : null,
    },
    bugReports: {
      getBugReport: async (id: string) => options.reports?.[id] ?? null,
    },
  } as unknown as StorageService;
}

describe("runtimeStillLive", () => {
  test("an open coordinator conversation's runtime is live; a closed or unknown one is not", async () => {
    const runtime = coordinatorRuntimeId("c1", "conv-1");
    expect(await runtimeStillLive(storage(), runtime)).toBe(true);
    expect(await runtimeStillLive(storage({ closed: true }), runtime)).toBe(false);
    expect(await runtimeStillLive(storage(), coordinatorRuntimeId("c2", "conv-1"))).toBe(false);
  });

  test("a bug report's runtime is live while the report has an agent", async () => {
    const runtime = bugReportRuntimeId("r1");
    expect(await runtimeStillLive(storage(), runtime)).toBe(false);
    expect(
      await runtimeStillLive(
        storage({ reports: { r1: { id: "r1", agent: "opencode" } } }),
        runtime,
      ),
    ).toBe(true);
  });

  test("an ordinary environment id is not a runtime, and an unreadable store keeps the provider", async () => {
    expect(await runtimeStillLive(storage(), "env-1")).toBe(false);
    const broken = {
      coordinators: {
        getCoordinatorWorkspaceById: async () => {
          throw new Error("store unavailable");
        },
      },
    } as unknown as StorageService;
    expect(await runtimeStillLive(broken, coordinatorRuntimeId("c1", "conv-1"))).toBe(true);
  });
});
