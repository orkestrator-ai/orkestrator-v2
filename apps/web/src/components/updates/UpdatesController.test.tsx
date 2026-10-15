import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  LOCAL_UPDATE_STATUS_EVENT,
  OPEN_UPDATE_PANEL_EVENT,
  type UpdateStatusSnapshot,
} from "@orkestrator/protocol/updates";
import { listen } from "@/lib/native/events";
import { useUpdateStore } from "@/stores/updateStore";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { mockToastInfo, resetSonnerMocks } from "../../../../../tests/mocks/sonner";
import { UpdateIndicator, UpdatesController, UPDATE_AVAILABLE_TOAST_ID } from "./UpdatesController";

const originalOrkestrator = window.orkestrator;
// `@/lib/native/events` is mocked for every suite (tests/setup.ts); this file
// only routes that mock's handlers so a test can deliver events.
const listenMock = listen as unknown as ReturnType<typeof mock>;
const listeners = new Map<string, (payload: unknown) => void>();

function snapshot(revision: number, available: string | null): UpdateStatusSnapshot {
  return {
    revision,
    updateProtocol: 1,
    currentVersion: "2.21.0",
    currentChannel: "stable",
    channel: "stable",
    platform: "darwin",
    arch: "arm64",
    host: {
      kind: "desktop",
      installKind: "mac-app",
      canInstall: true,
      unavailableReason: null,
      hostVersion: "2.21.0",
      protocolVersion: 1,
    },
    automaticChecks: true,
    check: {
      status: "ok",
      checkedAt: null,
      error: null,
      resolution: available ? "update" : "up-to-date",
    },
    available: available
      ? {
          version: available,
          tag: `v${available}`,
          channel: "stable",
          requirementsSha256: "a".repeat(64),
          publishedAt: "x",
          diff: { fromVersion: "2.21.0", toVersion: available, baseline: "manifest", items: [] },
          compatibility: { minClientVersion: "2.20.0", minBackendVersion: "2.20.0" },
          downgrade: false,
        }
      : null,
    downgradeOption: null,
    job: null,
    notices: [],
  };
}

let current = snapshot(1, null);
const ipc = mock(async (_command: string) => current);

beforeEach(() => {
  resetSonnerMocks();
  ipc.mockClear();
  listeners.clear();
  current = snapshot(1, null);
  listenMock.mockImplementation(
    async (event: string, handler: (event: { payload: unknown }) => void) => {
      listeners.set(event, (payload) => handler({ payload }));
      return () => listeners.delete(event);
    },
  );
  window.orkestrator = {
    ...originalOrkestrator,
    updates: { invoke: ipc },
  } as unknown as typeof window.orkestrator;
});

afterEach(() => {
  cleanup();
  listenMock.mockImplementation(() => Promise.resolve(() => {}));
  window.orkestrator = originalOrkestrator;
  useUpdateStore.setState({ targets: new Map(), dialogOpen: false });
});

describe("UpdatesController", () => {
  test("reads this app's status on mount and follows the local status events", async () => {
    render(
      <>
        <UpdatesController />
        <UpdateIndicator />
      </>,
    );
    await waitFor(() => expect(ipc).toHaveBeenCalledWith("update_get_status", {}));
    expectDomAbsent(screen.queryByTestId("update-indicator"));
    act(() =>
      listeners.get(LOCAL_UPDATE_STATUS_EVENT)?.({ revision: 2, snapshot: snapshot(2, "2.22.0") }),
    );
    await waitFor(() => expect(screen.getByTestId("update-indicator")).toBeTruthy());
    expect(mockToastInfo).toHaveBeenCalledTimes(1);
    expect(mockToastInfo.mock.calls[0]?.[0]).toBe("Orkestrator 2.22.0 is available");
    const options = mockToastInfo.mock.calls[0]?.[1] as { id: string } | undefined;
    expect(options?.id).toBe(UPDATE_AVAILABLE_TOAST_ID);
    // The same version is announced once.
    act(() =>
      listeners.get(LOCAL_UPDATE_STATUS_EVENT)?.({ revision: 3, snapshot: snapshot(3, "2.22.0") }),
    );
    expect(mockToastInfo).toHaveBeenCalledTimes(1);
  });

  test("the menu and the indicator open the update dialog", async () => {
    current = snapshot(1, "2.22.0");
    render(
      <>
        <UpdatesController />
        <UpdateIndicator />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("update-indicator")).toBeTruthy());
    act(() => listeners.get(OPEN_UPDATE_PANEL_EVENT)?.(undefined));
    await waitFor(() => expect(screen.getByTestId("update-dialog")).toBeTruthy());
    expect(screen.getByTestId("update-offer").textContent).toContain("Update to 2.22.0");
    act(() => useUpdateStore.getState().setDialogOpen(false));
    act(() => screen.getByTestId("update-indicator").click());
    await waitFor(() => expect(useUpdateStore.getState().dialogOpen).toBe(true));
  });

  test("a stale event triggers an authoritative re-read", async () => {
    current = snapshot(5, null);
    render(<UpdatesController />);
    await waitFor(() => expect(ipc).toHaveBeenCalledTimes(1));
    act(() =>
      listeners.get(LOCAL_UPDATE_STATUS_EVENT)?.({ revision: 1, snapshot: snapshot(1, "2.22.0") }),
    );
    await waitFor(() => expect(ipc).toHaveBeenCalledTimes(2));
  });
});
