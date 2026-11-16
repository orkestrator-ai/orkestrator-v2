import { afterEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, waitFor } from "@testing-library/react";
import { renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import { portalStore } from "@/lib/portal/portal-store";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import { useLinearBuildPipelines } from "./useLinearBuildPipelines";

const target = {
  key: "builder",
  machine: "builder",
  nodeId: "builder",
  name: "Builder",
  projectId: "remote-project",
  current: false,
  available: true,
  hasCheckout: true,
};
const snapshot = buildPipelineFixture({
  id: "remote-pipeline",
  projectId: "remote-project",
  source: { type: "linear", issueId: "issue", issueIdentifier: "ENG-1" },
  phase: "building",
});
const record = { id: snapshot.id, projectId: snapshot.projectId, revision: 7, snapshot };
afterEach(cleanup);

test("reads the owner's project and rehydrates progress after an inactive mount", async () => {
  const routed = spyOn(portalStore, "invokeOnNode").mockResolvedValue([record]);
  try {
    const render = () =>
      renderHookInAppCommandScope(() => useLinearBuildPipelines(new Map(), [target]));
    const first = render();
    await waitFor(() => expect(first.result.current.pipelines.size).toBe(1));
    expect(routed).toHaveBeenCalledWith("builder", "list_build_pipelines", {
      projectId: "remote-project",
    });
    expect(first.result.current.pipelines.get("builder:remote-pipeline")).toMatchObject({
      phase: "building",
      backendRevision: 7,
      buildMachine: target,
    });
    first.unmount();
    routed.mockResolvedValue([
      { ...record, revision: 8, snapshot: { ...snapshot, phase: "complete" } },
    ]);
    const second = render();
    await waitFor(() =>
      expect(second.result.current.pipelines.get("builder:remote-pipeline")?.phase).toBe(
        "complete",
      ),
    );
    expect(second.result.current.unavailable).toBe(false);
  } finally {
    routed.mockRestore();
  }
});

test("an unreadable owner blocks launching instead of erasing the known active build", async () => {
  const routed = spyOn(portalStore, "invokeOnNode").mockResolvedValue([record]);
  try {
    const { result } = renderHookInAppCommandScope(() =>
      useLinearBuildPipelines(new Map(), [target]),
    );
    await waitFor(() => expect(result.current.pipelines.size).toBe(1));
    routed.mockRejectedValue(new Error("Disconnected"));
    await act(async () => {
      await expect(result.current.refresh()).rejects.toThrow("Disconnected");
    });
    expect(result.current.pipelines.size).toBe(1);
    expect(result.current.unavailable).toBe(true);
  } finally {
    routed.mockRestore();
  }
});

test("invalid snapshots and unavailable machines never count as an empty successful read", async () => {
  const routed = spyOn(portalStore, "invokeOnNode").mockResolvedValue([
    { ...record, snapshot: {} },
  ]);
  try {
    const { result, rerender } = renderHookInAppCommandScope(
      ({ available }) => useLinearBuildPipelines(new Map(), [{ ...target, available }]),
      { initialProps: { available: true } },
    );
    await act(async () => {
      await expect(result.current.refresh()).rejects.toThrow("Invalid remote build snapshot");
    });
    expect(result.current.unavailable).toBe(true);
    rerender({ available: false });
    await act(async () => {
      await expect(result.current.refresh()).rejects.toThrow("unavailable");
    });
    expect(result.current.unavailable).toBe(true);
  } finally {
    routed.mockRestore();
  }
});
