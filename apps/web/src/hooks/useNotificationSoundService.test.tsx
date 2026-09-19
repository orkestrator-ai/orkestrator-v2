import { act, cleanup, renderHook } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realNotificationSounds from "@/lib/notification-sounds";
import { useEnvironmentStore } from "@/stores/environmentStore";
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
  playConfiguredNotificationSound.mockClear();
  primeNotificationSounds.mockClear();
  useEnvironmentStore.setState({ environments: [] });
});

afterEach(cleanup);

afterAll(() => {
  mock.module("@/lib/notification-sounds", () => realNotificationSounds);
});

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
});
