import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
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
let hostCanUpdate = false;
const getHostMaintenance = mock(async () => ({ updater: { available: hostCanUpdate } }));

mock.module("@/lib/backend", () => ({ ...realBackendSnapshot, getAppVersion, getHostMaintenance }));
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
const originalGateway = window.orkestratorGateway;
const originalOrkestrator = window.orkestrator;

type WarningOptions = {
  id: string;
  description: string;
  onDismiss: () => void;
  action?: { label: string; onClick: () => void };
};

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
  hostCanUpdate = false;
  getAppVersion.mockClear();
  handlers.clear();
  window.sessionStorage.clear();
  window.orkestrator = undefined;
  window.orkestratorGateway = undefined;
});

afterEach(() => {
  cleanup();
  window.orkestrator = originalOrkestrator;
  window.orkestratorGateway = originalGateway;
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

  test("offers to update an older backend whose host can update itself", async () => {
    backendVersion = "1.0.0";
    hostCanUpdate = true;
    window.orkestratorGateway = { enabled: true, baseUrl: "https://backend.example" };
    const opened: unknown[] = [];
    const listener = (event: Event) => opened.push((event as CustomEvent).detail);
    window.addEventListener("orkestrator:open-global-settings", listener);
    try {
      render(<BackendVersionReminder />);
      await waitFor(() => expect(mockToastWarning).toHaveBeenCalled());
      const [, options] = lastWarning();
      expect(options.action?.label).toBe("Update backend");
      options.action?.onClick();
      expect(opened).toEqual(["machines"]);
    } finally {
      window.removeEventListener("orkestrator:open-global-settings", listener);
    }
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

  test.each(["backend-served", "hosted"] as const)(
    "%s client attaches a Reload action that reloads the page",
    async (clientKind) => {
      if (clientKind === "hosted") {
        window.orkestratorGateway = { enabled: true, baseUrl: "https://backend.example" };
      }
      backendVersion = NEWER_BACKEND;
      const reload = spyOn(window.location, "reload").mockImplementation(() => {});
      try {
        render(<BackendVersionReminder />);
        await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(1));
        const [title, options] = lastWarning();
        expect(title).toBe(
          clientKind === "hosted" ? "This web app is out of date" : "Orkestrator has been updated",
        );
        expect(options.description).toContain(
          clientKind === "hosted"
            ? "Reload to get the latest web app"
            : "Reload to use the matching version",
        );
        expect(options.action?.label).toBe("Reload");
        expect(reload).not.toHaveBeenCalled();
        options.action!.onClick();
        expect(reload).toHaveBeenCalledTimes(1);
      } finally {
        reload.mockRestore();
      }
    },
  );

  test.each(["bundled", "remote"] as const)(
    "%s desktop client points to the app updater without a Reload action",
    async (connection) => {
      if (connection === "bundled") {
        window.orkestrator = { isolatedViewState: true } as Window["orkestrator"];
      } else {
        window.orkestratorGateway = {
          enabled: true,
          desktop: true,
          baseUrl: "https://backend.example",
        };
      }
      backendVersion = NEWER_BACKEND;
      render(<BackendVersionReminder />);
      await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(1));
      const [title, options] = lastWarning();
      expect(title).toBe("Update Orkestrator");
      expect(options.description).toContain("Check for Updates…");
      expect(options.action).toBeUndefined();
    },
  );

  test.each(["desktop", "hosted"] as const)(
    "%s client points to an older backend without a Reload action",
    async (clientKind) => {
      window.orkestratorGateway = {
        enabled: true,
        desktop: clientKind === "desktop",
        baseUrl: "https://backend.example",
      };
      backendVersion = "0.0.1";
      render(<BackendVersionReminder />);
      await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(1));
      const [title, options] = lastWarning();
      expect(title).toBe("The Orkestrator backend is out of date");
      expect(options.description).toContain("computer running the backend");
      expect(options.action).toBeUndefined();
    },
  );

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
    expect(mockToastDismiss).not.toHaveBeenCalled();
  });

  test("withdraws another version's toast when returning to a dismissed pair", async () => {
    backendVersion = NEWER_BACKEND;
    render(<BackendVersionReminder />);
    await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(1));
    lastWarning()[1].onDismiss();

    backendVersion = "999.0.1";
    await reconnect();
    await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(2));
    const otherWarning = lastWarning()[1];

    backendVersion = NEWER_BACKEND;
    await reconnect();
    await waitFor(() => expect(mockToastDismiss).toHaveBeenCalledWith(VERSION_REMINDER_TOAST_ID));
    expect(mockToastWarning).toHaveBeenCalledTimes(2);
    // A delayed dismissal callback for the withdrawn toast must not suppress it later.
    otherWarning.onDismiss();

    backendVersion = "999.0.1";
    await reconnect();
    await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(3));
  });
});
