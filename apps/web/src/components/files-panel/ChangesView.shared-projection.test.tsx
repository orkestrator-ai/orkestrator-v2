import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  CHANGE_PROJECTION_CHANGED_EVENT,
  type ChangeProjection,
} from "@orkestrator/protocol/change-resources";
import { TerminalProvider } from "@/contexts";
import { EnvironmentItem } from "@/components/environments/EnvironmentItem";
import { invoke } from "@/lib/native/backend";
import { listen } from "@/lib/native/events";
import { resetChangeSubscriptionsForTests } from "@/lib/changes/subscriptions";
import { useFilesPanelStore } from "@/stores";
import type { Environment } from "@/types";
import { restoreMatchMedia, setMobileViewport } from "../../../../../tests/mocks/match-media";
import {
  environmentProjectionFixture,
  exactCount,
  fileRowFixture,
  resetChangeProjectionStore,
} from "./change-projection-test-fixture";
import { ChangesView } from "./ChangesView";
import { FilesPanelHeader } from "./FilesPanelHeader";

// `@/lib/native/backend` and `@/lib/native/events` are mocked in tests/setup.ts.
const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const listenMock = listen as unknown as ReturnType<typeof mock>;

const environment = {
  id: "env-1",
  projectId: "project-1",
  name: "shared",
  branch: "main",
  containerId: null,
  status: "running",
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
  createdAt: "2026-10-20T00:00:00.000Z",
  networkAccessMode: "restricted",
  order: 0,
  environmentType: "local",
} as Environment;

function renderSurfaces() {
  const noop = () => undefined;
  return render(
    <TerminalProvider>
      <EnvironmentItem
        environment={environment}
        isSelected={false}
        onSelect={noop}
        onDelete={noop}
        onStart={noop}
        onStop={noop}
        onRestart={noop}
      />
      <FilesPanelHeader onRefresh={noop} changeEnvironmentId="env-1" />
      <ChangesView environmentId="env-1" />
    </TerminalProvider>,
  );
}

function surfaces() {
  const badge = screen.getByTestId("environment-change-badge");
  const rows = screen.getByTestId("change-rows");
  return {
    badgeMeasurement: badge.getAttribute("data-measurement-id"),
    badgeCounts: screen.getByTestId("environment-change-counts").textContent,
    rowsMeasurement: rows.getAttribute("data-measurement-id"),
    rowIds: screen.getAllByTestId("change-file-row").map((row) => row.getAttribute("data-row-id")),
    tab: screen.getByRole("tab", { name: /Changes/ }).textContent,
  };
}

describe("V01: one backend projection across the sidebar badge and Files → Changes", () => {
  let emitChange: ((event: { payload: unknown }) => void) | null;
  let served: ChangeProjection;
  let reads: Array<Record<string, unknown>>;

  beforeEach(() => {
    resetChangeSubscriptionsForTests();
    resetChangeProjectionStore();
    setMobileViewport(false);
    useFilesPanelStore.setState({
      isOpen: true,
      activeTab: "changes",
      changes: [],
      isLoadingChanges: false,
    });
    emitChange = null;
    reads = [];
    listenMock.mockReset();
    listenMock.mockImplementation(async (event: string, callback) => {
      if (event === CHANGE_PROJECTION_CHANGED_EVENT) emitChange = callback;
      return () => undefined;
    });
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command !== "changes_get_view") throw new Error(`unexpected command ${command}`);
      reads.push(args);
      return { kind: "projection", projection: served };
    });
  });

  afterEach(() => {
    cleanup();
    restoreMatchMedia();
    listenMock.mockReset();
    listenMock.mockImplementation(() => Promise.resolve(() => undefined));
    invokeMock.mockReset();
  });

  test("V01: every surface renders the one backend read, in backend order, and moves together", async () => {
    // Partial counts and a backend file order that is not alphabetical: no
    // surface may re-sort, re-sum or drop the quality mark.
    served = environmentProjectionFixture("env-1", {
      measurementId: "m-1",
      state: "partial",
      coverageState: "partial",
      counters: {
        additions: { value: 12, quality: "partial", bound: "none" },
        deletions: exactCount(3),
        changedFiles: 2,
      },
      filePage: {
        snapshotToken: "token-1",
        rows: [
          fileRowFixture("src/z.ts", { rowId: "m-1:z", additions: exactCount(1) }),
          fileRowFixture("src/a.ts", { rowId: "m-1:a", additions: exactCount(1) }),
        ],
        nextCursor: null,
        totalRows: 2,
      },
    });
    renderSurfaces();
    await waitFor(() => expect(screen.getByTestId("change-rows")).toBeTruthy());

    // Three consumers mounted together share a single read.
    expect(reads).toEqual([{ resourceKey: served.resourceKey }]);
    const first = surfaces();
    expect(first.badgeMeasurement).toBe("m-1");
    expect(first.rowsMeasurement).toBe("m-1");
    expect(first.badgeCounts).toBe("~+12-3");
    expect(first.rowIds).toEqual(["m-1:z", "m-1:a"]);
    expect(first.tab).toBe("Changes2");

    // The next measurement arrives as an event without a file page; the rows
    // fetch the page of that same revision, and every surface follows.
    served = environmentProjectionFixture("env-1", {
      revision: 2,
      measurementId: "m-2",
      counters: { additions: exactCount(4), deletions: exactCount(0), changedFiles: 1 },
      filePage: {
        snapshotToken: "token-2",
        rows: [fileRowFixture("src/n.ts", { rowId: "m-2:n", additions: exactCount(4) })],
        nextCursor: null,
        totalRows: 1,
      },
    });
    act(() => {
      emitChange!({ payload: { kind: "projection", projection: { ...served, filePage: null } } });
    });
    await waitFor(() =>
      expect(screen.getByTestId("change-rows").dataset.measurementId).toBe("m-2"),
    );
    const second = surfaces();
    expect(second.badgeMeasurement).toBe("m-2");
    expect(second.badgeCounts).toBe("+4-0");
    expect(second.rowIds).toEqual(["m-2:n"]);
    expect(second.tab).toBe("Changes1");
  });
});
