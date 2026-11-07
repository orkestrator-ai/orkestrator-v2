import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as backend from "@/lib/backend";
import * as notificationSounds from "@/lib/notification-sounds";
import { useConfigStore } from "@/stores/configStore";
import { AccountMachineProvider } from "./account-machine";
import { MachineConfigProvider } from "./settings-config";
import { SoundsSettings } from "./SoundsSettings";

const originalConfig = structuredClone(useConfigStore.getState().config);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  useConfigStore.setState({ config: structuredClone(originalConfig) });
});

afterEach(() => {
  cleanup();
  mock.restore();
  useConfigStore.setState({ config: structuredClone(originalConfig) });
});

describe("SoundsSettings", () => {
  test("persists each event independently", async () => {
    const update = spyOn(backend, "updateNotificationSoundSettings").mockImplementation(
      async (notificationSounds) => ({
        ...useConfigStore.getState().config,
        global: { ...useConfigStore.getState().config.global, notificationSounds },
      }),
    );

    render(<SoundsSettings />);
    fireEvent.click(screen.getByRole("switch", { name: "Agent stopped sound" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[0]).toEqual({
      agentStopped: false,
      prMerged: true,
      coordinatorReport: true,
      agentQuestion: true,
      questionDesktopNotification: true,
    });
    expect(
      screen.getByRole("switch", { name: "Pull request merged sound" }).getAttribute("data-state"),
    ).toBe("checked");
    update.mockRestore();
  });

  test("combines rapid switch changes before React commits a new render", async () => {
    const update = spyOn(backend, "updateNotificationSoundSettings").mockImplementation(
      async (notificationSounds) => ({
        ...useConfigStore.getState().config,
        global: { ...useConfigStore.getState().config.global, notificationSounds },
      }),
    );

    render(<SoundsSettings />);
    fireEvent.click(screen.getByRole("switch", { name: "Agent stopped sound" }));
    fireEvent.click(screen.getByRole("switch", { name: "Pull request merged sound" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls.at(-1)?.[0]).toEqual({
      agentStopped: false,
      prMerged: false,
      coordinatorReport: true,
      agentQuestion: true,
      questionDesktopNotification: true,
    });
    update.mockRestore();
  });

  test("restores authoritative settings and reports the latest failed save", async () => {
    const authoritative = structuredClone(originalConfig);
    authoritative.global.notificationSounds = {
      agentStopped: true,
      prMerged: false,
      coordinatorReport: true,
      agentQuestion: true,
      questionDesktopNotification: true,
    };
    const update = spyOn(backend, "updateNotificationSoundSettings").mockRejectedValue(
      new Error("disk unavailable"),
    );
    const getConfig = spyOn(backend, "getConfig").mockResolvedValue(authoritative);
    const report = spyOn(toast, "error").mockImplementation(() => "toast-id");

    render(<SoundsSettings />);
    fireEvent.click(screen.getByRole("switch", { name: "Agent stopped sound" }));

    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1));
    expect(report).toHaveBeenCalledWith(
      "Sound settings were not saved",
      expect.objectContaining({ description: "disk unavailable" }),
    );
    expect(
      screen.getByRole("switch", { name: "Pull request merged sound" }).getAttribute("data-state"),
    ).toBe("unchecked");

    report.mockRestore();
    getConfig.mockRestore();
    update.mockRestore();
  });

  test("does not let a superseded failed save restore stale settings", async () => {
    const first = deferred<Awaited<ReturnType<typeof backend.updateNotificationSoundSettings>>>();
    const update = spyOn(backend, "updateNotificationSoundSettings")
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async (notificationSounds) => ({
        ...useConfigStore.getState().config,
        global: { ...useConfigStore.getState().config.global, notificationSounds },
      }));
    const getConfig = spyOn(backend, "getConfig").mockResolvedValue(
      structuredClone(originalConfig),
    );

    render(<SoundsSettings />);
    fireEvent.click(screen.getByRole("switch", { name: "Agent stopped sound" }));
    fireEvent.click(screen.getByRole("switch", { name: "Pull request merged sound" }));
    first.reject(new Error("first save failed"));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Pull request merged sound" })
          .getAttribute("data-state"),
      ).toBe("unchecked"),
    );
    expect(getConfig).not.toHaveBeenCalled();
    expect(update.mock.calls.at(-1)?.[0]).toEqual({
      agentStopped: false,
      prMerged: false,
      coordinatorReport: true,
      agentQuestion: true,
      questionDesktopNotification: true,
    });

    getConfig.mockRestore();
    update.mockRestore();
  });

  test("keeps the optimistic state when both save and recovery reads fail", async () => {
    const update = spyOn(backend, "updateNotificationSoundSettings").mockRejectedValue(
      new Error("write failed"),
    );
    const getConfig = spyOn(backend, "getConfig").mockRejectedValue(new Error("read failed"));
    const report = spyOn(toast, "error").mockImplementation(() => "toast-id");

    render(<SoundsSettings />);
    fireEvent.click(screen.getByRole("switch", { name: "Agent stopped sound" }));

    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1));
    expect(report).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("switch", { name: "Agent stopped sound" }).getAttribute("data-state"),
    ).toBe("unchecked");

    report.mockRestore();
    getConfig.mockRestore();
    update.mockRestore();
  });

  test("previews the two distinct cues even when their toggles are off", async () => {
    useConfigStore.getState().updateGlobalConfig({
      notificationSounds: {
        agentStopped: false,
        prMerged: false,
        coordinatorReport: true,
        agentQuestion: true,
        questionDesktopNotification: true,
      },
    });
    const play = spyOn(notificationSounds, "playNotificationSound").mockResolvedValue(true);

    render(<SoundsSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Preview Agent stopped" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview Pull request merged" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview Coordinator report" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview Agent question" }));

    await waitFor(() => expect(play).toHaveBeenCalledTimes(4));
    expect(play.mock.calls.map(([kind]) => kind)).toEqual([
      "agent-stopped",
      "pr-merged",
      "coordinator-report",
      "agent-question",
    ]);
    play.mockRestore();
  });
});

describe("question alerts", () => {
  const descriptor = Object.getOwnPropertyDescriptor(window, "Notification");
  let permission: NotificationPermission = "granted";
  const requestPermission = mock(async (): Promise<NotificationPermission> => {
    permission = "granted";
    return permission;
  });

  beforeEach(() => {
    permission = "granted";
    requestPermission.mockClear();
    function FakeNotification() {}
    Object.defineProperty(FakeNotification, "permission", { get: () => permission });
    Object.defineProperty(FakeNotification, "requestPermission", { value: requestPermission });
    Object.defineProperty(window, "Notification", { configurable: true, value: FakeNotification });
  });

  afterEach(() => {
    if (descriptor) Object.defineProperty(window, "Notification", descriptor);
    else delete (window as unknown as { Notification?: unknown }).Notification;
  });

  const saving = () =>
    spyOn(backend, "updateNotificationSoundSettings").mockImplementation(
      async (notificationSounds) => ({
        ...useConfigStore.getState().config,
        global: { ...useConfigStore.getState().config.global, notificationSounds },
      }),
    );

  test("the question cue and the desktop notification save independently", async () => {
    const update = saving();
    render(<SoundsSettings />);
    fireEvent.click(screen.getByRole("switch", { name: "Agent question sound" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[0]).toMatchObject({
      agentQuestion: false,
      questionDesktopNotification: true,
    });
    fireEvent.click(screen.getByRole("switch", { name: "Agent questions desktop notification" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]?.[0]).toMatchObject({
      agentQuestion: false,
      questionDesktopNotification: false,
    });
    // Already granted: nothing to ask, nothing to warn about.
    expect(requestPermission).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Allow notifications" }) === null).toBe(true);
    update.mockRestore();
  });

  test("a browser that has not decided is asked from the Allow button", async () => {
    permission = "default";
    render(<SoundsSettings />);
    expect(screen.getByText(/not been allowed to show notifications yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow notifications" }));
    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Allow notifications" }) === null).toBe(true),
    );
    expect(screen.queryByText(/not been allowed/) === null).toBe(true);
  });

  test("turning the notification on asks an undecided browser", async () => {
    permission = "default";
    useConfigStore.getState().updateGlobalConfig({
      notificationSounds: {
        agentStopped: true,
        prMerged: true,
        coordinatorReport: true,
        agentQuestion: true,
        questionDesktopNotification: false,
      },
    });
    const update = saving();
    render(<SoundsSettings />);
    fireEvent.click(screen.getByRole("switch", { name: "Agent questions desktop notification" }));
    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    update.mockRestore();
  });

  test("explains a blocked browser", () => {
    permission = "denied";
    render(<SoundsSettings />);
    expect(screen.getByText(/has blocked notifications/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow notifications" }) === null).toBe(true);
  });
});

// The command node itself is this window's own machine.
for (const machine of ["other"]) {
  test(`selected ${machine ?? "command node"} sound saves and recovery do not change leaf notification preferences`, async () => {
    const leaf = structuredClone(originalConfig);
    leaf.global.notificationSounds = {
      agentStopped: true,
      prMerged: true,
      coordinatorReport: true,
      agentQuestion: true,
      questionDesktopNotification: true,
    };
    useConfigStore.setState({ config: leaf });
    const selected = structuredClone(originalConfig);
    selected.global.notificationSounds = {
      agentStopped: true,
      prMerged: false,
      coordinatorReport: true,
      agentQuestion: true,
      questionDesktopNotification: true,
    };
    const read = spyOn(backend, "getConfig").mockImplementation(async (target) =>
      target === undefined ? leaf : selected,
    );
    let fail!: (cause: Error) => void;
    const update = spyOn(backend, "updateNotificationSoundSettings").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    try {
      render(
        <AccountMachineProvider value={{ machine, name: "Selected" }}>
          <MachineConfigProvider machine={machine}>
            <SoundsSettings />
          </MachineConfigProvider>
        </AccountMachineProvider>,
      );
      const toggle = await screen.findByRole("switch", { name: "Agent stopped sound" });
      expect(
        screen
          .getByRole("switch", { name: "Pull request merged sound" })
          .getAttribute("data-state"),
      ).toBe("unchecked");
      fireEvent.click(toggle);
      await waitFor(() =>
        expect(update).toHaveBeenCalledWith(
          {
            agentStopped: false,
            prMerged: false,
            coordinatorReport: true,
            agentQuestion: true,
            questionDesktopNotification: true,
          },
          machine,
        ),
      );
      expect(useConfigStore.getState().config.global.notificationSounds).toEqual({
        agentStopped: true,
        prMerged: true,
        coordinatorReport: true,
        agentQuestion: true,
        questionDesktopNotification: true,
      });
      await act(async () => fail(new Error("write failed")));
      await waitFor(() => expect(toggle.getAttribute("data-state")).toBe("checked"));
      expect(read.mock.calls.filter(([target]) => target === machine).length).toBe(2);
      expect(useConfigStore.getState().config.global.notificationSounds).toEqual({
        agentStopped: true,
        prMerged: true,
        coordinatorReport: true,
        agentQuestion: true,
        questionDesktopNotification: true,
      });
    } finally {
      cleanup();
    }
  });
}
