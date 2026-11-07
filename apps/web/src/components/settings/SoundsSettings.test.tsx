import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as backend from "@/lib/backend";
import * as notificationSounds from "@/lib/notification-sounds";
import { configStore } from "@/stores/configStore";
import { AccountMachineProvider } from "./account-machine";
import { MachineConfigProvider } from "./settings-config";
import { SoundsSettings } from "./SoundsSettings";
import { appCommandStore } from "@/test/app-command-store";

const originalConfig = structuredClone(appCommandStore(configStore).getState().config);

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
  appCommandStore(configStore).setState({ config: structuredClone(originalConfig) });
});

afterEach(() => {
  cleanup();
  mock.restore();
  appCommandStore(configStore).setState({ config: structuredClone(originalConfig) });
});

describe("SoundsSettings", () => {
  test("persists each event independently", async () => {
    const update = spyOn(backend, "updateNotificationSoundSettings").mockImplementation(
      async (notificationSounds) => ({
        ...appCommandStore(configStore).getState().config,
        global: { ...appCommandStore(configStore).getState().config.global, notificationSounds },
      }),
    );

    renderInAppCommandScope(<SoundsSettings />);
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
        ...appCommandStore(configStore).getState().config,
        global: { ...appCommandStore(configStore).getState().config.global, notificationSounds },
      }),
    );

    renderInAppCommandScope(<SoundsSettings />);
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

    renderInAppCommandScope(<SoundsSettings />);
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
        ...appCommandStore(configStore).getState().config,
        global: { ...appCommandStore(configStore).getState().config.global, notificationSounds },
      }));
    const getConfig = spyOn(backend, "getConfig").mockResolvedValue(
      structuredClone(originalConfig),
    );

    renderInAppCommandScope(<SoundsSettings />);
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

    renderInAppCommandScope(<SoundsSettings />);
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
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        notificationSounds: {
          agentStopped: false,
          prMerged: false,
          coordinatorReport: true,
          agentQuestion: true,
          questionDesktopNotification: true,
        },
      });
    const play = spyOn(notificationSounds, "playNotificationSound").mockResolvedValue(true);

    renderInAppCommandScope(<SoundsSettings />);
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
        ...appCommandStore(configStore).getState().config,
        global: { ...appCommandStore(configStore).getState().config.global, notificationSounds },
      }),
    );

  test("the question cue and the desktop notification save independently", async () => {
    const update = saving();
    renderInAppCommandScope(<SoundsSettings />);
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
    renderInAppCommandScope(<SoundsSettings />);
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
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        notificationSounds: {
          agentStopped: true,
          prMerged: true,
          coordinatorReport: true,
          agentQuestion: true,
          questionDesktopNotification: false,
        },
      });
    const update = saving();
    renderInAppCommandScope(<SoundsSettings />);
    fireEvent.click(screen.getByRole("switch", { name: "Agent questions desktop notification" }));
    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    update.mockRestore();
  });

  test("explains a blocked browser", () => {
    permission = "denied";
    renderInAppCommandScope(<SoundsSettings />);
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
    appCommandStore(configStore).setState({ config: leaf });
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
      renderInAppCommandScope(
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
      expect(appCommandStore(configStore).getState().config.global.notificationSounds).toEqual({
        agentStopped: true,
        prMerged: true,
        coordinatorReport: true,
        agentQuestion: true,
        questionDesktopNotification: true,
      });
      await act(async () => fail(new Error("write failed")));
      await waitFor(() => expect(toggle.getAttribute("data-state")).toBe("checked"));
      expect(read.mock.calls.filter(([target]) => target === machine).length).toBe(2);
      expect(appCommandStore(configStore).getState().config.global.notificationSounds).toEqual({
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
