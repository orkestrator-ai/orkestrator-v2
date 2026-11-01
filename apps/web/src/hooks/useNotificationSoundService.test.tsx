import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ENVIRONMENT_ATTENTION_EVENT } from "@orkestrator/protocol/environment-attention";
import { resetClientStateCapabilitiesForTests } from "@/lib/client-state-capabilities";
import { listen as nativeListen } from "@/lib/native/events";
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

afterEach(() => {
  cleanup();
  resetClientStateCapabilitiesForTests();
  listenMock.mockImplementation(() => Promise.resolve(() => {}));
});

const listenMock = nativeListen as unknown as ReturnType<typeof mock>;

describe("from the backend's attention events", () => {
  const handlers = new Set<(event: { payload: unknown }) => void>();
  const attention = (environmentId: string, attentionId: string) => ({
    attentionId,
    environmentId,
    projectId: "project-1",
    reason: "agent_finished",
    occurredAt: new Date(0).toISOString(),
  });
  const deliver = (payload: unknown) => {
    for (const handler of handlers) handler({ payload });
  };
  async function mounted() {
    const view = renderHook(() => useNotificationSoundService());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(handlers.size).toBe(1);
    return view;
  }

  beforeEach(() => {
    handlers.clear();
    resetClientStateCapabilitiesForTests({
      coordinatorPaneLayouts: false,
      coordinatorUpstreamMerge: false,
      noticeDismissals: false,
      environmentAttention: true,
    });
    listenMock.mockImplementation(
      (event: string, handler: (event: { payload: unknown }) => void) => {
        if (event !== ENVIRONMENT_ATTENTION_EVENT) return Promise.resolve(() => {});
        handlers.add(handler);
        return Promise.resolve(() => handlers.delete(handler));
      },
    );
  });

  test("sounds once for an event, however often it is delivered", async () => {
    await mounted();
    deliver(attention("worker", "a1"));
    deliver(attention("worker", "a1"));
    expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);
    expect(playConfiguredNotificationSound).toHaveBeenCalledWith("agent-stopped");
  });

  test("stays quiet for the environment on screen, and for malformed payloads", async () => {
    useUIStore.setState({ selectedEnvironmentId: "worker" });
    await mounted();
    deliver(attention("worker", "a1"));
    deliver({ environmentId: "other" });
    expect(playConfiguredNotificationSound).not.toHaveBeenCalled();
    deliver(attention("other", "a2"));
    expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);
  });

  test("environments finishing together are one cue", async () => {
    await mounted();
    deliver(attention("one", "a1"));
    deliver(attention("two", "a2"));
    deliver(attention("three", "a3"));
    expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);
  });

  test("ignores badge edges, which the event already covers", async () => {
    useEnvironmentStore.setState({ environments: [environment("worker", false)] });
    await mounted();
    act(() => {
      useEnvironmentStore.setState({ environments: [environment("worker", true)] });
    });
    expect(playConfiguredNotificationSound).not.toHaveBeenCalled();
  });

  test("stops listening on unmount", async () => {
    const view = await mounted();
    view.unmount();
    expect(handlers.size).toBe(0);
  });
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

test("Home completion sounds while the board obscures it, but not while Home is visible", () => {
  const home = { ...environment("home", false), projectHome: true };
  useEnvironmentStore.setState({ environments: [home] });
  useUIStore.setState({ selectedEnvironmentId: home.id, projectBoardTab: "kanban" });
  renderHook(() => useNotificationSoundService());
  act(() => useEnvironmentStore.getState().updateEnvironment(home.id, { hasUnreadWork: true }));
  expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);
  act(() => {
    useUIStore.getState().setProjectBoardTab("home");
    useEnvironmentStore.getState().updateEnvironment(home.id, { hasUnreadWork: false });
  });
  act(() => useEnvironmentStore.getState().updateEnvironment(home.id, { hasUnreadWork: true }));
  expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);
});
