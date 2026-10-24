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
    expect(update.mock.calls.at(-1)?.[0]).toEqual({ agentStopped: false, prMerged: false });
    update.mockRestore();
  });

  test("restores authoritative settings and reports the latest failed save", async () => {
    const authoritative = structuredClone(originalConfig);
    authoritative.global.notificationSounds = { agentStopped: true, prMerged: false };
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
    expect(update.mock.calls.at(-1)?.[0]).toEqual({ agentStopped: false, prMerged: false });

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
      notificationSounds: { agentStopped: false, prMerged: false },
    });
    const play = spyOn(notificationSounds, "playNotificationSound").mockResolvedValue(true);

    render(<SoundsSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Preview Agent stopped" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview Pull request merged" }));

    await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
    expect(play.mock.calls.map(([kind]) => kind)).toEqual(["agent-stopped", "pr-merged"]);
    play.mockRestore();
  });
});

for (const machine of [null, "other"]) {
  test(`selected ${machine ?? "command node"} sound saves and recovery do not change leaf notification preferences`, async () => {
    window.orkestratorWorkspaceTarget = { nodeId: "leaf", nodeName: "Leaf", path: "direct" };
    const leaf = structuredClone(originalConfig);
    leaf.global.notificationSounds = { agentStopped: true, prMerged: true };
    useConfigStore.setState({ config: leaf });
    const selected = structuredClone(originalConfig);
    selected.global.notificationSounds = { agentStopped: true, prMerged: false };
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
        expect(update).toHaveBeenCalledWith({ agentStopped: false, prMerged: false }, machine),
      );
      expect(useConfigStore.getState().config.global.notificationSounds).toEqual({
        agentStopped: true,
        prMerged: true,
      });
      await act(async () => fail(new Error("write failed")));
      await waitFor(() => expect(toggle.getAttribute("data-state")).toBe("checked"));
      expect(read.mock.calls.filter(([target]) => target === machine).length).toBe(2);
      expect(useConfigStore.getState().config.global.notificationSounds).toEqual({
        agentStopped: true,
        prMerged: true,
      });
    } finally {
      cleanup();
      delete window.orkestratorWorkspaceTarget;
    }
  });
}
