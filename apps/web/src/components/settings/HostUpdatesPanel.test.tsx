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
import {
  mockToastSuccess,
  mockToastError,
  resetSonnerMocks,
} from "../../../../../tests/mocks/sonner";
import { connectedHostClient } from "@/test/host-maintenance-client";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { HostUpdatesPanel, describeHostUpdateJob, describeRestartImpact } from "./HostUpdatesPanel";
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

test("a long check error shows a summary and reveals the full message on request", async () => {
  const checkError =
    "Cannot find latest-mac.yml in the latest release artifacts " +
    "(https://github.com/orkestrator-ai/orkestrator-v2/releases/download/v2.36.6-beta/latest-mac.yml): " +
    "HttpError: 404 \\nPlease double check that your authentication token is correct.";
  spyOn(backend, "getHostMaintenance").mockResolvedValue(
    snapshot({
      updater: { ...snapshot().updater, latestVersion: null, updateAvailable: null, checkError },
    }),
  );
  render(<UpdatesSettings />);
  expect(
    await screen.findByText(
      "Check failed: v2.36.6-beta has no macOS update files yet; it may still be publishing.",
    ),
  ).toBeTruthy();
  expectDomAbsent(screen.queryByText(/Please double check/), "full error before expanding");
  const toggle = screen.getByRole("button", { name: "Details" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(screen.getByText(/Please double check/).textContent).toContain("HttpError: 404 \n");
  fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
  expectDomAbsent(screen.queryByText(/Please double check/), "full error after collapsing");
});

test("a failed update shows a summary of its error", async () => {
  spyOn(backend, "getHostMaintenance").mockResolvedValue(
    snapshot({
      job: job({ state: "failed", error: "Error: net::ERR_CONNECTION_RESET\n    at x" }),
    }),
  );
  render(<UpdatesSettings />);
  expect(await screen.findByText("The update failed: Could not reach GitHub.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
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

test.each([false, true])(
  "Copy error restores full details (clipboard rejects: %s)",
  async (rejects) => {
    resetSonnerMocks();
    const writeText = spyOn(navigator.clipboard, "writeText");
    if (rejects) writeText.mockRejectedValue(new Error("Clipboard denied"));
    else writeText.mockResolvedValue(undefined);
    const checkError = "Error: net::ERR_CONNECTION_RESET\\nFull diagnostic details";
    spyOn(backend, "getHostMaintenance").mockResolvedValue(
      snapshot({
        updater: { ...snapshot().updater, checkError },
      }),
    );
    render(<UpdatesSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Details" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy error" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "Error: net::ERR_CONNECTION_RESET\nFull diagnostic details",
      ),
    );
    await waitFor(() =>
      expect(rejects ? mockToastError : mockToastSuccess).toHaveBeenCalledWith(
        rejects ? "Failed to copy to clipboard" : "Error copied to clipboard",
      ),
    );
  },
);

test("describeHostUpdateJob names the machine when given one, else says the host", () => {
  const job = (overrides: Partial<HostUpdateJob>) =>
    hostUpdateJobFixture({ targetVersion: "2.37.4-beta", ...overrides });
  const deadline = "2026-10-16T13:00:00.000Z";
  const until = new Date(deadline).toLocaleTimeString();
  const cases: Array<[HostUpdateJob, number | null, string, string]> = [
    [
      job({ state: "waiting-for-idle" }),
      null,
      "2.37.4-beta is ready. Waiting until nothing is running on mini.",
      "2.37.4-beta is ready. Waiting until nothing is running on the host.",
    ],
    [
      job({ state: "waiting-for-idle", idleDeadline: deadline }),
      null,
      `2.37.4-beta is ready. Waiting until nothing is running on mini (at most until ${until}).`,
      `2.37.4-beta is ready. Waiting until nothing is running on the host (at most until ${until}).`,
    ],
    [
      job({ state: "awaiting-restart" }),
      30,
      "2.37.4-beta is ready. mini restarts in 30 s unless someone there postpones it.",
      "2.37.4-beta is ready. The host restarts in 30 s unless someone there postpones it.",
    ],
    [
      job({ state: "awaiting-restart" }),
      null,
      "2.37.4-beta is ready. mini is restarting…",
      "2.37.4-beta is ready. The host is restarting…",
    ],
    [
      job({ state: "restarting" }),
      null,
      "Restarting mini to install 2.37.4-beta. This page reconnects when it is back.",
      "Restarting the host to install 2.37.4-beta. This page reconnects when it is back.",
    ],
    [
      job({ state: "postponed" }),
      null,
      "Postponed on mini. 2.37.4-beta installs the next time Orkestrator quits there.",
      "Postponed on the host. 2.37.4-beta installs the next time Orkestrator quits there.",
    ],
  ];
  for (const [updateJob, secondsLeft, named, unnamed] of cases) {
    expect(describeHostUpdateJob(updateJob, secondsLeft, "mini")).toBe(named);
    expect(describeHostUpdateJob(updateJob, secondsLeft)).toBe(unnamed);
  }
});
