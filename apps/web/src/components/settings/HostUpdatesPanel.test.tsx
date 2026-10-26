import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  hostMaintenanceSnapshotFixture,
  hostUpdateJobFixture,
} from "@orkestrator/protocol/testing/host-maintenance-fixtures";
import type {
  HostMaintenanceSnapshot,
  HostUpdateJob,
} from "@orkestrator/protocol/host-maintenance";

import * as backend from "@/lib/backend";
import { connectedHostClient } from "@/test/host-maintenance-client";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { HostUpdatesPanel, describeRestartImpact } from "./HostUpdatesPanel";
import { useHostMaintenance } from "./useHostMaintenance";

function UpdatesSettings() {
  const { snapshot, error, accept } = useHostMaintenance({ detail: true });
  return (
    <HostUpdatesPanel
      client={connectedHostClient}
      snapshot={snapshot}
      error={error}
      accept={accept}
    />
  );
}

function snapshot(overrides: Partial<HostMaintenanceSnapshot> = {}): HostMaintenanceSnapshot {
  return hostMaintenanceSnapshotFixture({
    updater: {
      kind: "desktop",
      available: true,
      reason: null,
      latestVersion: "2.22.0",
      updateAvailable: true,
      checkedAt: "2026-10-16T12:00:00.000Z",
      checkError: null,
    },
    ...overrides,
  });
}

function job(overrides: Partial<HostUpdateJob> = {}): HostUpdateJob {
  return hostUpdateJobFixture({ requestedVersion: "2.22.0", ...overrides });
}

afterEach(() => {
  cleanup();
  mock.restore();
});

test("installs the newest release after confirmation", async () => {
  spyOn(backend, "getHostMaintenance").mockResolvedValue(snapshot());
  const request = spyOn(backend, "requestHostUpdate").mockResolvedValue({
    job: job(),
    snapshot: snapshot({ revision: 2, job: job() }),
  });
  render(<UpdatesSettings />);
  expect(await screen.findByText("2.21.1")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Install 2.22.0" }));
  expect(await screen.findByText("Install Orkestrator 2.22.0?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Install and restart" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith({ version: "2.22.0" }));
  expect(await screen.findByText(/Starting the update to 2\.22\.0/)).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Check for updates" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

test("explains why a host without an updater cannot update", async () => {
  spyOn(backend, "getHostMaintenance").mockResolvedValue(
    snapshot({
      updater: {
        kind: "none",
        available: false,
        reason: "This backend is not run by an Orkestrator app that can update itself.",
        latestVersion: null,
        updateAvailable: null,
        checkedAt: null,
        checkError: null,
      },
    }),
  );
  render(<UpdatesSettings />);
  expect(await screen.findByText(/not run by an Orkestrator app/)).toBeTruthy();
  expect(screen.getByText("Not checked yet")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Check for updates" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Install update" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

test("asks the host to check and shows the countdown of a staged update", async () => {
  spyOn(backend, "getHostMaintenance").mockResolvedValue(
    snapshot({
      job: job({
        state: "awaiting-restart",
        targetVersion: "2.22.0",
        restartAt: new Date(Date.now() + 45_000).toISOString(),
      }),
    }),
  );
  render(<UpdatesSettings />);
  expect(await screen.findByText(/2\.22\.0 is ready\. The host restarts in 4[45] s/)).toBeTruthy();
});

test("a failed check is shown and Check for updates sends a request", async () => {
  spyOn(backend, "getHostMaintenance").mockResolvedValue(
    snapshot({
      updater: {
        ...snapshot().updater,
        latestVersion: null,
        updateAvailable: null,
        checkError: "offline",
      },
    }),
  );
  const check = spyOn(backend, "requestHostUpdateCheck").mockResolvedValue(
    snapshot({ revision: 2, checkRequest: { id: "c1", requestedAt: "2026-10-16T12:00:01Z" } }),
  );
  render(<UpdatesSettings />);
  expect(await screen.findByText("Check failed: offline")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
});

test("the confirmation shows what a restart interrupts and can wait until idle", async () => {
  spyOn(backend, "getHostMaintenance").mockResolvedValue(snapshot());
  spyOn(backend, "getHostRestartImpact").mockResolvedValue({
    workingAgents: 2,
    waitingAgents: 0,
    activePipelines: 1,
    terminals: 3,
    hostServers: 1,
    measuredAt: "2026-10-16T12:00:00.000Z",
  });
  const request = spyOn(backend, "requestHostUpdate").mockResolvedValue({
    job: job({ drain: "when-idle" }),
    snapshot: snapshot({ revision: 2, job: job({ drain: "when-idle" }) }),
  });
  render(<UpdatesSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Install 2.22.0" }));
  expect(
    await screen.findByText("2 agents working · 1 build pipeline · 3 open terminals"),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("switch", { name: "Wait until no agent or pipeline is running" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Install when idle" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      version: "2.22.0",
      drain: "when-idle",
      maxWaitSeconds: 3_600,
    }),
  );
});

test("an update in progress can be cancelled", async () => {
  spyOn(backend, "getHostMaintenance").mockResolvedValue(
    snapshot({ job: job({ state: "downloading", progressPercent: 30 }) }),
  );
  const cancel = spyOn(backend, "cancelHostUpdate").mockResolvedValue({
    job: job({ state: "cancelled" }),
    snapshot: snapshot({ revision: 2, job: job({ state: "cancelled" }) }),
  });
  render(<UpdatesSettings />);
  expect(await screen.findByText(/Downloading 2\.22\.0 \(30%\)/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel update" }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith("job-1"));
  expect(await screen.findByText("The update was cancelled.")).toBeTruthy();
});

test("restart confirmation identifies running agents with unknown activity", () => {
  expect(
    describeRestartImpact({
      workingAgents: 0,
      waitingAgents: 0,
      unknownAgents: 1,
      activePipelines: 0,
      terminals: 0,
      hostServers: 0,
      measuredAt: "2026-10-16T12:00:00Z",
    }),
  ).toContain("1 agent with unknown activity");
});

test("restart confirmation separates container terminals, whose shells keep running", () => {
  const impact = {
    workingAgents: 0,
    waitingAgents: 0,
    activePipelines: 0,
    terminals: 3,
    hostServers: 0,
    measuredAt: "2026-10-26T12:00:00Z",
  };
  expect(describeRestartImpact({ ...impact, containerTerminals: 2 })).toBe(
    "1 host terminal · 2 container terminals (their shells keep running)",
  );
  expect(describeRestartImpact({ ...impact, terminals: 1, containerTerminals: 1 })).toBe(
    "1 container terminal (its shell keeps running)",
  );
  expect(describeRestartImpact({ ...impact, containerTerminals: 0 })).toBe("3 host terminals");
  // An older backend reports one count for both.
  expect(describeRestartImpact(impact)).toBe("3 open terminals");
});

test("switches the host's update channel", async () => {
  spyOn(backend, "getHostMaintenance").mockResolvedValue(snapshot());
  const change = spyOn(backend, "setHostUpdateChannel").mockResolvedValue(
    snapshot({
      revision: 2,
      updateChannel: "beta",
      checkRequest: { id: "c1", requestedAt: "2026-10-16T12:00:01Z" },
    }),
  );
  render(<UpdatesSettings />);
  fireEvent.click(await screen.findByRole("combobox", { name: "Update channel" }));
  fireEvent.click(await screen.findByRole("option", { name: "Beta" }));
  await waitFor(() => expect(change).toHaveBeenCalledWith("beta"));
  expect(await screen.findByText(/Previews of the next release/)).toBeTruthy();
});

test("hides the channel for a backend that does not report one", async () => {
  const { updateChannel: _, ...older } = snapshot();
  spyOn(backend, "getHostMaintenance").mockResolvedValue(older as HostMaintenanceSnapshot);
  render(<UpdatesSettings />);
  expect(await screen.findByText("2.21.1")).toBeTruthy();
  expectDomAbsent(screen.queryByRole("combobox", { name: "Update channel" }), "channel picker");
});
