import { afterEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, waitFor } from "@testing-library/react";
import { renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import { portalStore } from "@/lib/portal/portal-store";
import { useBuildNetworkPreference } from "./useBuildNetworkPreference";

afterEach(cleanup);

test("reopening invalidates the previous answer and a late answer cannot replace the selected machine", async () => {
  const pending: Array<(config: unknown) => void> = [];
  const routed = spyOn(portalStore, "invokeOnNode").mockImplementation(
    (() =>
      new Promise<unknown>((resolve) =>
        pending.push(resolve),
      )) as unknown as typeof portalStore.invokeOnNode,
  );
  const target = {
    machine: "builder",
    nodeId: "builder",
    name: "Builder",
    projectId: "remote-project",
  };
  try {
    const { result, rerender } = renderHookInAppCommandScope(
      ({ machine, open }) => useBuildNetworkPreference({ ...target, machine }, open, "full"),
      { initialProps: { machine: "builder", open: true } },
    );
    expect(result.current.pending).toBe(true);
    await act(async () =>
      pending[0]!({
        repositories: { "remote-project": { lastBuildNetworkAccessMode: "restricted" } },
      }),
    );
    expect(result.current.mode).toBe("restricted");
    rerender({ machine: "builder", open: false });
    rerender({ machine: "builder", open: true });
    expect(result.current.pending).toBe(true);
    rerender({ machine: "other", open: true });
    await act(async () => pending[2]!({ repositories: {} }));
    expect(result.current.mode).toBe("full");
    await act(async () =>
      pending[1]!({
        repositories: { "remote-project": { lastBuildNetworkAccessMode: "restricted" } },
      }),
    );
    expect(result.current.mode).toBe("full");
  } finally {
    routed.mockRestore();
  }
});

test("an unreadable config is an error rather than an unsaved Full default", async () => {
  const routed = spyOn(portalStore, "invokeOnNode").mockResolvedValue(undefined);
  try {
    const { result } = renderHookInAppCommandScope(() =>
      useBuildNetworkPreference(
        { machine: "builder", nodeId: "builder", name: "Builder", projectId: "remote" },
        true,
        "full",
      ),
    );
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.mode).toBeUndefined();
    expect(result.current.pending).toBe(false);
  } finally {
    routed.mockRestore();
  }
});

test("the current machine uses its configured default without a remote read", () => {
  const routed = spyOn(portalStore, "invokeOnNode");
  try {
    const { result } = renderHookInAppCommandScope(() =>
      useBuildNetworkPreference(undefined, true, "restricted"),
    );
    expect(result.current.mode).toBe("restricted");
    expect(result.current.pending).toBe(false);
    expect(routed).not.toHaveBeenCalled();
  } finally {
    routed.mockRestore();
  }
});
