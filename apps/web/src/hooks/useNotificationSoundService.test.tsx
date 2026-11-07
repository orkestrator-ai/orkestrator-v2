import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  COORDINATOR_WAKE_ATTENTION_EVENT,
  ENVIRONMENT_ATTENTION_EVENT,
} from "@orkestrator/protocol/environment-attention";
import { useActiveCoordinatorConversationStore } from "@/stores/activeCoordinatorConversationStore";
import { resetClientStateCapabilitiesForTests } from "@/lib/client-state-capabilities";
import { listen as nativeListen } from "@/lib/native/events";
import * as realNotificationSounds from "@/lib/notification-sounds";
import { configStore } from "@/stores/configStore";
import { environmentStore } from "@/stores/environmentStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { uiStore } from "@/stores/uiStore";
import type { Environment } from "@/types";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import { appCommandStore } from "@/test/app-command-store";

/** Outside a node scope provider, components act for the app's command node. */
const commandNodeId = () => getWindowScope().commandScope().nodeId;

const playConfiguredNotificationSound = mock(async (_kind: string) => true);
const primeNotificationSounds = mock(async () => true);

mock.module("@/lib/notification-sounds", () => ({
  ...realNotificationSounds,
  isNotificationSoundEnabled: () => true,
  playConfiguredNotificationSound,
  primeNotificationSounds,
}));

const { useNotificationSoundService } = await import("./useNotificationSoundService");
const { __testing: desktopNotifications } = await import("@/lib/question-desktop-notification");

interface ShownNotification {
  title: string;
  options: NotificationOptions;
  listeners: Map<string, () => void>;
  closed: boolean;
}
const shownNotifications: ShownNotification[] = [];
class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = async () => FakeNotification.permission;
  private readonly shown: ShownNotification;
  constructor(title: string, options: NotificationOptions = {}) {
    this.shown = { title, options, listeners: new Map(), closed: false };
    shownNotifications.push(this.shown);
  }
  addEventListener(event: string, listener: () => void) {
    this.shown.listeners.set(event, listener);
  }
  close() {
    this.shown.closed = true;
  }
}
const notificationDescriptor = Object.getOwnPropertyDescriptor(window, "Notification");
const hasFocusDescriptor = Object.getOwnPropertyDescriptor(document, "hasFocus");

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
  useRemoteWorkspaceStore.setState({ active: null, openNodes: [], requests: {} });
  getWindowScope().select(null);
  playConfiguredNotificationSound.mockReset();
  playConfiguredNotificationSound.mockResolvedValue(true);
  primeNotificationSounds.mockReset();
  primeNotificationSounds.mockResolvedValue(true);
  appCommandStore(environmentStore).setState({ environments: [] });
  appCommandStore(uiStore).setState({ selectedEnvironmentId: null });
  appCommandStore(configStore)
    .getState()
    .updateGlobalConfig({
      notificationSounds: {
        agentStopped: true,
        prMerged: true,
        coordinatorReport: true,
        agentQuestion: true,
        questionDesktopNotification: true,
      },
    });
});

beforeEach(() => {
  shownNotifications.length = 0;
  desktopNotifications.reset();
  FakeNotification.permission = "granted";
  Object.defineProperty(window, "Notification", { configurable: true, value: FakeNotification });
});

afterEach(() => {
  if (notificationDescriptor) Object.defineProperty(window, "Notification", notificationDescriptor);
  else delete (window as unknown as { Notification?: unknown }).Notification;
  if (hasFocusDescriptor) Object.defineProperty(document, "hasFocus", hasFocusDescriptor);
  else delete (document as unknown as { hasFocus?: unknown }).hasFocus;
  cleanup();
  resetClientStateCapabilitiesForTests();
  listenMock.mockImplementation(() => Promise.resolve(() => {}));
});

const listenMock = nativeListen as unknown as ReturnType<typeof mock>;

describe("when a coordinator is woken for its worker", () => {
  const handlers = new Set<(event: { payload: unknown }) => void>();
  const wake = (attentionId: string, projectId = "project-1") => ({
    attentionId,
    projectId,
    coordinatorId: "coordinator-1",
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
    return view;
  }
  const showCoordinator = () => {
    appCommandStore(uiStore).setState({
      selectedProjectId: "project-1",
      projectBoardTab: "coordinator",
    });
    useActiveCoordinatorConversationStore.setState({
      active: {
        nodeId: commandNodeId(),
        projectId: "project-1",
        tabId: "coordinator-tab",
        data: { platform: "claude", environmentId: "coordinator:c:c", isLocal: true },
      },
    });
  };

  beforeEach(() => {
    handlers.clear();
    useActiveCoordinatorConversationStore.setState({ active: null });
    appCommandStore(uiStore).setState({
      selectedProjectId: null,
      projectBoardTab: "board" as never,
    });
    listenMock.mockImplementation(
      (event: string, handler: (event: { payload: unknown }) => void) => {
        if (event !== COORDINATOR_WAKE_ATTENTION_EVENT) return Promise.resolve(() => {});
        handlers.add(handler);
        return Promise.resolve(() => handlers.delete(handler));
      },
    );
  });

  test("sounds its own cue once per wake, however often it is delivered", async () => {
    await mounted();
    deliver(wake("w1"));
    deliver(wake("w1"));
    expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);
    expect(playConfiguredNotificationSound).toHaveBeenCalledWith("coordinator-report");
  });

  test("stays quiet for a malformed payload", async () => {
    await mounted();
    deliver({ attentionId: "w1" });
    expect(playConfiguredNotificationSound).not.toHaveBeenCalled();
  });

  test("stays quiet while that coordinator is on screen, and not for another project's", async () => {
    showCoordinator();
    await mounted();
    deliver(wake("w1"));
    expect(playConfiguredNotificationSound).not.toHaveBeenCalled();
    deliver(wake("w2", "project-2"));
    expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);
  });

  test("sounds when a remote workspace covers the selected coordinator", async () => {
    showCoordinator();
    await mounted();
    // The window's selection moves to the leaf's workspace.
    act(() =>
      useRemoteWorkspaceStore
        .getState()
        .open("bk_leaf", { projectId: "remote-project", environmentId: "remote-env" }),
    );
    deliver(wake("remote-covered"));
    expect(playConfiguredNotificationSound).toHaveBeenCalledWith("coordinator-report");
  });

  test("sounds when the user has left the page, even with the coordinator selected", async () => {
    showCoordinator();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    try {
      await mounted();
      deliver(wake("w1"));
      expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);
    } finally {
      delete (document as unknown as { visibilityState?: string }).visibilityState;
    }
  });
});

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
      coordinatorUpstreamAutoMerge: false,
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
    appCommandStore(uiStore).setState({ selectedEnvironmentId: "worker" });
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
    appCommandStore(environmentStore).setState({ environments: [environment("worker", false)] });
    await mounted();
    act(() => {
      appCommandStore(environmentStore).setState({ environments: [environment("worker", true)] });
    });
    expect(playConfiguredNotificationSound).not.toHaveBeenCalled();
  });

  describe("when an agent needs input", () => {
    const question = (environmentId: string, attentionId: string, reason = "agent_question") => ({
      ...attention(environmentId, attentionId),
      reason,
    });
    const focus = (focused: boolean) =>
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => focused });

    test("plays the question cue, not the stop cue, and shows one notification", async () => {
      appCommandStore(environmentStore).setState({ environments: [environment("worker", true)] });
      await mounted();
      deliver(question("worker", "q1"));
      await act(async () => {});
      deliver(question("worker", "q1"));
      await act(async () => {});
      expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);
      expect(playConfiguredNotificationSound).toHaveBeenCalledWith("agent-question");
      expect(shownNotifications).toHaveLength(1);
      expect(shownNotifications[0]).toMatchObject({
        title: "Agent asked a question",
        options: { tag: "orkestrator-question:worker", silent: true },
      });
      expect(shownNotifications[0]!.options.body).toContain("worker");
    });

    test("allows OS sound when app playback fails", async () => {
      playConfiguredNotificationSound.mockResolvedValue(false);
      await mounted();
      deliver(question("worker", "failed-audio"));
      await waitFor(() => expect(shownNotifications).toHaveLength(1));
      expect(shownNotifications[0]!.options.silent).toBe(false);
    });

    test("treats an agent waiting on approval the same way", async () => {
      await mounted();
      deliver(question("worker", "w1", "agent_waiting"));
      await act(async () => {});
      expect(playConfiguredNotificationSound).toHaveBeenCalledWith("agent-question");
      expect(shownNotifications[0]?.title).toBe("Agent needs your input");
    });

    test("stays quiet only while that environment is on screen in a focused window", async () => {
      appCommandStore(uiStore).setState({ selectedEnvironmentId: "worker" });
      focus(true);
      await mounted();
      deliver(question("worker", "q1"));
      await act(async () => {});
      expect(playConfiguredNotificationSound).not.toHaveBeenCalled();
      expect(shownNotifications).toHaveLength(0);

      focus(false);
      deliver(question("worker", "q2"));
      await act(async () => {});
      expect(playConfiguredNotificationSound).toHaveBeenCalledWith("agent-question");
      expect(shownNotifications).toHaveLength(1);
    });

    test("is not swallowed by a stop cue that just played", async () => {
      await mounted();
      deliver(attention("one", "a1"));
      deliver(question("two", "q1"));
      await act(async () => {});
      deliver(question("three", "q2"));
      await act(async () => {});
      expect(playConfiguredNotificationSound.mock.calls.map((call) => call[0])).toEqual([
        "agent-stopped",
        "agent-question",
      ]);
      // Each environment still gets its own notification.
      await act(async () => {});
      expect(shownNotifications.map((shown) => shown.options.tag)).toEqual([
        "orkestrator-question:two",
        "orkestrator-question:three",
      ]);
    });

    test("follows each setting on its own", async () => {
      appCommandStore(configStore)
        .getState()
        .updateGlobalConfig({
          notificationSounds: {
            agentStopped: true,
            prMerged: true,
            coordinatorReport: true,
            agentQuestion: false,
            questionDesktopNotification: true,
          },
        });
      await mounted();
      deliver(question("worker", "q1"));
      await act(async () => {});
      expect(playConfiguredNotificationSound).not.toHaveBeenCalled();
      // With no app cue, the operating system may sound its own.
      expect(shownNotifications[0]?.options.silent).toBe(false);

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
      deliver(question("worker", "q2"));
      await act(async () => {});
      expect(playConfiguredNotificationSound).toHaveBeenCalledWith("agent-question");
      expect(shownNotifications).toHaveLength(1);
    });

    test("shows nothing without the browser's permission", async () => {
      FakeNotification.permission = "default";
      await mounted();
      deliver(question("worker", "q1"));
      await act(async () => {});
      expect(shownNotifications).toHaveLength(0);
      expect(playConfiguredNotificationSound).toHaveBeenCalledWith("agent-question");
    });

    test("clicking the notification opens the environment", async () => {
      await mounted();
      deliver(question("worker", "q1"));
      await act(async () => {});
      act(() => shownNotifications[0]!.listeners.get("click")!());
      expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe("worker");
      expect(appCommandStore(uiStore).getState().selectedProjectId).toBe("project-1");
      expect(shownNotifications[0]!.closed).toBe(true);
    });
  });

  test("stops listening on unmount", async () => {
    const view = await mounted();
    view.unmount();
    expect(handlers.size).toBe(0);
  });
});

describe("useNotificationSoundService", () => {
  test("sounds only for a newly raised completed-activity bell", () => {
    appCommandStore(environmentStore).setState({
      environments: [environment("existing-unread", true), environment("worker", false)],
    });
    renderHook(() => useNotificationSoundService());

    act(() => {
      appCommandStore(environmentStore).setState({
        environments: [environment("existing-unread", true), environment("worker", true)],
      });
    });

    expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);
    expect(playConfiguredNotificationSound).toHaveBeenCalledWith("agent-stopped");

    act(() => {
      appCommandStore(environmentStore).setState({
        environments: [environment("existing-unread", true), environment("worker", true)],
      });
    });
    expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);
  });

  test("a question edge from an older backend plays the question cue and notifies", async () => {
    appCommandStore(environmentStore).setState({
      environments: [environment("finished", false), environment("asking", false)],
    });
    renderHook(() => useNotificationSoundService());
    act(() => {
      appCommandStore(environmentStore).setState({
        environments: [
          environment("finished", true),
          { ...environment("asking", true), unreadReason: "agent_question" },
        ],
      });
    });
    expect(playConfiguredNotificationSound.mock.calls.map((call) => call[0])).toEqual([
      "agent-stopped",
      "agent-question",
    ]);
    await act(async () => {});
    expect(shownNotifications.map((shown) => shown.options.tag)).toEqual([
      "orkestrator-question:asking",
    ]);
  });

  test("baselines a newly hydrated unread environment without replaying it", () => {
    renderHook(() => useNotificationSoundService());
    act(() => {
      appCommandStore(environmentStore).setState({
        environments: [environment("late-snapshot", true)],
      });
    });
    expect(playConfiguredNotificationSound).not.toHaveBeenCalled();
  });

  test("does not replay a cue when the selected environment unread clear is reconciled", () => {
    appCommandStore(uiStore).setState({ selectedEnvironmentId: "worker" });
    appCommandStore(environmentStore).setState({ environments: [environment("worker", true)] });
    renderHook(() => useNotificationSoundService());

    act(() => {
      appCommandStore(environmentStore).setState({ environments: [environment("worker", false)] });
    });
    act(() => {
      appCommandStore(environmentStore).setState({ environments: [environment("worker", true)] });
    });

    expect(playConfiguredNotificationSound).not.toHaveBeenCalled();
  });

  test("coalesces simultaneous completion edges into one cue", () => {
    appCommandStore(environmentStore).setState({
      environments: [
        environment("one", false),
        environment("two", false),
        environment("three", false),
      ],
    });
    renderHook(() => useNotificationSoundService());

    act(() => {
      appCommandStore(environmentStore).setState({
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

  test("does not register priming work when every cue is disabled", () => {
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        notificationSounds: {
          agentStopped: false,
          prMerged: false,
          coordinatorReport: false,
          agentQuestion: false,
          questionDesktopNotification: true,
        },
      });
    renderHook(() => useNotificationSoundService());

    window.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("keydown"));

    expect(primeNotificationSounds).not.toHaveBeenCalled();
  });
});

test("Home completion sounds while the board obscures it, but not while Home is visible", () => {
  const home = { ...environment("home", false), projectHome: true };
  appCommandStore(environmentStore).setState({ environments: [home] });
  appCommandStore(uiStore).setState({ selectedEnvironmentId: home.id, projectBoardTab: "kanban" });
  renderHook(() => useNotificationSoundService());
  act(() =>
    appCommandStore(environmentStore)
      .getState()
      .updateEnvironment(home.id, { hasUnreadWork: true }),
  );
  expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);
  act(() => {
    appCommandStore(uiStore).getState().setProjectBoardTab("home");
    appCommandStore(environmentStore)
      .getState()
      .updateEnvironment(home.id, { hasUnreadWork: false });
  });
  act(() =>
    appCommandStore(environmentStore)
      .getState()
      .updateEnvironment(home.id, { hasUnreadWork: true }),
  );
  expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);
});

test.each([false, true])(
  "disabled paired cue does not suppress enabled cue (agent=%s)",
  async (agentStopped) => {
    resetClientStateCapabilitiesForTests({ environmentAttention: true } as never);
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    listenMock.mockImplementation(
      (event: string, handler: (event: { payload: unknown }) => void) => {
        handlers.set(event, handler);
        return Promise.resolve(() => handlers.delete(event));
      },
    );
    appCommandStore(uiStore).setState({ selectedProjectId: null });
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({
        notificationSounds: {
          agentStopped,
          coordinatorReport: !agentStopped,
          prMerged: false,
          agentQuestion: false,
          questionDesktopNotification: false,
        },
      });
    renderHook(() => useNotificationSoundService());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const events = [
      [
        ENVIRONMENT_ATTENTION_EVENT,
        {
          attentionId: "mixed-agent",
          environmentId: "worker",
          projectId: "project-1",
          reason: "agent_finished",
          occurredAt: new Date().toISOString(),
        },
      ],
      [
        COORDINATOR_WAKE_ATTENTION_EVENT,
        {
          attentionId: "mixed-wake",
          projectId: "project-1",
          coordinatorId: "c",
          occurredAt: new Date().toISOString(),
        },
      ],
    ] as const;
    for (const [event, payload] of agentStopped ? events.toReversed() : events)
      handlers.get(event)!({ payload });
    expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);
    expect(playConfiguredNotificationSound).toHaveBeenCalledWith(
      agentStopped ? "agent-stopped" : "coordinator-report",
    );
  },
);
