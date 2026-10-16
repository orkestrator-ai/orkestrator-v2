import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  hostMaintenanceSnapshotFixture,
  hostUpdateJobFixture,
} from "@orkestrator/protocol/testing/host-maintenance-fixtures";

import { BUNDLED_APP_VERSION } from "@/lib/app-version";
import * as backend from "@/lib/backend";
import {
  mockToastLoading,
  mockToastSuccess,
  mockToastWarning,
  resetSonnerMocks,
} from "../../../../tests/mocks/sonner";
import { HOST_UPDATE_TOAST_ID, HostUpdateBanner } from "./HostUpdateBanner";

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
