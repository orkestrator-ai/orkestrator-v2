import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { hostMaintenanceSnapshotFixture } from "@orkestrator/protocol/testing/host-maintenance-fixtures";
import type { HostTask } from "@orkestrator/protocol/host-maintenance";

import * as backend from "@/lib/backend";
import { HostDependencySettings } from "./HostDependencySettings";
import { connectedHostClient as client } from "@/test/host-maintenance-client";

afterEach(() => {
  cleanup();
  mock.restore();
});

function task(kind: HostTask["kind"], overrides: Partial<HostTask> = {}): HostTask {
  return {
    id: `${kind}-1`,
    kind,
    state: "running",
    stage: "Downloading claude",
    error: null,
    result: null,
    startedAt: "2026-10-16T12:00:00.000Z",
    updatedAt: "2026-10-16T12:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

const detailed = hostMaintenanceSnapshotFixture({
  nextRelease: { version: "2.22.0", tools: { claude: "2.1.310", gh: "2.102.0" } },
  tools: [
    { name: "claude", pinnedVersion: "2.1.296", source: "managed", installedVersion: "2.1.296" },
    { name: "codex", pinnedVersion: "0.162.1", source: "path", installedVersion: null },
    {
      name: "gh",
      pinnedVersion: "2.102.0",
      source: "managed",
      installedVersion: "2.102.0",
      channel: "pinned",
    },
  ],
  image: {
    name: "orkestrator-v2:latest",
    present: true,
    compatible: true,
    reason: null,
    releaseReference: "ghcr.io/orkestrator-ai/orkestrator-v2:2.21.1",
    outdatedEnvironments: [{ id: "env-1", name: "feature-x", projectId: "p1" }],
  },
});

test("shows each tool's source and the next release's pins, and repairs on request", async () => {
  spyOn(backend, "getHostMaintenance").mockResolvedValue(detailed);
  const repair = spyOn(backend, "startHostToolchainRepair").mockResolvedValue(
    task("toolchain-repair"),
  );
  const accept = mock(() => undefined);
  render(<HostDependencySettings client={client} snapshot={detailed} accept={accept} />);
  expect(screen.getByText("on PATH (not managed)")).toBeTruthy();
  expect(screen.getByText("2.1.310")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Repair agent tools" }));
  await waitFor(() => expect(repair).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(accept).toHaveBeenCalled());
});

test("lists environments still on an older image and pulls the release image", async () => {
  spyOn(backend, "getHostMaintenance").mockResolvedValue(detailed);
  const pull = spyOn(backend, "startHostImageUpdate").mockResolvedValue(task("image-update"));
  render(<HostDependencySettings client={client} snapshot={detailed} accept={() => undefined} />);
  expect(screen.getByText("feature-x")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Pull ghcr.io/orkestrator-ai/orkestrator-v2:2.21.1" }),
  );
  await waitFor(() => expect(pull).toHaveBeenCalledTimes(1));
});

test("following the newest gh asks first", async () => {
  spyOn(backend, "getHostMaintenance").mockResolvedValue(detailed);
  const channel = spyOn(backend, "setHostGhChannel").mockResolvedValue(task("gh-update"));
  render(<HostDependencySettings client={client} snapshot={detailed} accept={() => undefined} />);
  fireEvent.click(screen.getByRole("switch", { name: "Follow the newest gh release" }));
  expect(await screen.findByText("Follow the newest gh release?")).toBeTruthy();
  expect(channel).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Use the newest gh" }));
  await waitFor(() => expect(channel).toHaveBeenCalledWith("latest"));
});

test("a running task shows its step", () => {
  const snapshot = { ...detailed, tasks: { "toolchain-repair": task("toolchain-repair") } };
  render(<HostDependencySettings client={client} snapshot={snapshot} accept={() => undefined} />);
  expect(screen.getByText("Downloading claude")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Repair agent tools" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

test("an unknown installed version is displayed as unavailable rather than as the pin", () => {
  render(
    <HostDependencySettings
      client={client}
      snapshot={{
        ...detailed,
        tools: [
          { name: "gh", source: "managed", pinnedVersion: "2.102.0", installedVersion: null },
        ],
      }}
      accept={() => undefined}
    />,
  );
  expect(screen.getByText("version unavailable")).toBeTruthy();
});
