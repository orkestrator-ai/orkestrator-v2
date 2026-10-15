import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import * as realNativeEvents from "@/lib/native/events";
import { BUNDLED_APP_VERSION } from "@/lib/app-version";
import { mockToastDismiss, mockToastWarning } from "../../../../tests/mocks/sonner";

const realBackendSnapshot = { ...realBackend };
const realNativeEventsSnapshot = { ...realNativeEvents };

let backendVersion: string | Error = BUNDLED_APP_VERSION;
const getAppVersion = mock(async () => {
  if (backendVersion instanceof Error) throw backendVersion;
  return backendVersion;
});
const handlers = new Map<string, (event: { payload: unknown }) => unknown>();

mock.module("@/lib/backend", () => ({ ...realBackendSnapshot, getAppVersion }));
mock.module("@/lib/native/events", () => ({
  ...realNativeEventsSnapshot,
  listen: async (event: string, handler: (event: { payload: unknown }) => unknown) => {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  },
}));

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("@/lib/native/events", () => realNativeEventsSnapshot);
});

const { BackendVersionReminder, VERSION_REMINDER_TOAST_ID } =
  await import("./BackendVersionReminder");
const { NATIVE_EVENT_STREAM_CONNECTED_EVENT } = realNativeEvents;

/** A version guaranteed to sort after whatever this bundle ships as. */
const NEWER_BACKEND = "999.0.0";

type WarningOptions = { id: string; description: string; onDismiss: () => void };

function lastWarning(): [string, WarningOptions] {
  return mockToastWarning.mock.calls.at(-1) as unknown as [string, WarningOptions];
}

async function reconnect() {
  await act(async () => {
    handlers.get(NATIVE_EVENT_STREAM_CONNECTED_EVENT)?.({ payload: undefined });
  });
}

beforeEach(() => {
  backendVersion = BUNDLED_APP_VERSION;
  getAppVersion.mockClear();
  handlers.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("BackendVersionReminder", () => {
  test("stays silent when the backend runs this bundle's version", async () => {
    render(<BackendVersionReminder />);
    await waitFor(() => expect(getAppVersion).toHaveBeenCalled());
    expect(mockToastWarning).not.toHaveBeenCalled();
  });

  test("reminds the user to update when the backend is newer", async () => {
    backendVersion = NEWER_BACKEND;
    render(<BackendVersionReminder />);

    await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(1));
    const [, options] = lastWarning();
    expect(options.id).toBe(VERSION_REMINDER_TOAST_ID);
    expect(options.description).toContain(NEWER_BACKEND);
    expect(options.description).toContain(BUNDLED_APP_VERSION);
  });

  test("ignores a backend that cannot name its version or cannot be reached", async () => {
    backendVersion = "0.0.0";
    render(<BackendVersionReminder />);
    await waitFor(() => expect(getAppVersion).toHaveBeenCalledTimes(1));

    backendVersion = new Error("offline");
    await reconnect();
    await waitFor(() => expect(getAppVersion).toHaveBeenCalledTimes(2));
    expect(mockToastWarning).not.toHaveBeenCalled();
  });

  test("rechecks on reconnect, which is when an upgraded backend returns", async () => {
    render(<BackendVersionReminder />);
    await waitFor(() => expect(getAppVersion).toHaveBeenCalledTimes(1));
    expect(mockToastWarning).not.toHaveBeenCalled();

    backendVersion = NEWER_BACKEND;
    await reconnect();
    await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(1));

    // Back in step: the reminder is withdrawn without counting as a dismissal.
    backendVersion = BUNDLED_APP_VERSION;
    await reconnect();
    await waitFor(() => expect(mockToastDismiss).toHaveBeenCalledWith(VERSION_REMINDER_TOAST_ID));
    lastWarning()[1].onDismiss();

    backendVersion = NEWER_BACKEND;
    await reconnect();
    await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(2));
  });

  test("does not repeat a reminder the user dismissed for the same versions", async () => {
    backendVersion = NEWER_BACKEND;
    render(<BackendVersionReminder />);
    await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(1));

    lastWarning()[1].onDismiss();
    await reconnect();
    await waitFor(() => expect(getAppVersion).toHaveBeenCalledTimes(2));
    expect(mockToastWarning).toHaveBeenCalledTimes(1);

    // A different version is a new mismatch and earns a new reminder.
    backendVersion = "999.0.1";
    await reconnect();
    await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(2));
  });

  test("does not stack a second reminder while one is showing", async () => {
    backendVersion = NEWER_BACKEND;
    render(<BackendVersionReminder />);
    await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(1));

    await reconnect();
    await waitFor(() => expect(getAppVersion).toHaveBeenCalledTimes(2));
    expect(mockToastWarning).toHaveBeenCalledTimes(1);
  });
});
