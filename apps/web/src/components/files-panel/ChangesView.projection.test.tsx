import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import type { ChangesGetFilesResult } from "@orkestrator/protocol/change-resources";
import { TerminalProvider, useTerminalContext } from "@/contexts";
import { invoke } from "@/lib/native/backend";
import { resetChangeSubscriptionsForTests } from "@/lib/changes/subscriptions";
import { useFilesPanelStore } from "@/stores";
import { useChangeProjectionStore } from "@/stores/changeProjectionStore";
import type { Environment } from "@/types";
import { EnvironmentItem } from "@/components/environments/EnvironmentItem";
import { restoreMatchMedia, setMobileViewport } from "../../../../../tests/mocks/match-media";
import {
  environmentProjectionFixture,
  exactCount,
  fileRowFixture,
  notApplicableCount,
  resetChangeProjectionStore,
  unknownCount,
} from "./change-projection-test-fixture";
import { ChangesView } from "./ChangesView";
import { FilesPanelHeader } from "./FilesPanelHeader";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const RESOURCE_KEY = "environment-net/environment/env-1/live";
const createFileTab = mock((_path: string, _options?: unknown) => undefined);

function RegisterFileTab() {
  const { setCreateFileTab } = useTerminalContext();
  useEffect(() => {
    setCreateFileTab(createFileTab);
    return () => setCreateFileTab(null);
  }, [setCreateFileTab]);
  return null;
}

function renderChanges(props: Partial<Parameters<typeof ChangesView>[0]> = {}) {
  return render(
    <TerminalProvider>
      <RegisterFileTab />
      <ChangesView environmentId="env-1" {...props} />
    </TerminalProvider>,
  );
}

function rowTexts(): string[] {
  return screen
    .queryAllByTestId("change-file-row")
    .map((row) => row.getAttribute("data-row-id") ?? "");
}

/** Routes `changes_*` commands; everything else answers like an older backend. */
function installBackend(routes: {
  view?: () => unknown;
  files?: (args: Record<string, unknown>) => ChangesGetFilesResult;
}) {
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "changes_get_view" && routes.view) return routes.view();
    if (command === "changes_get_files" && routes.files) return routes.files(args);
    throw new Error(`unexpected command ${command}`);
  });
}

describe("ChangesView on the environment change projection", () => {
  beforeEach(() => {
    resetChangeSubscriptionsForTests();
    resetChangeProjectionStore();
    createFileTab.mockClear();
    invokeMock.mockReset();
    installBackend({});
    setMobileViewport(false);
    useFilesPanelStore.setState({
      isOpen: true,
      activeTab: "changes",
      changes: [],
      isLoadingChanges: false,
    });
  });

  afterEach(() => {
    cleanup();
    restoreMatchMedia();
  });

  test("renders status, renames, count quality and reasons, and opens a live change diff", () => {
    const onRevert = mock((_path: string) => undefined);
    useChangeProjectionStore.getState().applyProjection(
      environmentProjectionFixture("env-1", {
        revision: 7,
        filePage: {
          snapshotToken: "token-1",
          totalRows: 4,
          nextCursor: null,
          rows: [
            fileRowFixture("src/a.ts", { additions: exactCount(5), deletions: exactCount(2) }),
            fileRowFixture("src/new-name.ts", {
              status: "renamed",
              oldPathDisplay: "src/old-name.ts",
              additions: exactCount(0),
              deletions: exactCount(0),
            }),
            fileRowFixture("assets/logo.png", {
              fileKind: "binary",
              additions: notApplicableCount(),
              deletions: notApplicableCount(),
            }),
            fileRowFixture("big.log", {
              status: "added",
              additions: unknownCount(),
              deletions: exactCount(0),
              reasonKey: "changes.reason.count-omitted",
            }),
          ],
        },
      }),
    );
    renderChanges({ onRevert });

    const rows = screen.getAllByTestId("change-file-row");
    expect(rows).toHaveLength(4);
    const counts = rows.map((row) => within(row).getByTestId("change-row-counts").textContent);
    expect(counts).toEqual(["+5-2", "", "binary", "+?"]);
    expect(rows[0]!.textContent).toContain("M");
    // The path renders with one separator between directory and filename.
    expect(within(rows[0]!).getByText("src").textContent).toBe("src");
    expect(rows[0]!.textContent).toContain("src/a.ts");
    expect(within(rows[1]!).getByTestId("change-row-renamed-from").textContent).toBe(
      "from src/old-name.ts",
    );
    expect(rows[1]!.getAttribute("title")).toBe("src/old-name.ts → src/new-name.ts");
    expect(within(rows[3]!).getByTestId("change-row-reason").textContent).toBe(
      "Some files were too large or unreadable to count",
    );
    expect(rows[3]!.textContent).not.toContain("+0");

    fireEvent.click(rows[1]!);
    expect(createFileTab).toHaveBeenCalledWith("src/new-name.ts", {
      isDiff: true,
      gitStatus: "R",
      changeDiff: {
        kind: "live",
        resourceKey: RESOURCE_KEY,
        pathId: "p:src/new-name.ts",
        rowId: "m-1:src/new-name.ts",
        revision: 7,
        title: "new-name.ts",
      },
    });

    // Row actions keep working with the row's path.
    fireEvent.contextMenu(rows[0]!);
    fireEvent.click(screen.getByRole("menuitem", { name: /Revert/ }));
    expect(onRevert).toHaveBeenCalledWith("src/a.ts");
  });

  test("the sidebar badge and the Changes rows show one measurement", () => {
    useChangeProjectionStore
      .getState()
      .applyProjection(environmentProjectionFixture("env-1", { measurementId: "m-shared" }));
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
    const noop = () => undefined;
    render(
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
        <ChangesView environmentId="env-1" />
      </TerminalProvider>,
    );
    const badgeMeasurement = screen
      .getByTestId("environment-change-badge")
      .getAttribute("data-measurement-id");
    const rowsMeasurement = screen.getByTestId("change-rows").getAttribute("data-measurement-id");
    expect(badgeMeasurement).toBe("m-shared");
    expect(rowsMeasurement).toBe(badgeMeasurement);
  });

  test("pages further within one snapshot token", async () => {
    useChangeProjectionStore.getState().applyProjection(
      environmentProjectionFixture("env-1", {
        filePage: {
          snapshotToken: "token-1",
          rows: [fileRowFixture("a.ts")],
          nextCursor: "cursor-1",
          totalRows: 2,
        },
      }),
    );
    const requests: Array<Record<string, unknown>> = [];
    installBackend({
      files: (args) => {
        requests.push(args);
        return {
          kind: "page",
          snapshotToken: "token-1",
          rows: [fileRowFixture("b.ts")],
          nextCursor: null,
          totalRows: 2,
          deliveredRows: 2,
        };
      },
    });
    renderChanges();
    expect(rowTexts()).toEqual(["m-1:a.ts"]);

    fireEvent.click(screen.getByRole("button", { name: "Show more files (1 of 2)" }));
    await waitFor(() => expect(rowTexts()).toEqual(["m-1:a.ts", "m-1:b.ts"]));
    expect(requests).toEqual([
      { resourceKey: RESOURCE_KEY, snapshotToken: "token-1", cursor: "cursor-1", pageSize: 200 },
    ]);
    expect(screen.queryByRole("button", { name: /Show more files/ }) === null).toBe(true);
  });

  test("a stale cursor re-reads the projection and restarts paging without stitching", async () => {
    useChangeProjectionStore.getState().applyProjection(
      environmentProjectionFixture("env-1", {
        filePage: {
          snapshotToken: "token-1",
          rows: [fileRowFixture("old-1.ts")],
          nextCursor: "cursor-1",
          totalRows: 2,
        },
      }),
    );
    let viewReads = 0;
    let measurementMoved = false;
    installBackend({
      files: () => {
        // The measurement moved on between the first page and this request.
        measurementMoved = true;
        return {
          kind: "error",
          error: { code: "stale-cursor", reasonKey: "changes.error.stale-cursor" },
        };
      },
      view: () => {
        if (!measurementMoved) return { kind: "unchanged", ownerGeneration: "gen-1", revision: 1 };
        viewReads += 1;
        return {
          kind: "projection",
          projection: environmentProjectionFixture("env-1", {
            revision: 2,
            measurementId: "m-2",
            filePage: {
              snapshotToken: "token-2",
              rows: [fileRowFixture("new-1.ts", { rowId: "m-2:new-1.ts" })],
              nextCursor: null,
              totalRows: 1,
            },
          }),
        };
      },
    });
    renderChanges();
    await act(async () => {
      await Promise.resolve();
    });
    expect(rowTexts()).toEqual(["m-1:old-1.ts"]);

    fireEvent.click(screen.getByRole("button", { name: /Show more files/ }));
    await waitFor(() => expect(rowTexts()).toEqual(["m-2:new-1.ts"]));
    expect(viewReads).toBe(1);
    expect(screen.getByTestId("change-rows").getAttribute("data-measurement-id")).toBe("m-2");
    expect(screen.queryByRole("button", { name: /Show more files/ }) === null).toBe(true);
  });

  test("a measurement delivered by an event without a page reads its first page", async () => {
    installBackend({
      view: () => ({
        kind: "projection",
        projection: environmentProjectionFixture("env-1", { revision: 3 }),
      }),
    });
    useChangeProjectionStore
      .getState()
      .applyProjection(environmentProjectionFixture("env-1", { revision: 3, filePage: null }));
    renderChanges();
    await waitFor(() => expect(rowTexts()).toEqual(["m-1:src/a.ts", "m-1:src/b.ts"]));
  });

  test("a projection that measured no changes says so", () => {
    useChangeProjectionStore.getState().applyProjection(
      environmentProjectionFixture("env-1", {
        hasFileChanges: false,
        badge: { visible: false, mode: "none" },
        counters: { additions: exactCount(0), deletions: exactCount(0), changedFiles: 0 },
        filePage: { snapshotToken: "token-1", rows: [], nextCursor: null, totalRows: 0 },
      }),
    );
    renderChanges();
    expect(screen.getByText("No changes")).toBeTruthy();
  });

  test("an unavailable projection shows its reason instead of an empty list", () => {
    useChangeProjectionStore.getState().applyProjection(
      environmentProjectionFixture("env-1", {
        measurementId: null,
        state: "unavailable",
        availability: "unavailable",
        hasFileChanges: null,
        reasonKeys: ["changes.reason.scan-failed"],
        filePage: null,
      }),
    );
    renderChanges();
    expect(screen.getByText("Changes unavailable")).toBeTruthy();
    expect(screen.getByText("Could not read the workspace")).toBeTruthy();
  });

  test("the Changes tab counts the projection's files; an unknown count is ?", () => {
    useChangeProjectionStore.getState().applyProjection(environmentProjectionFixture("env-1"));
    const view = render(
      <FilesPanelHeader onRefresh={() => undefined} changeEnvironmentId="env-1" />,
    );
    expect(screen.getByRole("tab", { name: /Changes/ }).textContent).toBe("Changes2");
    view.unmount();

    useChangeProjectionStore.getState().applyProjection(
      environmentProjectionFixture("env-1", {
        revision: 2,
        state: "partial",
        badge: { visible: true, mode: "unknown" },
        counters: { additions: unknownCount(), deletions: unknownCount(), changedFiles: null },
      }),
    );
    render(<FilesPanelHeader onRefresh={() => undefined} changeEnvironmentId="env-1" />);
    expect(screen.getByRole("tab", { name: /Changes/ }).textContent).toBe("Changes?");
  });

  test("without a projection (older backend) the legacy list is shown", async () => {
    act(() =>
      useFilesPanelStore.setState({
        changes: [
          {
            path: "src/App.tsx",
            filename: "App.tsx",
            directory: "src",
            status: "M",
            additions: 2,
            deletions: 1,
          },
        ],
      }),
    );
    renderChanges();
    await waitFor(() => expect(screen.getByTitle("src/App.tsx")).toBeTruthy());
    expect(screen.queryByTestId("change-rows") === null).toBe(true);
  });
});
