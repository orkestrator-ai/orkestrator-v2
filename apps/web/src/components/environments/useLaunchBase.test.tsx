import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ProjectBaseBranchTip } from "@/lib/launch-base";
import { useLaunchBase, type LoadLaunchBaseTip } from "./useLaunchBase";

afterEach(cleanup);

const tip = (commit: string): ProjectBaseBranchTip => ({
  branch: "main",
  commit,
  ref: "origin/main",
  fetched: true,
  fetchedAt: "2026-11-19T10:00:00.000Z",
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useLaunchBase", () => {
  test("is idle until wanted, then resolves the base", async () => {
    const load = mock<LoadLaunchBaseTip>(async () => tip("a".repeat(40)));
    const { result, rerender } = renderHook(
      ({ enabled }) => useLaunchBase({ enabled, projectId: "p1", load }),
      { initialProps: { enabled: false } },
    );
    expect(result.current.state).toEqual({ status: "idle" });
    expect(load).not.toHaveBeenCalled();

    rerender({ enabled: true });
    expect(result.current.state).toEqual({ status: "resolving" });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(load).toHaveBeenCalledWith("p1");
  });

  test("reads the base again every time it becomes wanted, never reusing an old answer", async () => {
    let commit = "a".repeat(40);
    const load = mock<LoadLaunchBaseTip>(async () => tip(commit));
    const { result, rerender } = renderHook(
      ({ enabled }) => useLaunchBase({ enabled, projectId: "p1", load }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.state).toMatchObject({ commit }));

    rerender({ enabled: false });
    commit = "b".repeat(40);
    rerender({ enabled: true });
    expect(result.current.state).toEqual({ status: "resolving" });
    await waitFor(() => expect(result.current.state).toMatchObject({ commit: "b".repeat(40) }));
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("ignores an answer for a read it no longer wants", async () => {
    const first = deferred<ProjectBaseBranchTip>();
    const load = mock<LoadLaunchBaseTip>((projectId) =>
      projectId === "p1" ? first.promise : Promise.resolve(tip("c".repeat(40))),
    );
    const { result, rerender } = renderHook(
      ({ projectId }) => useLaunchBase({ enabled: true, projectId, load }),
      { initialProps: { projectId: "p1" } },
    );
    rerender({ projectId: "p2" });
    await waitFor(() => expect(result.current.state).toMatchObject({ commit: "c".repeat(40) }));
    await act(async () => first.resolve(tip("a".repeat(40))));
    expect(result.current.state).toMatchObject({ commit: "c".repeat(40) });
  });

  test("a failed or missing read is unavailable, and refresh retries it", async () => {
    let fail = true;
    const load = mock<LoadLaunchBaseTip>(() => {
      // Thrown synchronously, as a backend without the read would.
      if (fail) throw new Error("Unknown backend command");
      return Promise.resolve(tip("d".repeat(40)));
    });
    const { result } = renderHook(() => useLaunchBase({ enabled: true, projectId: "p1", load }));
    await waitFor(() => expect(result.current.state.status).toBe("unavailable"));

    fail = false;
    act(() => result.current.refresh());
    expect(result.current.state).toEqual({ status: "resolving" });
    await waitFor(() => expect(result.current.state).toMatchObject({ commit: "d".repeat(40) }));
  });
});
