import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realNotificationSounds from "@/lib/notification-sounds";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useUIStore } from "@/stores/uiStore";
import type { Environment } from "@/types";

const playConfiguredNotificationSound = mock(async () => true);
const primeNotificationSounds = mock(async () => true);

mock.module("@/lib/notification-sounds", () => ({
  ...realNotificationSounds,
  isNotificationSoundEnabled: () => true,
  playConfiguredNotificationSound,
  primeNotificationSounds,
}));

const { useNotificationSoundService } = await import("./useNotificationSoundService");

function environment(id: string, hasUnreadWork: boolean): Environment {
  return {
    id,
    projectId: "project-1",
    name: id,
    status: "running",
    order: 0,
    hasUnreadWork,
  } as Environment;
}

beforeEach(() => {
  playConfiguredNotificationSound.mockReset();
  playConfiguredNotificationSound.mockResolvedValue(true);
  primeNotificationSounds.mockReset();
  primeNotificationSounds.mockResolvedValue(true);
  useEnvironmentStore.setState({ environments: [] });
  useUIStore.setState({ selectedEnvironmentId: null });
  useConfigStore.getState().updateGlobalConfig({
    notificationSounds: { agentStopped: true, prMerged: true },
  });
});

afterEach(cleanup);

describe("useNotificationSoundService", () => {
  test("sounds only for a newly raised completed-activity bell", () => {
    useEnvironmentStore.setState({
      environments: [environment("existing-unread", true), environment("worker", false)],
    });
    renderHook(() => useNotificationSoundService());

    act(() => {
      useEnvironmentStore.setState({
        environments: [environment("existing-unread", true), environment("worker", true)],
      });
    });

    expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);
    expect(playConfiguredNotificationSound).toHaveBeenCalledWith("agent-stopped");

    act(() => {
      useEnvironmentStore.setState({
        environments: [environment("existing-unread", true), environment("worker", true)],
      });
    });
    expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);
  });

  test("baselines a newly hydrated unread environment without replaying it", () => {
    renderHook(() => useNotificationSoundService());
    act(() => {
      useEnvironmentStore.setState({ environments: [environment("late-snapshot", true)] });
    });
    expect(playConfiguredNotificationSound).not.toHaveBeenCalled();
  });

  test("does not replay a cue when the selected environment unread clear is reconciled", () => {
    useUIStore.setState({ selectedEnvironmentId: "worker" });
    useEnvironmentStore.setState({ environments: [environment("worker", true)] });
    renderHook(() => useNotificationSoundService());

    act(() => {
      useEnvironmentStore.setState({ environments: [environment("worker", false)] });
    });
    act(() => {
      useEnvironmentStore.setState({ environments: [environment("worker", true)] });
    });

    expect(playConfiguredNotificationSound).not.toHaveBeenCalled();
  });

  test("coalesces simultaneous completion edges into one cue", () => {
    useEnvironmentStore.setState({
      environments: [
        environment("one", false),
        environment("two", false),
        environment("three", false),
      ],
    });
    renderHook(() => useNotificationSoundService());

    act(() => {
      useEnvironmentStore.setState({
        environments: [
          environment("one", true),
          environment("two", true),
          environment("three", true),
        ],
      });
    });

    expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);
  });

  test("retries audio priming after a gesture fails and unregisters after success", async () => {
    primeNotificationSounds.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    renderHook(() => useNotificationSoundService());

    await act(async () => {
      window.dispatchEvent(new Event("pointerdown"));
      await Promise.resolve();
    });
    await act(async () => {
      window.dispatchEvent(new Event("pointerdown"));
      await Promise.resolve();
    });
    window.dispatchEvent(new Event("keydown"));

    expect(primeNotificationSounds).toHaveBeenCalledTimes(2);
  });

  test("does not register priming work when both cues are disabled", () => {
    useConfigStore.getState().updateGlobalConfig({
      notificationSounds: { agentStopped: false, prMerged: false },
    });
    renderHook(() => useNotificationSoundService());

    window.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("keydown"));

    expect(primeNotificationSounds).not.toHaveBeenCalled();
  });
});
