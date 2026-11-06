import { describe, expect, test } from "bun:test";
import { RequestLimiter } from "@/lib/hydration-request-limiter";
import { waitForHydrationQuiet } from "./useRealmBootTiming";

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("waitForHydrationQuiet", () => {
  test("waits through reads that start just after the limiter first goes idle", async () => {
    const limiter = new RequestLimiter(2);
    const finished: string[] = [];
    void limiter.run(async () => {
      await nextTask();
      finished.push("environments");
      // As the batcher does: the follow-up read starts from a zero-delay timer.
      setTimeout(() => {
        void limiter.run(async () => {
          await nextTask();
          finished.push("hydration");
        });
      }, 0);
    });

    await waitForHydrationQuiet(limiter);
    expect(finished).toEqual(["environments", "hydration"]);
    expect(limiter.started).toBe(2);
  });

  test("resolves promptly when nothing was ever sent", async () => {
    await waitForHydrationQuiet(new RequestLimiter(1));
  });
});

import { afterEach, mock, spyOn } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { hydrationRequests } from "@/lib/hydration-request-limiter";
import { resetRealmBootTimingForTests } from "@/lib/realm-boot-timing";
import { useTimedEnvironmentLoad, useRealmFanOutTiming } from "./useRealmBootTiming";
import { useSidebarHydration } from "../sidebar/useSidebarHydration";

const originalUrl = window.location.href;
const originalApi = window.orkestrator;
const dom = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
afterEach(() => {
  cleanup();
  dom.setURL(originalUrl);
  window.orkestrator = originalApi;
  resetRealmBootTimingForTests();
});

for (const failed of [false, true]) {
  test(`timing hooks finish once after initial environment attempts (${failed ? "partial failure" : "success"})`, async () => {
    const post = mock((_message: unknown) => {});
    dom.setURL("https://command.test/?realm=workspace");
    window.orkestrator = {
      ...originalApi,
      workspaceRealm: { post, onMessage: () => () => {} },
    } as typeof window.orkestrator;
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    let finishHydration!: () => void;
    const load = mock(
      (id: string) =>
        new Promise<void>((resolve, reject) => {
          if (id === "one")
            finishFirst = () => (failed ? reject(new Error("unavailable")) : resolve());
          else finishSecond = resolve;
        }),
    );
    const projects = [{ id: "one" }, { id: "two" }];
    const environments: { projectId: string }[] = [];
    const now = spyOn(globalThis.performance, "now").mockReturnValue(100);
    try {
      const { result, rerender } = renderHook(() => {
        const boot = useTimedEnvironmentLoad(load);
        const ready = useSidebarHydration(projects, true, environments, boot.load);
        useRealmFanOutTiming(
          projects.every((p) => boot.settled.has(p.id)),
          boot.clock,
          Array.from(boot.settled.values()).some((ok) => !ok),
        );
        return { boot, ready };
      });
      expect(result.current.boot.clock.current).toBe(100);
      const hydration = hydrationRequests.run(
        () =>
          new Promise<void>((resolve) => {
            finishHydration = resolve;
          }),
      );
      now.mockReturnValue(150);
      await act(async () => {
        finishFirst();
      });
      now.mockReturnValue(180);
      await act(async () => {
        finishSecond();
      });
      expect(result.current.ready).toBe(!failed);
      expect(post.mock.calls.map(([m]) => (m as { step: string }).step)).toEqual([
        "first-environments",
      ]);
      now.mockReturnValue(300);
      await act(async () => {
        finishHydration();
        await hydration;
      });
      await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
      expect(post.mock.calls.map(([m]) => m)).toEqual([
        {
          type: "bootTiming",
          step: "first-environments",
          durationMs: 50,
          sinceStartMs: 150,
          outcome: failed ? "failed" : "ok",
        },
        {
          type: "bootTiming",
          step: "fan-out-complete",
          durationMs: 200,
          sinceStartMs: 300,
          outcome: failed ? "failed" : "ok",
          requests: 1,
        },
      ]);
      rerender();
      await nextTask();
      expect(post).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });
}

for (const failure of ["pipeline", "snapshot"] as const) {
  test(`successful environment loads report failed fan-out after a ${failure} restore rejects`, async () => {
    const backend = await import("@/lib/backend");
    const native = await import("@/lib/native/backend");
    const { hydrateBuildPipelinesForProject } = await import("@/lib/build-pipeline-persistence");
    const post = mock((_message: unknown) => {});
    dom.setURL("https://command.test/?realm=workspace");
    window.orkestrator = {
      ...originalApi,
      workspaceRealm: { post, onMessage: () => () => {} },
    } as typeof window.orkestrator;
    let rejectHydration!: (error: Error) => void;
    const invoke = spyOn(native, "invoke").mockImplementation(<T>(command: string) =>
      command === (failure === "pipeline" ? "list_build_pipelines" : "get_environment_snapshots")
        ? new Promise<T>((_resolve, reject) => {
            rejectHydration = reject;
          })
        : Promise.resolve([] as T),
    );
    try {
      const { result } = renderHook(() => {
        const boot = useTimedEnvironmentLoad(async () => []);
        useSidebarHydration([{ id: "project" }], true, [], boot.load);
        useRealmFanOutTiming(boot.settled.has("project"), boot.clock);
        return boot;
      });
      // Attach the rejection handler before ending the task: Bun treats an
      // unhandled rejection as fatal even when it is caught in a later task.
      const hydration = (
        failure === "pipeline"
          ? hydrateBuildPipelinesForProject("project")
          : backend.getEnvironmentSnapshots("project")
      ).catch(() => undefined);
      await waitFor(() => expect(result.current.settled.get("project")).toBe(true));
      expect(post.mock.calls.map(([m]) => (m as { step: string }).step)).toEqual([
        "first-environments",
      ]);
      await act(async () => {
        rejectHydration(new Error("unavailable"));
        await hydration;
      });
      await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
      expect(post.mock.calls[1]?.[0]).toMatchObject({
        step: "fan-out-complete",
        outcome: "failed",
      });
    } finally {
      invoke.mockRestore();
    }
  });
}
