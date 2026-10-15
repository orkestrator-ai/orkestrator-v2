import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConnectionSummary } from "@orkestrator/protocol/connections";
import type { GatewayStatusPayload, UpdateStatusSnapshot } from "@orkestrator/protocol/updates";
import { useUpdateStore } from "@/stores/updateStore";
import { connectionUpdateTransport } from "@/lib/updates/remote-update-client";
import { RemoteUpdateSummary } from "./RemoteUpdateSummary";
import { macOsPermissionsAddedByUpdates } from "./update-text";

const originalOrkestrator = window.orkestrator;
const connection: ConnectionSummary = {
  id: "remote-a",
  name: "build-box",
  address: "https://build-box.tailnet.ts.net",
  kind: "remote",
  active: false,
  requiresToken: false,
};

let status: GatewayStatusPayload | null = null;
const statusCall = mock(async (_id: string) => status);
const invokeUpdate = mock(async (_id: string, command: string) => {
  if (command === "update_get_status") {
    return {
      revision: 1,
      updateProtocol: 1,
      currentVersion: "2.21.0",
      currentChannel: "stable",
      channel: "stable",
      platform: "linux",
      arch: "x64",
      host: {
        kind: "supervisor",
        installKind: "npm-package",
        canInstall: true,
        unavailableReason: null,
        hostVersion: "2.21.0",
        protocolVersion: 1,
      },
      automaticChecks: true,
      check: { status: "ok", checkedAt: null, error: null, resolution: "update" },
      available: {
        version: "2.22.0",
        tag: "v2.22.0",
        channel: "stable",
        requirementsSha256: "a".repeat(64),
        publishedAt: "x",
        diff: { fromVersion: "2.21.0", toVersion: "2.22.0", baseline: "manifest", items: [] },
        compatibility: { minClientVersion: "2.0.0", minBackendVersion: "2.0.0" },
        downgrade: false,
      },
      downgradeOption: null,
      job: null,
      notices: [],
    } satisfies UpdateStatusSnapshot;
  }
  return null;
});

beforeEach(() => {
  statusCall.mockClear();
  invokeUpdate.mockClear();
  window.orkestrator = {
    ...originalOrkestrator,
    connections: { status: statusCall, invokeUpdate },
  } as unknown as typeof window.orkestrator;
});

afterEach(() => {
  cleanup();
  window.orkestrator = originalOrkestrator;
  useUpdateStore.setState({ targets: new Map(), dialogOpen: false });
});

describe("RemoteUpdateSummary", () => {
  test("shows a remote's version, channel and host, and offers Update remote", async () => {
    status = {
      ok: true,
      appVersion: "2.21.0",
      updateProtocol: 1,
      host: { kind: "supervisor", installKind: "npm-package", canInstall: true },
      updates: { channel: "beta", available: "2.22.0-beta.1", jobPhase: null },
    };
    render(<RemoteUpdateSummary connection={connection} />);
    await waitFor(() =>
      expect(screen.getByTestId("remote-update-summary").textContent).toContain("2.21.0"),
    );
    const text = screen.getByTestId("remote-update-summary").textContent ?? "";
    expect(text).toContain("Beta");
    expect(text).toContain("supervised backend");
    expect(text).toContain("2.22.0-beta.1 available");
    fireEvent.click(screen.getByRole("button", { name: "Updates for build-box" }));
    await waitFor(() => expect(screen.getByTestId("remote-update-dialog")).toBeTruthy());
    await waitFor(() =>
      expect(invokeUpdate).toHaveBeenCalledWith("remote-a", "update_get_status", {}),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /Update remote/ })).toBeTruthy());
  });

  test("an older backend or an unreachable one is reported, not hidden", async () => {
    status = { ok: true };
    render(<RemoteUpdateSummary connection={connection} />);
    await waitFor(() =>
      expect(screen.getByTestId("remote-update-summary").textContent).toContain("predates"),
    );
    cleanup();
    status = null;
    render(<RemoteUpdateSummary connection={connection} />);
    await waitFor(() =>
      expect(screen.getByTestId("remote-update-summary").textContent).toContain("unreachable"),
    );
  });
});

describe("the remote transport", () => {
  test("sends commands to that connection and keys its state apart from this app's", async () => {
    const transport = connectionUpdateTransport("remote-a");
    expect(transport.key).toBe("connection:remote-a");
    await transport.invoke("update_check");
    expect(invokeUpdate).toHaveBeenCalledWith("remote-a", "update_check", {});
  });

  test("refuses where this app cannot reach other machines", async () => {
    window.orkestrator = originalOrkestrator;
    await expect(connectionUpdateTransport("remote-a").invoke("update_check")).rejects.toThrow(
      "cannot update other machines",
    );
  });
});

test("permissions an update asked for are listed by version", () => {
  const added = macOsPermissionsAddedByUpdates([
    {
      id: "n",
      kind: "action-needed-on-host",
      jobId: "j",
      version: "2.22.0",
      createdAt: "x",
      message: "m",
      items: [
        {
          id: "macos-permission:downloads",
          category: "macos-permission",
          change: "added",
          title: "t",
          detail: "d",
          consent: true,
          actionOnHost: true,
          blocking: false,
        },
      ],
    },
    {
      id: "s",
      kind: "update-succeeded",
      jobId: "j",
      version: "2.22.0",
      createdAt: "x",
      message: "m",
      items: [],
    },
  ]);
  expect([...added]).toEqual([["downloads", "2.22.0"]]);
});
