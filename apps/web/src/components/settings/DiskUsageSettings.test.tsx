import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import * as backend from "@/lib/backend";
import type {
  DiskUsageEnvironmentSummary,
  EnvironmentDiskUsage,
  WorktreeLocationsSnapshot,
} from "@/lib/backend";
import { useHostPathPickerStore } from "@/lib/host-path-picker";
import { mockToastError } from "../../../../../tests/mocks/sonner";
import { AccountMachineProvider } from "./account-machine";
import { DiskUsageSettings } from "./DiskUsageSettings";

const GB = 1024 ** 3;
const snapshot = (): WorktreeLocationsSnapshot => ({
  environments: {
    configured: null,
    defaultPath: "/default/trees",
    effective: "/default/trees",
    startupOverride: null,
  },
  dev: { configured: null, defaultPath: "/dev/profiles", readOnly: false },
});
const row = (id: string): DiskUsageEnvironmentSummary => ({
  environmentId: id,
  name: `Environment ${id}`,
  projectId: "p1",
  projectName: "Project",
  environmentType: "local",
  location: `/trees/${id}`,
  projectHome: false,
});
const usage = (id: string, totalBytes: number | null = GB): EnvironmentDiskUsage => ({
  environmentId: id,
  environmentType: "local",
  measuredAt: new Date().toISOString(),
  primary: { kind: "worktree", path: `/trees/${id}`, bytes: totalBytes, items: [] },
  dev: { profiles: [], worktreeBytes: 0, bytes: 0 },
  totalBytes,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  spyOn(backend, "getWorktreeLocations").mockResolvedValue(snapshot());
  spyOn(backend, "listDiskUsageEnvironments").mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  mock.restore();
});

test("picks, saves and resets both locations; cancelled picks make no write", async () => {
  const update = spyOn(backend, "updateWorktreeLocations").mockImplementation(async (next) => ({
    ...snapshot(),
    environments: { ...snapshot().environments, configured: next.environments },
    dev: { ...snapshot().dev, configured: next.dev },
  }));
  render(<DiskUsageSettings />);
  const choose = await screen.findByRole("button", { name: "Choose new environment worktrees" });
  fireEvent.click(choose);
  await waitFor(() => expect(useHostPathPickerStore.getState().request).toBeTruthy());
  act(() => useHostPathPickerStore.getState().settle(null));
  expect(update).not.toHaveBeenCalled();
  fireEvent.click(choose);
  await waitFor(() => expect(useHostPathPickerStore.getState().request).toBeTruthy());
  act(() => useHostPathPickerStore.getState().settle("/chosen/trees"));
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith({ environments: "/chosen/trees", dev: null }, undefined),
  );
  await screen.findByText("/chosen/trees");
  fireEvent.click(
    screen.getByRole("button", { name: "Reset new environment worktrees to default" }),
  );
  await waitFor(() =>
    expect(update).toHaveBeenLastCalledWith({ environments: null, dev: null }, undefined),
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose new dev worktrees" }));
  await waitFor(() => expect(useHostPathPickerStore.getState().request).toBeTruthy());
  act(() => useHostPathPickerStore.getState().settle("/chosen/dev"));
  await screen.findByText("/chosen/dev");
  fireEvent.click(screen.getByRole("button", { name: "Reset new dev worktrees to default" }));
  await waitFor(() =>
    expect(update).toHaveBeenLastCalledWith({ environments: null, dev: null }, undefined),
  );
});

test("profile backends disable both location controls and explain production ownership", async () => {
  const value = snapshot();
  value.environments.startupOverride = "/profile/trees";
  value.environments.configured = "/previous";
  value.dev.readOnly = true;
  value.dev.configured = "/previous-dev";
  spyOn(backend, "getWorktreeLocations").mockResolvedValue(value);
  render(<DiskUsageSettings />);
  await screen.findByText(/Change this setting in the production app/);
  for (const label of ["new environment worktrees", "new dev worktrees"]) {
    expect(
      (screen.getByRole("button", { name: `Choose ${label}` }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: `Reset ${label} to default` }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  }
});

test("saving disables location controls and failures preserve the previous selection", async () => {
  const pending = deferred<WorktreeLocationsSnapshot>();
  spyOn(backend, "updateWorktreeLocations").mockImplementation(() => pending.promise);
  render(<DiskUsageSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Choose new dev worktrees" }));
  await waitFor(() => expect(useHostPathPickerStore.getState().request).toBeTruthy());
  act(() => useHostPathPickerStore.getState().settle("/bad"));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Choose new dev worktrees" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true),
  );
  await act(async () => pending.reject(new Error("invalid folder")));
  expect(mockToastError).toHaveBeenCalledWith("Worktree location was not saved", {
    description: "invalid folder",
  });
  expect(screen.queryByText("/bad") === null).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Choose new dev worktrees" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test("measure-all bounds concurrency and reports partial totals and individual failures", async () => {
  const items = ["1", "2", "3", "4", "5"].map(row);
  spyOn(backend, "listDiskUsageEnvironments").mockResolvedValue(items);
  const pending = new Map(
    items.map((item) => [item.environmentId, deferred<EnvironmentDiskUsage>()]),
  );
  let active = 0;
  let peak = 0;
  const get = spyOn(backend, "getEnvironmentDiskUsage").mockImplementation(async (id) => {
    active++;
    peak = Math.max(peak, active);
    try {
      return await pending.get(id)!.promise;
    } finally {
      active--;
    }
  });
  render(<DiskUsageSettings />);
  await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
  expect(peak).toBe(3);
  expect(screen.getByText(/Measured 0 of 5/)).toBeTruthy();
  await act(async () => pending.get("1")!.resolve(usage("1", 2 * GB)));
  await waitFor(() => expect(get).toHaveBeenCalledTimes(4));
  expect(screen.getByText(/Measured 1 of 5 · 2 GB so far/)).toBeTruthy();
  await act(async () => pending.get("2")!.reject(new Error("disk offline")));
  await waitFor(() => expect(get).toHaveBeenCalledTimes(5));
  await act(async () => {
    for (const id of ["3", "4", "5"]) pending.get(id)!.resolve(usage(id, id === "3" ? null : GB));
  });
  await waitFor(() =>
    expect(screen.getByText(/4 GB measured \(some sizes unavailable\)/)).toBeTruthy(),
  );
  expect(screen.getByTitle("disk offline")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  expect(peak).toBe(3);
});

test("unmounted loads never start measurement and refresh uses a new generation", async () => {
  const list = deferred<DiskUsageEnvironmentSummary[]>();
  const get = spyOn(backend, "getEnvironmentDiskUsage").mockResolvedValue(usage("1"));
  const listing = spyOn(backend, "listDiskUsageEnvironments").mockImplementationOnce(
    () => list.promise,
  );
  const first = render(<DiskUsageSettings />);
  first.unmount();
  await act(async () => list.resolve([row("old")]));
  expect(get).not.toHaveBeenCalled();
  listing.mockResolvedValue([row("1")]);
  render(<DiskUsageSettings />);
  await screen.findByText(/1 GB across 1 environment/);
  get.mockResolvedValue(usage("1", 3 * GB));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText(/3 GB across 1 environment/);
  expect(get).toHaveBeenLastCalledWith("1", true, undefined);
});

test("unmounting a pending measure generation stops its remaining queue", async () => {
  spyOn(backend, "listDiskUsageEnvironments").mockResolvedValue(["1", "2", "3", "4"].map(row));
  const pending = deferred<EnvironmentDiskUsage>();
  const get = spyOn(backend, "getEnvironmentDiskUsage").mockImplementation(() => pending.promise);
  const view = render(<DiskUsageSettings />);
  await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
  view.unmount();
  await act(async () => pending.resolve(usage("1")));
  expect(get).toHaveBeenCalledTimes(3);
});

for (const machine of [null, "leaf", "other"]) {
  test(`leaf-window worktree browsing and disk measurements respect ${machine ?? "command node"}`, async () => {
    window.orkestratorWorkspaceTarget = { nodeId: "leaf", nodeName: "Leaf", path: "direct" };
    const locations = snapshot();
    locations.environments.configured = "/selected/trees";
    const read = spyOn(backend, "getWorktreeLocations").mockResolvedValue(locations);
    const list = spyOn(backend, "listDiskUsageEnvironments").mockResolvedValue([
      row("selected-env"),
    ]);
    const update = spyOn(backend, "updateWorktreeLocations").mockResolvedValue(snapshot());
    const measure = spyOn(backend, "getEnvironmentDiskUsage").mockResolvedValue(
      usage("selected-env"),
    );
    try {
      render(
        <AccountMachineProvider value={{ machine, name: "Selected" }}>
          <DiskUsageSettings />
        </AccountMachineProvider>,
      );
      const pick = await screen.findByRole("button", { name: "Choose new environment worktrees" });
      expect((pick as HTMLButtonElement).disabled).toBe(machine !== "leaf");
      expect(read).toHaveBeenCalledWith(machine);
      expect(list).toHaveBeenCalledWith(machine);
      fireEvent.click(
        screen.getByRole("button", { name: "Reset new environment worktrees to default" }),
      );
      await waitFor(() =>
        expect(update).toHaveBeenCalledWith({ environments: null, dev: null }, machine),
      );
      await waitFor(() => expect(measure).toHaveBeenCalledWith("selected-env", false, machine));
    } finally {
      cleanup();
      delete window.orkestratorWorkspaceTarget;
    }
  });
}
