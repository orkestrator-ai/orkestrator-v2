/**
 * The panel's tab groups across a failed first read (#2152): a read that
 * fails must never let the panel's default single group replace the groups
 * the backend holds, now or on the next visit.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, waitFor } from "@testing-library/react";
import type { CoordinatorSnapshot } from "@orkestrator/protocol/coordinator";
import type {
  CoordinatorPaneLayout,
  CoordinatorPaneLayoutRecord,
} from "@orkestrator/protocol/coordinator-pane-layout";
import { resetClientStateCapabilitiesForTests } from "@/lib/client-state-capabilities";
import {
  collectCoordinatorLeaves,
  reconcileCoordinatorLayout,
  splitCoordinatorPaneAtEdge,
} from "@/lib/coordinator-pane-layout";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { requestResourceResync } from "@/lib/resource-sync";
import {
  coordinatorPaneLayoutStore,
  LEGACY_COORDINATOR_LAYOUT_KEY,
} from "@/stores/coordinatorPaneLayoutStore";
import { appCommandStore } from "@/test/app-command-store";
import { renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import { useCoordinatorSelection } from "./useCoordinatorSelection";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;
const PROJECT = "p";
const IDS = ["main", "side-1", "side-2"];

// Only what the hook reads: that a snapshot exists, and its selection.
const snapshot = { workspace: { selectedConversationId: "main" } } as CoordinatorSnapshot;

/** Two groups: the main and Side 1 on the left, Side 2 on its own on the right. */
function twoGroups(): CoordinatorPaneLayout {
  const one = reconcileCoordinatorLayout(null, IDS);
  return splitCoordinatorPaneAtEdge(one, one.activePaneId, "right", "side-2", one.activePaneId);
}

const groups = (layout: CoordinatorPaneLayout | undefined | null) =>
  layout ? collectCoordinatorLeaves(layout.root).map((pane) => pane.conversationIds) : null;

/** The backend's layout record, compare-and-swap on the revision; reads can be failed. */
function fakeBackend() {
  let record: CoordinatorPaneLayoutRecord | null = null;
  const saves: number[] = [];
  const fail = { layoutReads: 0 };
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "get_coordinator_pane_layout") {
      if (fail.layoutReads > 0) {
        fail.layoutReads -= 1;
        throw new Error("transport closed");
      }
      return record;
    }
    if (command === "save_coordinator_pane_layout") {
      const expectedRevision = args.expectedRevision as number;
      saves.push(expectedRevision);
      if ((record?.revision ?? 0) !== expectedRevision) {
        return { status: "conflict", current: record };
      }
      record = {
        projectId: PROJECT,
        layout: args.layout as CoordinatorPaneLayout,
        revision: expectedRevision + 1,
        updatedAt: new Date(0).toISOString(),
      };
      return { status: "saved", record };
    }
    return undefined;
  });
  return {
    fail,
    saves,
    stored: () => record,
    seed(layout: CoordinatorPaneLayout) {
      record = { projectId: PROJECT, layout, revision: 3, updatedAt: new Date(0).toISOString() };
    },
  };
}

function renderPanelSelection() {
  return renderHookInAppCommandScope(() =>
    useCoordinatorSelection({
      projectId: PROJECT,
      snapshot,
      conversationIds: IDS,
      setSnapshot: () => {},
      invalidateView: () => {},
      setError: () => {},
    }),
  );
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  localStorage.removeItem(LEGACY_COORDINATOR_LAYOUT_KEY);
  appCommandStore(coordinatorPaneLayoutStore).getState().reset();
  resetClientStateCapabilitiesForTests();
});

afterEach(() => {
  cleanup();
  appCommandStore(coordinatorPaneLayoutStore).getState().reset();
  localStorage.removeItem(LEGACY_COORDINATOR_LAYOUT_KEY);
  resetClientStateCapabilitiesForTests();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("tab groups across a failed first read", () => {
  test("a failed layout read shows no groups, and a resync reads the stored ones", async () => {
    const server = fakeBackend();
    server.seed(twoGroups());
    server.fail.layoutReads = 1;

    const view = renderPanelSelection();
    await settle();
    expect(view.result.current.layout).toBeNull();
    expect(server.saves).toEqual([]);

    act(() => requestResourceResync());
    await waitFor(() => expect(view.result.current.layout).not.toBeNull());
    await settle();
    expect(groups(view.result.current.layout)).toEqual([["main", "side-1"], ["side-2"]]);
    expect(server.stored()?.revision).toBe(3);
  });

  test("with nothing stored, the first successful read still saves the default group", async () => {
    const server = fakeBackend();
    const view = renderPanelSelection();
    await waitFor(() => expect(view.result.current.layout).not.toBeNull());
    await settle();
    expect(groups(view.result.current.layout)).toEqual([IDS]);
    expect(groups(server.stored()?.layout)).toEqual([IDS]);
  });
});
