import { toNodeEnvironmentSummary } from "@orkestrator/protocol/node-summaries";
/**
 * What another machine's rows and project headers show now that they share
 * this window's components: agent-mail badges, the project home's activity,
 * and the activity list's controls bar. The facts-level parity of a row is
 * pinned by `environment-row-model.parity.test.ts`.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
  type BackendId,
} from "@orkestrator/protocol/federation";
import type { MachineView } from "@/lib/federation/aggregate";
import type { FederatedEnvironment } from "@/lib/federation/summaries";
import { EnvironmentRow } from "@/components/environments/EnvironmentRow";
import { nodeEnvironmentRowFacts } from "@/components/environments/environment-row-facts";
import { useHoverTooltip } from "@/components/ui/hover-tooltip";
import { portalStore } from "@/lib/portal/portal-store";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { configStore } from "@/stores/configStore";
import { uiStore } from "@/stores/uiStore";
import {
  connectionList,
  installDesktopFake,
  remoteConnection,
  sharedIdDataset,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import { mockWriteText } from "../../../../../tests/mocks/clipboard";
import { FederatedActivityList } from "./FederatedSidebarSections";
import { FederationProvider } from "./FederationProvider";
import { RemoteEnvironmentItem, RemoteProjectGroup } from "./RemoteMachineTree";
import { appCommandStore } from "@/test/app-command-store";

const initialUI = appCommandStore(uiStore).getState();
const initialRemote = useRemoteWorkspaceStore.getState();
const initialMachines = useMachineViewStore.getState();

beforeEach(() => {
  sessionStorage.clear();
  useMachineViewStore.setState(initialMachines, true);
  useRemoteWorkspaceStore.setState(initialRemote, true);
});

afterEach(() => {
  cleanup();
  uninstallDesktopFake();
  appCommandStore(uiStore).setState(initialUI, true);
  useRemoteWorkspaceStore.setState(initialRemote, true);
  useMachineViewStore.setState(initialMachines, true);
});

const backendId = "bk_a" as BackendId;

function environment(
  id: string,
  overrides: Partial<FederatedEnvironment> = {},
): FederatedEnvironment {
  const ref = environmentRef(backendId, id);
  return {
    ref,
    key: environmentKey(ref),
    projectId: "project-1",
    name: id,
    order: 0,
    status: "running",
    activity: "idle",
    hasUnreadWork: false,
    deleting: false,
    isProjectHome: false,
    ...overrides,
  };
}

function machineView(environments: FederatedEnvironment[]): MachineView {
  const ref = projectRef(backendId, "project-1");
  return {
    connectionId: "a",
    backendId,
    name: "Machine A",
    colorToken: "teal",
    bound: false,
    freshness: "current",
    transport: "connected",
    projects: [{ ref, key: projectKey(ref), name: "app", order: 0 }],
    environmentsByProject: new Map([["project-1", environments]]),
    truncated: false,
    loadedAt: 1,
  };
}

function renderWithFederation(node: ReactNode) {
  installDesktopFake({
    list: connectionList([remoteConnection("a", "Machine A", "teal")]),
    datasets: { a: sharedIdDataset("working") },
  });
  return render(<FederationProvider>{node}</FederationProvider>);
}

test("a row whose delete failed says why and offers a retry instead of spinning", () => {
  const row = environment("feature", {
    deleting: true,
    deleteFailure: "Terminal process trees are running",
  });
  const { container } = render(
    <RemoteEnvironmentItem machine={machineView([row])} environment={row} />,
  );
  expect(screen.getByText("Delete failed: Terminal process trees are running")).toBeTruthy();
  expect(container.querySelector(".animate-spin") === null).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(screen.getByRole("alertdialog")).toBeTruthy();
});

test("a delete past two minutes says how long it has been running", () => {
  const started = new Date(Date.now() - 5 * 60_000).toISOString();
  const slow = environment("slow", { deleting: true, deletingSince: started });
  const { container } = render(
    <RemoteEnvironmentItem machine={machineView([slow])} environment={slow} />,
  );
  expect(screen.getByText("Still deleting after 5 min")).toBeTruthy();
  expect(container.querySelector(".animate-spin")).toBeTruthy();
  cleanup();

  const fresh = environment("fresh", { deleting: true, deletingSince: new Date().toISOString() });
  render(<RemoteEnvironmentItem machine={machineView([fresh])} environment={fresh} />);
  expect(screen.queryByText(/Still deleting/) === null).toBe(true);
});

test("a slow delete says which step it is on, when its machine reports one this client knows", () => {
  const started = new Date(Date.now() - 5 * 60_000).toISOString();
  const slow = environment("slow", {
    deleting: true,
    deletingSince: started,
    deletingStep: "worktree",
  });
  render(<RemoteEnvironmentItem machine={machineView([slow])} environment={slow} />);
  expect(screen.getByText("Still deleting after 5 min: removing the worktree")).toBeTruthy();
  cleanup();

  // A step a newer machine added is left out rather than shown raw.
  const newer = environment("newer", {
    deleting: true,
    deletingSince: started,
    deletingStep: "defragmenting" as never,
  });
  render(<RemoteEnvironmentItem machine={machineView([newer])} environment={newer} />);
  expect(screen.getByText("Still deleting after 5 min")).toBeTruthy();
  cleanup();

  // A failed delete shows its failure, not a step.
  const failed = environment("failed", {
    deleting: true,
    deletingSince: started,
    deletingStep: "worktree",
    deleteFailure: "Deletion failed. Retry on the owning machine.",
  });
  render(<RemoteEnvironmentItem machine={machineView([failed])} environment={failed} />);
  expect(screen.queryByText(/Still deleting/) === null).toBe(true);
});

test("another machine's row shows its unread agent mail and a failed delivery", () => {
  const row = environment("feature", { agentMailUnread: 120, agentMailFailed: true });
  render(<RemoteEnvironmentItem machine={machineView([row])} environment={row} />);
  expect(screen.getByLabelText("120 unread agent messages").textContent).toBe("99+");
  expect(screen.getByLabelText("Agent message delivery failed")).toBeTruthy();
});

test("another machine's project header sums its mail and shows its home's activity", async () => {
  const home = environment("home", {
    isProjectHome: true,
    name: "project-home",
    activity: "waiting",
    agentMailUnread: 1,
  });
  const worker = environment("feature", { agentMailUnread: 2, agentMailFailed: true });
  const machine = machineView([home, worker]);
  renderWithFederation(
    <RemoteProjectGroup
      machine={machine}
      project={machine.projects[0]!}
      environments={[worker]}
      isCollapsed={false}
      onToggleCollapse={() => {}}
      sortable={false}
      grouping="machine"
    />,
  );
  await waitFor(() => expect(portalStore.getState().loaded).toBe(true));
  const header = screen.getByRole("button", {
    name: "New environment in app on Machine A",
  }).parentElement!;
  // The home's mail counts toward its project, as this window's mailboxes do.
  expect(within(header).getAllByLabelText("3 unread agent messages")).toHaveLength(1);
  expect(within(header).getByLabelText("Agent message delivery failed")).toBeTruthy();

  fireEvent.click(within(header).getByRole("button", { name: "app Home needs attention" }));
  await waitFor(() =>
    expect(useRemoteWorkspaceStore.getState().requests.a?.request).toMatchObject({
      projectId: "project-1",
      environmentId: "home",
      boardTab: "home",
    }),
  );
});

test("a failed tombstoned remote home cannot be selected", async () => {
  const home = toNodeEnvironmentSummary("a" as BackendId, {
    id: "home",
    projectId: "project-1",
    name: "project-home",
    projectHome: true,
    agentActivityState: "waiting",
    deletionRequestedAt: "2026-11-05",
    deletionError: "private failure",
  })!;
  const machine = machineView([home]);
  renderWithFederation(
    <RemoteProjectGroup
      machine={machine}
      project={machine.projects[0]!}
      environments={[]}
      isCollapsed={false}
      onToggleCollapse={() => {}}
      sortable={false}
      grouping="machine"
    />,
  );
  await waitFor(() => expect(portalStore.getState().loaded).toBe(true));
  expect(screen.queryByRole("button", { name: /Home (working|needs attention)/ }) === null).toBe(
    true,
  );
});

test("a quiet home shows nothing in its project header", async () => {
  const home = environment("home", { isProjectHome: true, name: "project-home" });
  const machine = machineView([home]);
  renderWithFederation(
    <RemoteProjectGroup
      machine={machine}
      project={machine.projects[0]!}
      environments={[]}
      isCollapsed={false}
      onToggleCollapse={() => {}}
      sortable={false}
      grouping="machine"
    />,
  );
  await waitFor(() => expect(portalStore.getState().loaded).toBe(true));
  expect(screen.queryByRole("button", { name: /Home (working|needs attention)/ }) === null).toBe(
    true,
  );
});

test("the cross-machine activity list has the controls bar and home rows this window's has", async () => {
  const machine = machineView([
    environment("home", { isProjectHome: true, name: "project-home", buildActive: true }),
    environment("feature", { hasUnreadWork: true }),
    environment("other"),
  ]);
  renderWithFederation(<FederatedActivityList machines={[machine]} renderBoundRow={() => null} />);
  await waitFor(() => expect(portalStore.getState().loaded).toBe(true));
  const list = screen.getByTestId("federated-activity-list");
  expect(within(list).getByTestId("activity-controls-bar")).toBeTruthy();
  expect(within(list).getByLabelText("2 environments")).toBeTruthy();
  expect(within(list).getByLabelText("1 waiting environment")).toBeTruthy();
  // A working build pipeline on the home reads as working, as on its own machine.
  expect(within(list).getByRole("button", { name: "app Home working" })).toBeTruthy();
  expect(within(list).getAllByTestId("federated-environment-row")).toHaveLength(2);
});

for (const scope of ["remote", "bound", "mixed"] as const) {
  test(`waiting count includes only ${scope} machines`, async () => {
    const remote = machineView([environment("waiting", { hasUnreadWork: true })]);
    const bound = { ...machineView([]), connectionId: "self", bound: true };
    renderWithFederation(
      <FederatedActivityList
        machines={scope === "remote" ? [remote] : scope === "bound" ? [bound] : [bound, remote]}
        boundWaitingCount={3}
        renderBoundRow={() => null}
      />,
    );
    await waitFor(() => expect(portalStore.getState().loaded).toBe(true));
    const count = scope === "remote" ? 1 : scope === "bound" ? 3 : 4;
    expect(
      screen.getByLabelText(`${count} waiting environment${count === 1 ? "" : "s"}`),
    ).toBeTruthy();
  });
}

test("the row's computed description retains work, mail, PR and activity subtitle", () => {
  const row = environment("feature", {
    hasUnreadWork: true,
    agentMailUnread: 2,
    agentMailFailed: true,
    prState: "open",
  });
  render(
    <RemoteEnvironmentItem
      machine={machineView([row])}
      environment={row}
      subtitle="app activity"
    />,
  );
  const button = screen.getByRole("button", { name: "feature, on Machine A, Idle" });
  const description = button
    .getAttribute("aria-describedby")!
    .split(" ")
    .map((id) => document.getElementById(id)!.textContent)
    .join(" ");
  for (const state of [
    "New completed activity",
    "2 unread agent messages",
    "Agent message delivery failed",
    "Pull request open",
    "app activity",
  ]) {
    expect(description).toContain(state);
  }
});

test("deleting without hovering reads remote details and warns about the open PR", async () => {
  const calls: string[] = [];
  installDesktopFake({
    list: connectionList([remoteConnection("a", "Machine A", "teal")]),
    datasets: { a: sharedIdDataset("working") },
    respond: (call) => {
      calls.push(call.command);
      if (call.command === "get_environment")
        return {
          id: "feature",
          name: "feature",
          prUrl: "https://github.com/o/r/pull/1",
        };
    },
  });
  const row = environment("feature");
  render(
    <FederationProvider>
      <RemoteEnvironmentItem machine={machineView([row])} environment={row} />
    </FederationProvider>,
  );
  await waitFor(() => expect(portalStore.getState().loaded).toBe(true));
  expect(calls).not.toContain("get_environment");
  fireEvent.contextMenu(screen.getByRole("button", { name: "feature, on Machine A, Idle" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: /Delete/ }));
  await screen.findByRole("alertdialog");
  await waitFor(() => expect(calls).toContain("get_environment"));
  await screen.findByText("This environment has an associated PR that will remain open.");
});

test("another machine's row copies the environment's ID, not its machine-qualified key", async () => {
  mockWriteText.mockReset();
  mockWriteText.mockResolvedValue(undefined);
  const row = environment("feature");
  render(<RemoteEnvironmentItem machine={machineView([row])} environment={row} />);
  fireEvent.contextMenu(screen.getByRole("button", { name: "feature, on Machine A, Idle" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Copy Environment ID" }));
  expect(mockWriteText).toHaveBeenCalledWith("feature");
});

test("a machine-qualified row describes change counts along with unread work and PR state", () => {
  function Row() {
    const tooltip = useHoverTooltip();
    const row = environment("feature", {
      hasUnreadWork: true,
      agentMailUnread: 2,
      prState: "open",
    });
    return (
      <EnvironmentRow
        facts={nodeEnvironmentRowFacts(
          machineView([row]),
          row,
          { busy: false, writable: true },
          true,
        )}
        selected={false}
        subtitle="app activity"
        onActivate={() => {}}
        actions={{
          openSettings: () => {},
          fork: () => {},
          start: () => {},
          stop: () => {},
          restart: () => {},
          confirmDelete: () => {},
        }}
        tooltip={tooltip}
        tooltipDetails={{}}
        agentSummary={null}
        changes={{
          kind: "legacy",
          stats: { additions: 7, deletions: 3, filesChanged: 2, truncated: false },
          freshness: null,
        }}
      />
    );
  }
  render(<Row />);
  expect(
    screen.getByRole("button", {
      name: "feature, on Machine A, Idle",
      description:
        /New completed activity.*2 unread agent messages.*Pull request open.*app activity.*\+7.*-3/,
    }),
  ).toBeTruthy();
});

for (const state of ["current", "stale", "blocked"] as const) {
  test(`remote row reacts to the checks setting with an unchanged ${state} PR summary`, () => {
    const initialConfig = appCommandStore(configStore).getState().config;
    const row = environment("feature", {
      environmentType: "local",
      prState: "open",
      prHasMergeConflicts: false,
      prMergeability: state === "blocked" ? "blocked" : "unstable",
      prMonitorConfirmed: true,
      prCheckSummary: { passed: 13, total: 14, pending: 0 },
    });
    const machine = machineView([row]);
    if (state === "stale") machine.freshness = "stale";
    try {
      appCommandStore(configStore).getState().updateGlobalConfig({ autoMergeRequireChecks: true });
      render(<RemoteEnvironmentItem machine={machine} environment={row} />);
      const button = screen.getByRole("button", { name: "feature, on Machine A, Idle" });
      // No rerender or summary replacement: only the live config changes.
      for (const requireChecks of [true, false, true]) {
        act(() =>
          appCommandStore(configStore)
            .getState()
            .updateGlobalConfig({ autoMergeRequireChecks: requireChecks }),
        );
        expect(button.querySelector("[data-merge-ready]") !== null).toBe(
          state === "current" && !requireChecks,
        );
      }
    } finally {
      cleanup();
      appCommandStore(configStore).setState({ config: initialConfig });
    }
  });
}

test("a remote row disarms when focus leaves the shell for a child frame", () => {
  const row = environment("frame-target");
  render(<RemoteEnvironmentItem machine={machineView([row])} environment={row} />);
  fireEvent.click(screen.getByRole("button", { name: /frame-target/ }));
  const frameDocument = document.implementation.createHTMLDocument("Child document");
  try {
    // A separate document has its own event path; shell blur revokes the arm.
    fireEvent.blur(window);
    const field = frameDocument.createElement("textarea");
    frameDocument.body.append(field);
    field.focus();
    expect(
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Backspace",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    ).toBe(true);
    expect(screen.queryByRole("alertdialog") === null).toBe(true);
    // Returning to the shell must not revive the stale row intent.
    expect(fireEvent.keyDown(window, { key: "Backspace", metaKey: true })).toBe(true);
    expect(screen.queryByRole("alertdialog") === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /frame-target/ }));
    fireEvent.keyDown(window, { key: "Backspace", metaKey: true });
    expect(screen.getByRole("alertdialog", { name: "Delete Environment" })).toBeTruthy();
  } finally {
    frameDocument.body.replaceChildren();
  }
});
