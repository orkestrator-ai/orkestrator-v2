import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { NodeListResult, NodeStatus, NodeView } from "@orkestrator/protocol/command-nodes";
import type {
  HostMaintenanceSnapshot,
  HostRestartImpact,
} from "@orkestrator/protocol/host-maintenance";
import {
  hostMaintenanceSnapshotFixture,
  hostUpdateJobFixture,
} from "@orkestrator/protocol/testing/host-maintenance-fixtures";
import { invoke } from "@/lib/native/backend";
import { expectDomAbsent } from "../../../../../../tests/bounded-test-diagnostics";
import { useMachineBulkUpdateStore } from "@/stores/machineBulkUpdateStore";
import {
  mockToastSuccess,
  mockToastWarning,
  mockToastError,
  resetSonnerMocks,
} from "../../../../../../tests/mocks/sonner";
import { MachinesSettings } from "./MachinesSettings";

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const invokeMock = invoke as unknown as ReturnType<typeof mock>;

afterEach(() => {
  cleanup();
  mock.restore();
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  resetSonnerMocks();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
  useMachineBulkUpdateStore.setState({ outcomes: {}, snapshots: {}, running: false });
});

const status: NodeStatus = {
  nodeId: "bk_self" as never,
  mode: "command",
  registrationEnabled: true,
  controllers: [],
  detachedControllers: [],
  suspendedSubordinateCount: 0,
};

function nodeView(id: string, name: string, overrides: Partial<NodeView> = {}): NodeView {
  return {
    nodeId: `bk_${id}` as never,
    enabled: true,
    displayName: name,
    colorToken: "teal",
    fallbackName: id,
    routes: [
      { id: "https" as never, kind: "https", enabled: true, origin: `https://${id}.ts.net` },
    ],
    routeOrder: ["https" as never],
    hasCredential: true,
    attachment: { status: "attached" },
    connection: {
      state: "connected",
      epoch: 1,
      activeRouteId: "https" as never,
      activeRouteKind: "https",
    },
    addedAt: "2026-10-21T00:00:00.000Z",
    lastConnectedAt: "2026-10-21T10:00:00.000Z",
    source: "portal",
    ...overrides,
  };
}

const nodes = [
  nodeView("build", "Build box"),
  nodeView("zed", "Zed", {
    connection: { state: "unavailable", epoch: 1, lastError: { code: "x", message: "No route" } },
  }),
];

const impact: HostRestartImpact = {
  workingAgents: 2,
  waitingAgents: 0,
  activePipelines: 0,
  terminals: 0,
  hostServers: 0,
  measuredAt: "t",
} as HostRestartImpact;

function updater(overrides: Partial<HostMaintenanceSnapshot["updater"]>) {
  return {
    kind: "standalone" as const,
    available: true,
    reason: null,
    latestVersion: null,
    updateAvailable: null,
    checkedAt: null,
    checkError: null,
    ...overrides,
  };
}

/**
 * Desk (this window's machine) is on the newest release; Build box is one
 * behind; Zed cannot be reached. Every machine command is recorded in order.
 */
function install(
  override?: (
    machine: "self" | "bk_build",
    command: string,
    args: Record<string, unknown>,
  ) => unknown,
) {
  const calls: string[] = [];
  const desk = hostMaintenanceSnapshotFixture({ version: "2.36.0" });
  const build = hostMaintenanceSnapshotFixture({
    version: "2.35.0",
    updater: updater({}),
  });
  const answer = (machine: "self" | "bk_build", command: string, args: Record<string, unknown>) => {
    calls.push(`${machine}:${command}`);
    const before = machine === "self" ? desk : build;
    switch (command) {
      case "get_host_maintenance":
        return before;
      case "get_host_restart_impact":
        return impact;
      case "request_host_update_check":
        return machine === "self"
          ? {
              ...desk,
              revision: 2,
              updater: updater({ latestVersion: "2.36.0", updateAvailable: false, checkedAt: "t" }),
            }
          : {
              ...build,
              revision: 2,
              updater: updater({ latestVersion: "2.36.0", updateAvailable: true, checkedAt: "t" }),
            };
      case "request_host_update": {
        const job = hostUpdateJobFixture({
          fromVersion: "2.35.0",
          requestedVersion: String(args.version),
        });
        return { job, snapshot: { ...build, revision: 3, job } };
      }
      default:
        return undefined;
    }
  };
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "get_node_status") return status;
    if (command === "list_nodes") {
      return {
        revision: 1,
        mode: "command",
        suspended: false,
        nodes,
        pendingDetaches: [],
      } satisfies NodeListResult;
    }
    if (command === "get_backend_profile") {
      return { revision: 1, displayName: "Desk", colorToken: "violet", updatedAt: "t" };
    }
    if (command === "invoke_on_node") {
      if (args.nodeId !== "bk_build") throw new Error("not reachable");
      const inner = String(args.command);
      if (inner === "get_backend_profile") {
        return {
          outcome: "ok",
          result: { revision: 3, displayName: "Build box", colorToken: "teal", updatedAt: "t" },
        };
      }
      return {
        outcome: "ok",
        result: await (override?.(
          "bk_build",
          inner,
          (args.args as Record<string, unknown>) ?? {},
        ) ?? answer("bk_build", inner, (args.args as Record<string, unknown>) ?? {})),
      };
    }
    return override?.("self", command, args) ?? answer("self", command, args);
  });
  return { calls };
}

function row(name: string): HTMLElement {
  const match = screen
    .getAllByTestId("machine-row")
    .find((element) => element.textContent?.includes(name));
  if (!match) throw new Error(`No row for ${name}`);
  return match;
}

test("ticked machines update to the latest release, this window's machine last", async () => {
  const backend = install();
  render(<MachinesSettings />);
  await waitFor(() => expect(screen.getAllByTestId("machine-row")).toHaveLength(3));

  const update = screen.getByRole("button", { name: "Update app to latest" }) as HTMLButtonElement;
  expect(update.disabled).toBe(true);
  // An unreachable machine cannot be ticked.
  expect(
    within(row("Zed")).getByRole("checkbox", { name: "Select Zed" }).hasAttribute("disabled"),
  ).toBe(true);

  fireEvent.click(screen.getByRole("checkbox", { name: "Select every machine that can update" }));
  expect(screen.getByText("2 of 2 selected")).toBeTruthy();
  expect(update.disabled).toBe(false);
  fireEvent.click(update);

  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Update 2 machines to the latest Orkestrator?")).toBeTruthy();
  await waitFor(() => expect(within(dialog).getAllByText("2 agents working")).toHaveLength(2));
  expect(within(dialog).getByText(/This window's machine is asked last/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Update 2 machines" }));

  await waitFor(() =>
    expect(mockToastSuccess.mock.calls[0]?.[0]).toBe("Started on 1 machine · 1 already current"),
  );
  // Desk was current, so only Build box was asked to install.
  expect(backend.calls.filter((call) => call.endsWith(":request_host_update"))).toEqual([
    "bk_build:request_host_update",
  ]);
  expect(backend.calls.indexOf("self:request_host_update_check")).toBeGreaterThan(
    backend.calls.indexOf("bk_build:request_host_update"),
  );
  expect(within(row("Build box")).getByTestId("machine-update-status").textContent).toBe(
    "Starting the update to 2.36.0…",
  );
  expect(within(row("Desk")).getByTestId("machine-update-status").textContent).toBe(
    "Already on the newest release (2.36.0)",
  );
  // The selection is cleared once the update starts.
  expect(screen.getByText("Tick machines to update them together")).toBeTruthy();
});

test("a single ticked machine names itself in the confirmation", async () => {
  install();
  render(<MachinesSettings />);
  await waitFor(() => expect(screen.getAllByTestId("machine-row")).toHaveLength(3));
  fireEvent.click(within(row("Build box")).getByRole("checkbox", { name: "Select Build box" }));
  fireEvent.click(screen.getByRole("button", { name: "Update app to latest" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Update Build box to the latest Orkestrator?")).toBeTruthy();
  expectDomAbsent(within(dialog).queryByText(/This window's machine/));
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expectDomAbsent(screen.queryByRole("alertdialog")));
  expect(screen.getByText("1 of 2 selected")).toBeTruthy();
});

async function confirmBuild() {
  fireEvent.click(within(row("Build box")).getByRole("checkbox", { name: "Select Build box" }));
  fireEvent.click(screen.getByRole("button", { name: "Update app to latest" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Update" }));
}

for (const stage of ["read", "check", "request"] as const) {
  test(`Settings remount follows a remote batch paused at ${stage}, progress, and completion`, async () => {
    let release!: (value: unknown) => void;
    let reads = 0;
    let next = hostMaintenanceSnapshotFixture({ version: "2.35.0" });
    install((machine, command) => {
      if (machine !== "bk_build") return;
      if (command === "get_host_maintenance") {
        reads++;
        if (stage === "read" && reads === 2)
          return new Promise((resolve) => {
            release = resolve;
          });
        return next;
      }
      if (
        (stage === "check" && command === "request_host_update_check") ||
        (stage === "request" && command === "request_host_update")
      ) {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
    });
    const mounted = render(<MachinesSettings />);
    await waitFor(() => expect(screen.getAllByTestId("machine-row")).toHaveLength(3));
    await confirmBuild();
    await waitFor(() => expect(release).toBeDefined());
    mounted.unmount();
    render(<MachinesSettings />);
    await waitFor(() => expect(screen.getAllByTestId("machine-row")).toHaveLength(3));
    expect(useMachineBulkUpdateStore.getState().running).toBe(true);
    expect(
      (screen.getByRole("checkbox", { name: "Select Build box" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const job = hostUpdateJobFixture({ state: "downloading", requestedVersion: "2.36.0" });
    await act(async () =>
      release(
        stage === "request"
          ? { job, snapshot: { ...next, revision: 3, job } }
          : stage === "check"
            ? {
                ...next,
                revision: 2,
                updater: updater({ latestVersion: "2.36.0", updateAvailable: true }),
              }
            : next,
      ),
    );
    await waitFor(() => expect(useMachineBulkUpdateStore.getState().running).toBe(false));
    expect(within(row("Build box")).getByTestId("machine-update-status").textContent).toMatch(
      /Starting|Downloading/,
    );
    // Drive only the summary polling interval; other page timers stay untouched.
    const callbacks: Array<() => void> = [];
    const realSet = globalThis.setInterval.bind(globalThis);
    spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, delay: number) => {
      if (delay === 3000) callbacks.push(callback);
      return realSet(callback, delay);
    }) as typeof setInterval);
    // Remount also proves the accepted job is retained independently of its initiating hook.
    cleanup();
    render(<MachinesSettings />);
    await waitFor(() => expect(callbacks.length).toBeGreaterThan(0));
    next = {
      ...next,
      revision: 4,
      job: { ...job, state: "failed", error: "download interrupted" },
    };
    await act(async () => callbacks.at(-1)!());
    await waitFor(() =>
      expect(within(row("Build box")).getByTestId("machine-update-status").textContent).toContain(
        "download interrupted",
      ),
    );
    cleanup();
    render(<MachinesSettings />);
    await waitFor(() =>
      expect(within(row("Build box")).getByTestId("machine-update-status").textContent).toContain(
        "download interrupted",
      ),
    );
  });
}

test("blocked selections are pruned and do not reappear when the machine becomes eligible", async () => {
  install();
  render(<MachinesSettings />);
  await waitFor(() => expect(screen.getAllByTestId("machine-row")).toHaveLength(3));
  const checkbox = () => screen.getByRole("checkbox", { name: "Select Desk" });
  fireEvent.click(checkbox());
  expect(checkbox().getAttribute("aria-checked")).toBe("true");
  // Publish host state through the same shared path as detached batch snapshots.
  act(() =>
    useMachineBulkUpdateStore
      .getState()
      .report(
        "self:bk_self",
        { state: "skipped", reason: "unavailable" },
        hostMaintenanceSnapshotFixture({ revision: 10, updater: updater({ available: false }) }),
      ),
  );
  await waitFor(() => expect(checkbox().hasAttribute("disabled")).toBe(true));
  act(() =>
    useMachineBulkUpdateStore
      .getState()
      .report(
        "self:bk_self",
        { state: "current", version: "2.36.0" },
        hostMaintenanceSnapshotFixture({ revision: 11 }),
      ),
  );
  await waitFor(() => expect(checkbox().hasAttribute("disabled")).toBe(false));
  expect(checkbox().getAttribute("aria-checked")).toBe("false");
});

for (const mixed of [false, true]) {
  test(`${mixed ? "mixed" : "all failed"} batch reports a ${mixed ? "warning" : "error"} toast and releases its lock`, async () => {
    install((machine, command) => {
      if (command === "request_host_update_check" && (machine === "bk_build" || !mixed)) {
        throw new Error("check offline");
      }
    });
    render(<MachinesSettings />);
    await waitFor(() => expect(screen.getAllByTestId("machine-row")).toHaveLength(3));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select every machine that can update" }));
    fireEvent.click(screen.getByRole("button", { name: "Update app to latest" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Update 2 machines",
      }),
    );
    await waitFor(() =>
      expect((mixed ? mockToastWarning : mockToastError).mock.calls).toHaveLength(1),
    );
    expect(useMachineBulkUpdateStore.getState().running).toBe(false);
    expect(within(row("Build box")).getByTestId("machine-update-status").textContent).toContain(
      "check offline",
    );
  });
}

test("the wait-until-idle switch and restart timeout reach the selected host", async () => {
  let request: Record<string, unknown> | undefined;
  install((machine, command, args) => {
    if (machine === "bk_build" && command === "request_host_update") request = args;
  });
  render(<MachinesSettings />);
  await waitFor(() => expect(screen.getAllByTestId("machine-row")).toHaveLength(3));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Build box" }));
  fireEvent.click(screen.getByRole("button", { name: "Update app to latest" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(
    within(dialog).getByRole("switch", { name: "Wait until no agent or pipeline is running" }),
  );
  const select = within(dialog).getByRole("combobox", { name: "Restart anyway after" });
  fireEvent.keyDown(select, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: "30 minutes" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Update when idle" }));
  await waitFor(() =>
    expect(request).toEqual({ version: "2.36.0", drain: "when-idle", maxWaitSeconds: 1800 }),
  );
});

for (const prior of ["failed", "current", "busy", "skipped", "requested"] as const) {
  for (const state of ["succeeded", "failed", "cancelled"] as const) {
    test(`${prior} outcome yields to a later ${state} job, even for a different version`, async () => {
      let next = hostMaintenanceSnapshotFixture({ version: "2.35.0" });
      install((machine, command) =>
        machine === "bk_build" && command === "get_host_maintenance" ? next : undefined,
      );
      const mounted = render(<MachinesSettings />);
      await waitFor(() => expect(screen.getAllByTestId("machine-row")).toHaveLength(3));
      const outcome =
        prior === "failed"
          ? ({ state: prior, error: "old check failure" } as const)
          : prior === "current"
            ? ({ state: prior, version: next.version } as const)
            : prior === "skipped"
              ? ({ state: prior, reason: "old skip" } as const)
              : prior === "requested"
                ? ({ state: prior, version: "2.36.0" } as const)
                : { state: prior };
      act(() => useMachineBulkUpdateStore.getState().report("node:bk_build", outcome, next));
      expect(within(row("Build box")).getByTestId("machine-update-status")).toBeTruthy();
      mounted.unmount();
      next = {
        ...next,
        revision: 5,
        job: hostUpdateJobFixture({
          id: "later-job",
          state,
          requestedVersion: "2.38.0",
          error: state === "failed" ? "later download failed" : null,
        }),
      };
      render(<MachinesSettings />);
      await waitFor(() =>
        expect(within(row("Build box")).getByTestId("machine-update-status").textContent).toMatch(
          state === "succeeded"
            ? /Updated/
            : state === "failed"
              ? /later download failed/
              : /cancelled/i,
        ),
      );
      expectDomAbsent(
        within(row("Build box"))
          .getByTestId("machine-update-status")
          .querySelector(".animate-spin"),
      );
    });
  }
}

for (const stage of [
  "get_host_maintenance",
  "request_host_update_check",
  "request_host_update",
] as const) {
  test(`a hung ${stage} releases the bulk lock and permits serving-host processing`, async () => {
    const callbacks = new Map<number, () => void>();
    let id = 100000;
    let reads = 0;
    let entered = false;
    const realSet = globalThis.setTimeout.bind(globalThis);
    const realClear = globalThis.clearTimeout.bind(globalThis);
    globalThis.setTimeout = ((callback: () => void, delay: number) => {
      if (delay > 89_000 && delay <= 90_000) {
        callbacks.set(++id, callback);
        return id;
      }
      return realSet(callback, delay);
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer: number) => {
      if (!callbacks.delete(timer)) realClear(timer);
    }) as typeof clearTimeout;
    const backend = install((machine, command) => {
      if (machine !== "bk_build") return;
      if (command === "get_host_maintenance") reads++;
      if (command === stage && (stage !== "get_host_maintenance" || reads > 1)) {
        entered = true;
        return new Promise(() => undefined);
      }
    });
    render(<MachinesSettings />);
    await waitFor(() => expect(screen.getAllByTestId("machine-row")).toHaveLength(3));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select every machine that can update" }));
    fireEvent.click(screen.getByRole("button", { name: "Update app to latest" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Update 2 machines",
      }),
    );
    await waitFor(() => expect(entered).toBe(true));
    expect(useMachineBulkUpdateStore.getState().running).toBe(true);
    await act(async () => {
      for (const callback of Array.from(callbacks.values())) callback();
    });
    await waitFor(() => expect(useMachineBulkUpdateStore.getState().running).toBe(false));
    expect(backend.calls).toContain("self:request_host_update_check");
    expect(mockToastWarning).toHaveBeenCalledTimes(1);
    expect(within(row("Build box")).getByTestId("machine-update-status").textContent).toContain(
      "Timed out",
    );
    expect(callbacks.size).toBe(0);
  });
}

test("a changed installed version clears an old requested spinner without a job", async () => {
  let next = hostMaintenanceSnapshotFixture({ version: "2.35.0" });
  install((machine, command) =>
    machine === "bk_build" && command === "get_host_maintenance" ? next : undefined,
  );
  const mounted = render(<MachinesSettings />);
  await waitFor(() => expect(screen.getAllByTestId("machine-row")).toHaveLength(3));
  act(() =>
    useMachineBulkUpdateStore
      .getState()
      .report("node:bk_build", { state: "requested", version: "2.36.0" }, next),
  );
  expect(within(row("Build box")).getByTestId("machine-update-status").textContent).toBe(
    "Update requested",
  );
  mounted.unmount();
  next = { ...next, revision: 5, version: "2.38.0" };
  render(<MachinesSettings />);
  await waitFor(() =>
    expectDomAbsent(within(row("Build box")).queryByTestId("machine-update-status")),
  );
});
