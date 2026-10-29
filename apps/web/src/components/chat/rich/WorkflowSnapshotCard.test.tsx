import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import type { WorkflowSnapshotV1 } from "@orkestrator/protocol/workflow-snapshot";
import { TRANSCRIPT_ARTIFACT_COMMANDS } from "@orkestrator/protocol/transcript-artifact-commands";
import { invoke } from "@/lib/native/backend";
import { dispatchResourceChange, resetResourceSync } from "@/lib/resource-sync";
import { TerminalProvider, useTerminalContext } from "@/contexts/TerminalContext";
import { useRichContentViewStore } from "@/stores/richContentViewStore";
import { parseWorkflowTargetRef } from "@/lib/chat/artifact-workflow-links";
import { FRONTEND_RENDER_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { WORKFLOW_INLINE_NODE_LIMIT, WorkflowSnapshotCard } from "./WorkflowSnapshotCard";
import { pinRichViewWithRecovery, resetRichViewPinRecovery } from "./CodeBlockViewer";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

function snapshotFixture(overrides: Partial<WorkflowSnapshotV1> = {}): WorkflowSnapshotV1 {
  return {
    schemaVersion: 1,
    workflowId: "wf1",
    runId: "run1",
    sourceRevision: "rev-7",
    capturedAt: "2026-10-20T10:00:00.000Z",
    title: "Multi review",
    description: "Synthetic snapshot",
    status: "running",
    completeness: {
      mode: "complete",
      totalNodes: 4,
      totalEdges: 4,
      omittedNodes: 0,
      omittedEdges: 0,
    },
    nodes: [
      { id: "input", label: "Package", role: "input", status: "succeeded", links: [] },
      {
        id: "agent-1",
        label: "Reviewer 1",
        role: "agent",
        status: "running",
        attemptId: "attempt-2",
        links: [
          {
            relation: "transcript",
            targetRef: "multi-review:wf1:reviewer:r1",
            label: "Open transcript",
          },
        ],
      },
      {
        id: "review",
        label: "Human gate",
        role: "review",
        status: "unknown",
        rawStatus: "awaiting-human",
        links: [{ relation: "findings", targetRef: "opaque-ref-123", label: "Findings" }],
      },
      {
        id: "validate",
        label: "Validation",
        role: "validation",
        status: "failed",
        validation: { state: "rejected", errorCount: 2 },
        links: [],
      },
    ],
    edges: [
      { id: "e1", from: "input", to: "agent-1", relation: "handoff" },
      { id: "e2", from: "agent-1", to: "review", relation: "review" },
      { id: "e3", from: "review", to: "validate", relation: "dependency" },
      { id: "e4", from: "validate", to: "agent-1", relation: "retry" },
    ],
    ...overrides,
  };
}

function renderCard(snapshot: WorkflowSnapshotV1, wrapper?: (children: ReactNode) => ReactNode) {
  const card = (
    <WorkflowSnapshotCard
      snapshot={snapshot}
      viewKey="wf-view"
      environmentId="env-1"
      liveInspectorPollMs={60_000}
    />
  );
  return render(<>{wrapper ? wrapper(card) : card}</>);
}

function cardNode(container: HTMLElement, id: string): Element {
  const figure = container.querySelector('[data-rich-block="workflow-snapshot"]')!;
  return figure.querySelector(`[data-workflow-node="${id}"]`)!;
}

beforeEach(() => {
  useRichContentViewStore.getState().reset();
  resetRichViewPinRecovery();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  cleanup();
  resetResourceSync();
});

describe("WorkflowSnapshotCard", () => {
  test("is labelled as a snapshot with its capture time and revision", () => {
    const { container } = renderCard(snapshotFixture());
    const figure = container.querySelector('[data-rich-block="workflow-snapshot"]')!;
    expect(figure.textContent).toContain("Snapshot");
    expect(figure.textContent).toContain("Captured 2026-10-20 10:00:00 UTC · revision rev-7");
    expect(container.querySelectorAll("[data-workflow-node]")).toHaveLength(4);
    expect(container.querySelectorAll("[data-workflow-edge]")).toHaveLength(4);
  });

  test("an unknown status stays visibly unknown and is never shown as success", () => {
    const { container } = renderCard(snapshotFixture());
    const node = cardNode(container, "review");
    expect(node.getAttribute("data-workflow-status")).toBe("unknown");
    expect(node.textContent).toContain('Unknown (reported "awaiting-human")');
    expect(node.getAttribute("aria-label")).toContain("status Unknown");
    expect(node.textContent).not.toContain("Succeeded");
  });

  test("summary mode shows an omission notice with the exact totals", () => {
    const snapshot = snapshotFixture({
      completeness: {
        mode: "summary",
        totalNodes: 250,
        totalEdges: 500,
        omittedNodes: 246,
        omittedEdges: 496,
        reason: "size-limit",
      },
    });
    const { container } = renderCard(snapshot);
    const notice = container.querySelector('[data-workflow-omission="true"]')!;
    expect(notice.textContent).toContain("4 of 250 nodes");
    expect(notice.textContent).toContain("4 of 500 edges");
    expect(notice.textContent).toContain("246 nodes and 496 edges omitted by the size limit");
  });

  test("large graphs show a labelled bounded subset and the full inspector shows every node", () => {
    const nodes = Array.from({ length: 60 }, (_, index) => ({
      id: `n${String(index).padStart(2, "0")}`,
      label: `Node ${index}`,
      role: "agent" as const,
      status: "pending" as const,
      links: [],
    }));
    const snapshot = snapshotFixture({
      nodes,
      edges: [],
      completeness: {
        mode: "complete",
        totalNodes: 60,
        totalEdges: 0,
        omittedNodes: 0,
        omittedEdges: 0,
      },
    });
    const { container } = renderCard(snapshot);
    expect(container.querySelector('[data-workflow-subset="true"]')?.textContent).toContain(
      `showing ${WORKFLOW_INLINE_NODE_LIMIT} of 60 captured nodes`,
    );
    expect(container.querySelectorAll("[data-workflow-node]")).toHaveLength(
      WORKFLOW_INLINE_NODE_LIMIT,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Open full inspector" })[0]!);
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelectorAll("[data-workflow-node]")).toHaveLength(60);
  });

  test("the table alternative lists every node with its status", () => {
    renderCard(snapshotFixture());
    fireEvent.click(screen.getByRole("button", { name: "Table view" }));
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[3]!.textContent).toContain("rejected (2 errors)");
  });

  test("node links navigate through the existing viewer for recognized references only", () => {
    const createTab = mock(() => true);
    function Register({ children }: { children: ReactNode }) {
      const { setCreateTab } = useTerminalContext();
      useEffect(() => {
        setCreateTab(createTab);
      }, [setCreateTab]);
      return <>{children}</>;
    }
    const { container } = renderCard(snapshotFixture(), (card) => (
      <TerminalProvider>
        <Register>{card}</Register>
      </TerminalProvider>
    ));
    fireEvent.click(cardNode(container, "agent-1"));
    fireEvent.click(screen.getByRole("button", { name: "Open transcript" }));
    expect(createTab).toHaveBeenCalledWith("multi-review", {
      multiReviewId: "wf1",
      multiReviewReviewerId: "r1",
      displayTitle: "Multi review · Reviewer 1",
    });
    fireEvent.click(cardNode(container, "review"));
    const opaque = screen.getByRole("button", { name: /Findings \(not available here\)/ });
    expect((opaque as HTMLButtonElement).disabled).toBe(true);
  });

  test("target references never become paths or URLs", () => {
    expect(parseWorkflowTargetRef("multi-review:wf1")).toEqual({
      kind: "multi-review",
      workflowId: "wf1",
    });
    // Looped Review was removed; its old references no longer resolve.
    expect(parseWorkflowTargetRef("looped-review:lr1")).toBeNull();
    expect(parseWorkflowTargetRef("https://example.com")).toBeNull();
    expect(parseWorkflowTargetRef("multi-review:../etc")).toBeNull();
    expect(parseWorkflowTargetRef("multi-review:wf1:other:x")).toBeNull();
  });
});

describe("WorkflowLiveInspector", () => {
  function liveResponse(snapshot: WorkflowSnapshotV1, terminal = false) {
    return { status: "available", snapshot, terminal };
  }

  test("live data never overwrites the historical card", async () => {
    const progressed = snapshotFixture({
      sourceRevision: "rev-9",
      status: "succeeded",
      nodes: snapshotFixture().nodes.map((node) =>
        node.id === "agent-1" ? { ...node, status: "succeeded" } : node,
      ),
    });
    invokeMock.mockImplementation((command: string) =>
      command === TRANSCRIPT_ARTIFACT_COMMANDS.workflowLiveSnapshot
        ? Promise.resolve(liveResponse(progressed, true))
        : Promise.resolve(),
    );
    const snapshot = snapshotFixture();
    const before = structuredClone(snapshot);
    const { container } = renderCard(snapshot);
    fireEvent.click(screen.getByRole("button", { name: /Open live workflow/ }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(
        dialog
          .querySelector("[data-workflow-live-phase]")
          ?.getAttribute("data-workflow-live-phase"),
      ).toBe("terminal"),
    );
    expect(
      dialog.querySelector('[data-workflow-node="agent-1"]')?.getAttribute("data-workflow-status"),
    ).toBe("succeeded");
    expect(cardNode(container, "agent-1").getAttribute("data-workflow-status")).toBe("running");
    expect(snapshot).toEqual(before);
    expect(invokeMock).toHaveBeenCalledWith(TRANSCRIPT_ARTIFACT_COMMANDS.workflowLiveSnapshot, {
      environmentId: "env-1",
      workflowId: "wf1",
      runId: "run1",
    });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    expect(cardNode(container, "agent-1").getAttribute("data-workflow-status")).toBe("running");
  });

  test("a deleted run shows live data unavailable while the snapshot stays", async () => {
    invokeMock.mockImplementation(() =>
      Promise.resolve({ status: "unavailable", reason: "deleted", message: "gone" }),
    );
    const { container } = renderCard(snapshotFixture());
    fireEvent.click(screen.getByRole("button", { name: /Open live workflow/ }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.textContent).toContain("Live data unavailable"));
    expect(dialog.textContent).toContain("saved snapshot in the transcript is unchanged");
    expect(
      container.querySelectorAll('[data-rich-block="workflow-snapshot"] [data-workflow-node]'),
    ).toHaveLength(4);
  });

  test("reconciles on resource events, ignores stale responses and reports offline", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const rejecters: Array<(error: unknown) => void> = [];
    invokeMock.mockImplementation(
      (command: string) =>
        new Promise((resolve, reject) => {
          if (command !== TRANSCRIPT_ARTIFACT_COMMANDS.workflowLiveSnapshot)
            return resolve(undefined);
          resolvers.push(resolve);
          rejecters.push(reject);
        }),
    );
    renderCard(snapshotFixture());
    fireEvent.click(screen.getByRole("button", { name: /Open live workflow/ }));
    const dialog = await screen.findByRole("dialog");
    expect(
      dialog.querySelector("[data-workflow-live-phase]")?.getAttribute("data-workflow-live-phase"),
    ).toBe("connecting");
    await waitFor(() => expect(resolvers).toHaveLength(1));

    // A change announcement for this workflow triggers a second, newer read.
    act(() =>
      dispatchResourceChange({ resource: "multi-review", id: "wf1", revision: 2 } as never),
    );
    await waitFor(() => expect(resolvers).toHaveLength(2), { timeout: 2_000 });

    const newer = snapshotFixture({ sourceRevision: "rev-newer" });
    const older = snapshotFixture({ sourceRevision: "rev-older" });
    await act(async () => resolvers[1]!(liveResponse(newer)));
    await act(async () => resolvers[0]!(liveResponse(older)));
    await waitFor(() => expect(dialog.textContent).toContain("revision rev-newer"));
    expect(dialog.textContent).not.toContain("rev-older");

    // Two failed reads mark the view stale/offline while keeping the last live data.
    fireEvent.click(within(dialog).getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(rejecters).toHaveLength(3));
    await act(async () => rejecters[2]!(new Error("offline")));
    fireEvent.click(within(dialog).getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(rejecters).toHaveLength(4));
    await act(async () => rejecters[3]!(new Error("offline")));
    await waitFor(() =>
      expect(
        dialog
          .querySelector("[data-workflow-live-phase]")
          ?.getAttribute("data-workflow-live-phase"),
      ).toBe("stale"),
    );
    expect(dialog.textContent).toContain("revision rev-newer");
  });
});

describe("WorkflowSnapshotCard — pin displacement", () => {
  test("a displaced full inspector offers Reopen instead of silently closing", () => {
    const { container, unmount } = renderCard(snapshotFixture());
    fireEvent.click(screen.getByRole("button", { name: "Table view" }));
    fireEvent.click(screen.getByRole("button", { name: "Open full inspector" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    act(() => {
      for (let index = 0; index < FRONTEND_RENDER_POLICY.maxPinnedViewStateEntries; index++)
        pinRichViewWithRecovery(`other-workflow-${index}`);
    });
    expect(screen.queryByRole("dialog") === null).toBe(true);
    expect(container.querySelector("[data-rich-pin-displaced]")?.textContent).toContain(
      "full inspector was closed",
    );

    // The affordance survives scrolling away and back.
    unmount();
    const remounted = renderCard(snapshotFixture());
    const notice = remounted.container.querySelector("[data-rich-pin-displaced]") as HTMLElement;
    fireEvent.click(within(notice).getByRole("button", { name: /Reopen/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    // The table choice made before displacement is still the card's view.
    expect(useRichContentViewStore.getState().entries.get("wf-view")?.view).toBe("data");
    expect(remounted.container.querySelector("[data-rich-pin-displaced]") === null).toBe(true);
  });
});
