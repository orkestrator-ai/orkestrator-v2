import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  hostMaintenanceSnapshotFixture,
  hostUpdateJobFixture,
} from "@orkestrator/protocol/testing/host-maintenance-fixtures";

import { BUNDLED_APP_VERSION } from "@/lib/app-version";
import * as backend from "@/lib/backend";
import * as events from "@/lib/native/events";
import {
  HOST_MAINTENANCE_EVENT,
  type HostMaintenanceSnapshot,
} from "@orkestrator/protocol/host-maintenance";
import { onGlobalSettingsRequest, takeMachineUpdatesRequest } from "@/lib/settings-navigation";
import {
  mockToastError,
  mockToastInfo,
  mockToastLoading,
  mockToastSuccess,
  mockToastWarning,
  resetSonnerMocks,
} from "../../../../tests/mocks/sonner";
import * as federation from "@/components/federation/FederationProvider";
import { portalStore } from "@/lib/portal/portal-store";
import { HOST_UPDATE_TOAST_ID, HostUpdateBanner, hostUpdateMachineLabel } from "./HostUpdateBanner";

const originalGateway = window.orkestratorGateway;
const originalOrkestrator = window.orkestrator;

beforeEach(() => {
  resetSonnerMocks();
  window.sessionStorage.clear();
  window.orkestrator = undefined;
  window.orkestratorGateway = undefined;
});

afterEach(() => {
  cleanup();
  mock.restore();
  window.orkestrator = originalOrkestrator;
  window.orkestratorGateway = originalGateway;
});

test("shows a running update with a Cancel action", async () => {
  spyOn(backend, "getHostMaintenance").mockResolvedValue(
    hostMaintenanceSnapshotFixture({
      job: hostUpdateJobFixture({
        state: "downloading",
        progressPercent: 40,
        requestedVersion: "2.22.0",
      }),
    }),
  );
  const cancel = spyOn(backend, "cancelHostUpdate").mockResolvedValue({
    job: hostUpdateJobFixture({ state: "cancelled" }),
    snapshot: hostMaintenanceSnapshotFixture(),
  });
  render(<HostUpdateBanner />);
  await waitFor(() => expect(mockToastLoading).toHaveBeenCalled());
  const [title, options] = mockToastLoading.mock.calls.at(-1) as [
    string,
    { id: string; description: string; action: { label: string; onClick: () => void } },
  ];
  expect(title).toBe("Orkestrator is updating on the host");
  expect(options.id).toBe(HOST_UPDATE_TOAST_ID);
  expect(options.description).toContain("(40%)");
  expect(options.action.label).toBe("Cancel");
  options.action.onClick();
  await waitFor(() => expect(cancel).toHaveBeenCalledWith("job-1"));
});

test("a countdown is a warning naming the restart time", async () => {
  spyOn(backend, "getHostMaintenance").mockResolvedValue(
    hostMaintenanceSnapshotFixture({
      job: hostUpdateJobFixture({
        state: "awaiting-restart",
        targetVersion: "2.22.0",
        restartAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    }),
  );
  render(<HostUpdateBanner />);
  await waitFor(() => expect(mockToastWarning).toHaveBeenCalled());
  const [, options] = mockToastWarning.mock.calls.at(-1) as [string, { description: string }];
  expect(options.description).toContain("The host restarts at");
});

test("a page served by the backend reloads once after the host updated", async () => {
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  spyOn(backend, "getHostMaintenance").mockResolvedValue(
    hostMaintenanceSnapshotFixture({
      version: "999.0.0",
      job: hostUpdateJobFixture({
        state: "succeeded",
        targetVersion: "999.0.0",
        completedAt: new Date().toISOString(),
      }),
    }),
  );
  render(<HostUpdateBanner />);
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  cleanup();
  render(<HostUpdateBanner />);
  await Bun.sleep(20);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(BUNDLED_APP_VERSION).not.toBe("999.0.0");
});

test("an old finished update stays quiet", async () => {
  spyOn(backend, "getHostMaintenance").mockResolvedValue(
    hostMaintenanceSnapshotFixture({
      job: hostUpdateJobFixture({ state: "succeeded", completedAt: "2026-01-01T00:00:00.000Z" }),
    }),
  );
  render(<HostUpdateBanner />);
  await Bun.sleep(20);
  expect(mockToastSuccess).not.toHaveBeenCalled();
  expect(mockToastLoading).not.toHaveBeenCalled();
});

test("a failed update toast opens this machine's update settings from Details", async () => {
  let publish: ((snapshot: HostMaintenanceSnapshot) => void) | undefined;
  spyOn(events, "listen").mockImplementation(async (event, handler) => {
    if (event === HOST_MAINTENANCE_EVENT) {
      publish = (payload) => handler({ payload } as never);
    }
    return () => undefined;
  });
  spyOn(backend, "getHostMaintenance").mockResolvedValue(
    hostMaintenanceSnapshotFixture({
      job: hostUpdateJobFixture({ state: "downloading" }),
    }),
  );
  render(<HostUpdateBanner />);
  await waitFor(() => expect(mockToastLoading).toHaveBeenCalled());
  expect(publish).toBeDefined();
  act(() =>
    publish!(
      hostMaintenanceSnapshotFixture({
        revision: 2,
        job: hostUpdateJobFixture({ state: "failed", error: "HttpError: 503" }),
      }),
    ),
  );
  await waitFor(() => expect(mockToastError).toHaveBeenCalled());
  const [title, options] = mockToastError.mock.calls.at(-1) as [
    string,
    { id: string; description: string; action: { label: string; onClick: () => void } },
  ];
  expect(title).toBe("The update on the host failed");
  expect(options.id).toBe(HOST_UPDATE_TOAST_ID);
  expect(options.description).toBe("The update failed: GitHub answered HTTP 503.");
  expect(options.action.label).toBe("Details");
  takeMachineUpdatesRequest();
  const navigate = mock((_section: string) => undefined);
  const unsubscribe = onGlobalSettingsRequest(navigate);
  try {
    options.action.onClick();
    expect(navigate).toHaveBeenCalledWith("machines");
    expect(takeMachineUpdatesRequest()).toBe(true);
  } finally {
    unsubscribe();
  }
});

/** The window's command node is "mini"; other machines may be in view. */
function connectedTo(name: string, enabled: boolean) {
  spyOn(federation, "useFederation").mockReturnValue({
    portal: portalStore,
    portalState: portalStore.getState(),
    bound: null,
    supported: true,
    enabled,
    kind: "desktop",
    boundMachine: { name, colorToken: "teal" },
  });
}

test("names the command node it updates, not just 'the host'", async () => {
  connectedTo("mini", true);
  spyOn(backend, "getHostMaintenance").mockResolvedValue(
    hostMaintenanceSnapshotFixture({
      job: hostUpdateJobFixture({
        state: "awaiting-restart",
        targetVersion: "2.37.4-beta",
        restartAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    }),
  );
  render(<HostUpdateBanner />);
  await waitFor(() => expect(mockToastWarning).toHaveBeenCalled());
  const [title, options] = mockToastWarning.mock.calls.at(-1) as [string, { description: string }];
  expect(title).toBe("Orkestrator is updating on mini (command node)");
  expect(options.description).toMatch(/^2\.37\.4-beta is ready\. mini restarts at .+\.$/);
  expect(options.description).not.toContain("host");
});

test("hostUpdateMachineLabel names the machine only when the client knows it", () => {
  const machine = { name: "mini" };
  expect(
    hostUpdateMachineLabel({ supported: false, enabled: false, boundMachine: machine }),
  ).toEqual({ name: undefined, title: "the host" });
  expect(hostUpdateMachineLabel({ supported: true, enabled: false, boundMachine: null })).toEqual({
    name: undefined,
    title: "the host",
  });
  // One machine: its name is enough.
  expect(
    hostUpdateMachineLabel({ supported: true, enabled: false, boundMachine: machine }),
  ).toEqual({ name: "mini", title: "mini" });
  // Several machines in view: say which role it plays.
  expect(hostUpdateMachineLabel({ supported: true, enabled: true, boundMachine: machine })).toEqual(
    {
      name: "mini",
      title: "mini (command node)",
    },
  );
});

test.each([
  {
    state: "succeeded" as const,
    toastMock: mockToastSuccess,
    title: "Orkestrator updated on mini (command node)",
    description: "Updated from 2.21.1 to 2.37.4-beta.",
  },
  {
    state: "failed" as const,
    toastMock: mockToastError,
    title: "The update on mini (command node) failed",
    description: "The update failed: GitHub answered HTTP 503.",
  },
  {
    state: "cancelled" as const,
    toastMock: mockToastInfo,
    title: "The update on mini (command node) stopped",
    description: "The update was cancelled.",
  },
  {
    state: "postponed" as const,
    toastMock: mockToastInfo,
    title: "The update on mini (command node) stopped",
    description: "Postponed on mini. 2.37.4-beta installs the next time Orkestrator quits there.",
  },
])(
  "a $state update's final toast names the machine",
  async ({ state, toastMock, title, description }) => {
    connectedTo("mini", true);
    let publish: ((snapshot: HostMaintenanceSnapshot) => void) | undefined;
    spyOn(events, "listen").mockImplementation(async (event, handler) => {
      if (event === HOST_MAINTENANCE_EVENT) {
        publish = (payload) => handler({ payload } as never);
      }
      return () => undefined;
    });
    spyOn(backend, "getHostMaintenance").mockResolvedValue(
      hostMaintenanceSnapshotFixture({
        job: hostUpdateJobFixture({ state: "downloading", targetVersion: "2.37.4-beta" }),
      }),
    );
    render(<HostUpdateBanner />);
    await waitFor(() => expect(mockToastLoading).toHaveBeenCalled());
    act(() =>
      publish!(
        hostMaintenanceSnapshotFixture({
          revision: 2,
          job: hostUpdateJobFixture({
            state,
            targetVersion: "2.37.4-beta",
            error: state === "failed" ? "HttpError: 503" : null,
            // Long enough ago that a backend-served page would not reload.
            completedAt: "2026-01-01T00:00:00.000Z",
          }),
        }),
      ),
    );
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    const [shownTitle, options] = toastMock.mock.calls.at(-1) as [string, { description: string }];
    expect(shownTitle).toBe(title);
    expect(options.description).toBe(description);
  },
);
