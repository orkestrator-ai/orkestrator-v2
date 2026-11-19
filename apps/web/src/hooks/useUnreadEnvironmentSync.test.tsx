import { appCommandScope } from "@/lib/node-scope-slots";
import {
  discardScopeResyncing,
  markScopeResyncing,
  noteAuthoritativeRead,
} from "@/lib/node-scope/snapshot-sync";
import { renderedUnreadResults } from "@/lib/unread-result-view";
import { act, cleanup } from "@testing-library/react";
import { renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as backend from "@/lib/backend";
import { environmentStore } from "@/stores/environmentStore";
import { uiStore } from "@/stores/uiStore";
import { paneLayoutStore, type EnvironmentPaneState } from "@/stores/paneLayoutStore";
import type { TabInfo } from "@/types/paneLayout";
import type { Environment } from "@/types";
import { mockToast, resetSonnerMocks } from "../../../../tests/mocks/sonner";
import { useUnreadEnvironmentSync } from "./useUnreadEnvironmentSync";
import { appCommandStore } from "@/test/app-command-store";

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "Review",
    type: "local",
    status: "running",
    order: 0,
    hasUnreadWork: true,
    lastActivityAt: "2026-09-15T08:00:00.000Z",
    ...overrides,
  } as Environment;
}

let persistResolvers: Array<(value: Environment) => void>;
let setUnread: ReturnType<typeof spyOn>;

beforeEach(() => {
  persistResolvers = [];
  appCommandStore(environmentStore).setState({ environments: [environment()] });
  appCommandStore(uiStore).setState({ selectedEnvironmentId: "env-1", projectBoardTab: "home" });
  setUnread = spyOn(backend, "setEnvironmentUnread").mockImplementation(
    () =>
      new Promise<Environment>((resolve) => {
        persistResolvers.push(resolve);
      }),
  );
});

afterEach(() => {
  cleanup();
  renderedUnreadResults(appCommandScope()).set(new Map());
  discardScopeResyncing(appCommandScope());
  resetSonnerMocks();
  setUnread.mockRestore();
  appCommandStore(environmentStore).setState({ environments: [] });
  appCommandStore(uiStore).setState({ selectedEnvironmentId: null });
  appCommandStore(paneLayoutStore).setState({ environments: new Map(), hydration: new Map() });
});

describe("useUnreadEnvironmentSync", () => {
  test("keeps a newer unread activity signal when the optimistic clear resolves late", async () => {
    const { unmount } = renderHookInAppCommandScope(() => useUnreadEnvironmentSync());
    expect(
      appCommandStore(environmentStore).getState().getEnvironmentById("env-1")?.hasUnreadWork,
    ).toBe(false);
    expect(setUnread).toHaveBeenCalledWith("env-1", false, "2026-09-15T08:00:00.000Z");

    unmount();
    act(() => {
      appCommandStore(environmentStore).getState().updateEnvironment("env-1", {
        hasUnreadWork: true,
        lastActivityAt: "2026-09-15T09:00:00.000Z",
      });
    });
    await act(async () => {
      persistResolvers[0]!(
        environment({ hasUnreadWork: false, lastActivityAt: "2026-09-15T08:00:00.000Z" }),
      );
      await Promise.resolve();
    });

    expect(appCommandStore(environmentStore).getState().getEnvironmentById("env-1")).toMatchObject({
      hasUnreadWork: true,
      lastActivityAt: "2026-09-15T09:00:00.000Z",
    });
  });

  test("restores the reason after a stale clear and silently clears again", async () => {
    appCommandStore(environmentStore).setState({
      environments: [environment({ unreadReason: "agent_finished" })],
    });
    renderHookInAppCommandScope(() => useUnreadEnvironmentSync());
    expect(mockToast).toHaveBeenCalledTimes(1);
    const newerActivityAt = "2026-09-15T09:00:00.000Z";
    // A resource snapshot advances the activity token while the clear is in flight.
    act(() => {
      appCommandStore(environmentStore).getState().updateEnvironment("env-1", {
        lastActivityAt: newerActivityAt,
      });
    });
    const restored: Environment[] = [];
    const unsubscribe = appCommandStore(environmentStore).subscribe((state) => {
      const current = state.getEnvironmentById("env-1");
      if (current?.hasUnreadWork) restored.push({ ...current });
    });
    try {
      await act(async () => {
        persistResolvers[0]!(
          environment({
            hasUnreadWork: true,
            unreadReason: "agent_question",
            lastActivityAt: newerActivityAt,
          }),
        );
        await Promise.resolve();
      });
    } finally {
      unsubscribe();
    }

    expect(restored).toEqual([
      expect.objectContaining({ hasUnreadWork: true, unreadReason: "agent_question" }),
    ]);
    expect(setUnread).toHaveBeenCalledTimes(2);
    expect(setUnread).toHaveBeenLastCalledWith("env-1", false, newerActivityAt);
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(appCommandStore(environmentStore).getState().getEnvironmentById("env-1")).toMatchObject({
      hasUnreadWork: false,
      unreadReason: undefined,
    });
    await act(async () => {
      persistResolvers[1]!(environment({ hasUnreadWork: false, lastActivityAt: newerActivityAt }));
      await Promise.resolve();
    });
    expect(
      appCommandStore(environmentStore).getState().getEnvironmentById("env-1")?.hasUnreadWork,
    ).toBe(false);
    expect(mockToast).toHaveBeenCalledTimes(1);
  });
});

describe("activation toast", () => {
  test("opening an environment with a bell shows why it rang", () => {
    appCommandStore(environmentStore).setState({
      environments: [
        environment({ hasUnreadWork: false }),
        environment({ id: "env-2", name: "Fixes", unreadReason: "agent_waiting" }),
      ],
    });
    renderHookInAppCommandScope(() => useUnreadEnvironmentSync());
    expect(mockToast).not.toHaveBeenCalled();

    act(() => appCommandStore(uiStore).setState({ selectedEnvironmentId: "env-2" }));

    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast.mock.calls[0]?.[0]).toBe("Agent needs your input");
    expect(mockToast.mock.calls[0]?.[1]).toMatchObject({ id: "environment-unread:env-2" });
    expect(appCommandStore(environmentStore).getState().getEnvironmentById("env-2")).toMatchObject({
      hasUnreadWork: false,
      unreadReason: undefined,
    });
  });

  test("work finishing in the environment already on screen clears without a toast", () => {
    appCommandStore(environmentStore).setState({
      environments: [environment({ hasUnreadWork: false })],
    });
    renderHookInAppCommandScope(() => useUnreadEnvironmentSync());

    act(() => {
      appCommandStore(environmentStore).getState().updateEnvironment("env-1", {
        hasUnreadWork: true,
        unreadReason: "agent_finished",
        lastActivityAt: "2026-09-15T09:00:00.000Z",
      });
    });

    expect(setUnread).toHaveBeenCalledTimes(1);
    expect(mockToast).not.toHaveBeenCalled();
  });

  test("a selection restored before environments load still toasts once they arrive", () => {
    appCommandStore(environmentStore).setState({ environments: [] });
    renderHookInAppCommandScope(() => useUnreadEnvironmentSync());

    act(() => {
      appCommandStore(environmentStore).setState({
        environments: [environment({ unreadReason: "terminal_finished" })],
      });
    });

    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast.mock.calls[0]?.[0]).toBe("Terminal agent finished");
  });
});

test("an obscured home toasts and clears unread work only when Home becomes visible", () => {
  appCommandStore(environmentStore).setState({
    environments: [
      environment({ name: "project-home", projectHome: true, unreadReason: "agent_ready" }),
    ],
  });
  appCommandStore(uiStore).setState({ projectBoardTab: "kanban" });
  renderHookInAppCommandScope(() => useUnreadEnvironmentSync());
  expect(setUnread).not.toHaveBeenCalled();
  expect(mockToast).not.toHaveBeenCalled();
  expect(appCommandStore(environmentStore).getState().environments[0]?.hasUnreadWork).toBe(true);
  act(() => appCommandStore(uiStore).getState().setProjectBoardTab("home"));
  expect(setUnread).toHaveBeenCalledTimes(1);
  expect(mockToast).toHaveBeenCalledTimes(1);
  expect(mockToast.mock.calls[0]?.[0]).toBe("Agent ready for input");
  expect(mockToast.mock.calls[0]?.[1]).toMatchObject({
    description: "Project home: You can send another message while background work continues.",
  });
});

describe("seen means in the foreground", () => {
  test("a selection in an unfocused window keeps the badge until the window is focused", () => {
    const hasFocus = spyOn(document, "hasFocus").mockReturnValue(false);
    try {
      renderHookInAppCommandScope(() => useUnreadEnvironmentSync());
      expect(setUnread).not.toHaveBeenCalled();
      expect(mockToast).not.toHaveBeenCalled();
      expect(
        appCommandStore(environmentStore).getState().getEnvironmentById("env-1")?.hasUnreadWork,
      ).toBe(true);

      hasFocus.mockReturnValue(true);
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(setUnread).toHaveBeenCalledTimes(1);
      expect(setUnread).toHaveBeenCalledWith("env-1", false, "2026-09-15T08:00:00.000Z");
      // The selection was never seen, so returning to it still explains the bell.
      expect(mockToast).toHaveBeenCalledTimes(1);
    } finally {
      hasFocus.mockRestore();
    }
  });

  test("an agent finishing while the window is in the background is not consumed", () => {
    appCommandStore(environmentStore).setState({
      environments: [environment({ hasUnreadWork: false })],
    });
    const hasFocus = spyOn(document, "hasFocus").mockReturnValue(true);
    try {
      renderHookInAppCommandScope(() => useUnreadEnvironmentSync());
      hasFocus.mockReturnValue(false);
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });
      act(() => {
        appCommandStore(environmentStore).getState().updateEnvironment("env-1", {
          hasUnreadWork: true,
          unreadReason: "agent_finished",
          lastActivityAt: "2026-09-15T09:00:00.000Z",
        });
      });
      expect(setUnread).not.toHaveBeenCalled();
      expect(
        appCommandStore(environmentStore).getState().getEnvironmentById("env-1")?.hasUnreadWork,
      ).toBe(true);

      hasFocus.mockReturnValue(true);
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(setUnread).toHaveBeenCalledWith("env-1", false, "2026-09-15T09:00:00.000Z");
    } finally {
      hasFocus.mockRestore();
    }
  });
});

describe("seen means the session's tab is on screen", () => {
  const sessionKey = (tabId: string) => `env-env-1:${tabId}`;

  function renderResult(tab: string, activityAt = "2026-09-15T08:00:00.000Z") {
    const renders = renderedUnreadResults(appCommandScope());
    renders.set(new Map(renders.get()).set(sessionKey(tab), { activityAt, sessionId: tab }));
  }

  function showTabs(activeTabId: string, hydration: "pending" | "done" = "done") {
    const tabs = [
      { id: "tab-a", type: "agent-native" },
      { id: "tab-b", type: "agent-native" },
    ] as TabInfo[];
    const layout: EnvironmentPaneState = {
      root: { kind: "leaf", id: "pane-1", tabs, activeTabId },
      activePaneId: "pane-1",
      containerId: null,
    };
    appCommandStore(paneLayoutStore).setState({
      environments: new Map([["env-1", layout]]),
      hydration: new Map([["env-1", hydration]]),
    });
  }

  test("opening another tab of the environment does not clear the session's result", () => {
    appCommandStore(environmentStore).setState({
      environments: [
        environment({ unreadReason: "agent_finished", unreadSessionKeys: [sessionKey("tab-a")] }),
      ],
    });
    showTabs("tab-b");
    renderHookInAppCommandScope(() => useUnreadEnvironmentSync());

    expect(setUnread).not.toHaveBeenCalled();
    // Activation still says why the bell rang.
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(
      appCommandStore(environmentStore).getState().getEnvironmentById("env-1")?.hasUnreadWork,
    ).toBe(true);

    act(() => appCommandStore(paneLayoutStore).getState().setActiveTab("pane-1", "tab-a", "env-1"));
    expect(setUnread).not.toHaveBeenCalled();
    act(() => renderResult("tab-a", "2026-09-15T07:00:00.000Z"));
    expect(setUnread).not.toHaveBeenCalled();
    act(() => renderResult("tab-a"));

    expect(setUnread).toHaveBeenCalledTimes(1);
    expect(setUnread).toHaveBeenCalledWith("env-1", false, "2026-09-15T08:00:00.000Z", [
      sessionKey("tab-a"),
    ]);
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(appCommandStore(environmentStore).getState().getEnvironmentById("env-1")).toMatchObject({
      hasUnreadWork: false,
      unreadSessionKeys: undefined,
    });
  });

  test("viewing one of two sessions leaves the other unread", async () => {
    appCommandStore(environmentStore).setState({
      environments: [
        environment({
          unreadReason: "agent_finished",
          unreadSessionKeys: [sessionKey("tab-a"), sessionKey("tab-b")],
        }),
      ],
    });
    showTabs("tab-a");
    renderResult("tab-a");
    renderHookInAppCommandScope(() => useUnreadEnvironmentSync());

    expect(setUnread).toHaveBeenCalledTimes(1);
    expect(setUnread).toHaveBeenCalledWith("env-1", false, "2026-09-15T08:00:00.000Z", [
      sessionKey("tab-a"),
    ]);
    expect(appCommandStore(environmentStore).getState().getEnvironmentById("env-1")).toMatchObject({
      hasUnreadWork: true,
      unreadSessionKeys: [sessionKey("tab-b")],
    });
    await act(async () => {
      persistResolvers[0]!(
        environment({ unreadReason: "agent_finished", unreadSessionKeys: [sessionKey("tab-b")] }),
      );
      await Promise.resolve();
    });
    expect(setUnread).toHaveBeenCalledTimes(1);
    expect(appCommandStore(environmentStore).getState().getEnvironmentById("env-1")).toMatchObject({
      hasUnreadWork: true,
      unreadSessionKeys: [sessionKey("tab-b")],
    });
  });

  test("waits for the restored layout before deciding", () => {
    appCommandStore(environmentStore).setState({
      environments: [environment({ unreadSessionKeys: [sessionKey("tab-a")] })],
    });
    showTabs("tab-a", "pending");
    renderResult("tab-a");
    renderHookInAppCommandScope(() => useUnreadEnvironmentSync());
    expect(setUnread).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();

    act(() => appCommandStore(paneLayoutStore).getState().finishHydration("env-1"));
    expect(setUnread).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledTimes(1);
  });

  test("cached startup rows cannot start a clear while resources resync", () => {
    const scope = appCommandScope();
    markScopeResyncing(scope, Date.now(), ["environment"]);
    showTabs("tab-b");
    renderHookInAppCommandScope(() => useUnreadEnvironmentSync());
    expect(setUnread).not.toHaveBeenCalled();

    act(() => {
      appCommandStore(environmentStore).setState({
        environments: [environment({ unreadSessionKeys: [sessionKey("tab-a")] })],
      });
      noteAuthoritativeRead(scope, "environment");
    });
    expect(setUnread).not.toHaveBeenCalled();
  });

  test("keeps stopped and failed-layout sessions unread", () => {
    appCommandStore(environmentStore).setState({
      environments: [
        environment({ status: "stopped", unreadSessionKeys: [sessionKey("missing")] }),
      ],
    });
    showTabs("tab-a");
    appCommandStore(paneLayoutStore).setState({ hydration: new Map() });
    renderHookInAppCommandScope(() => useUnreadEnvironmentSync());
    expect(setUnread).not.toHaveBeenCalled();
    act(() => appCommandStore(paneLayoutStore).getState().finishHydration("env-1"));
    expect(setUnread).not.toHaveBeenCalled();
  });

  test("the optimistic partial acknowledgement displays the remaining reason", () => {
    const activityAt = "2026-09-15T08:00:00.000Z";
    const finished = sessionKey("tab-a");
    const question = sessionKey("tab-b");
    appCommandStore(environmentStore).setState({
      environments: [
        environment({
          unreadReason: "agent_question",
          unreadSessionKeys: [finished, question],
          unreadSessionEntries: [
            { sessionKey: finished, activityAt, reason: "agent_finished" },
            { sessionKey: question, activityAt, reason: "agent_question" },
          ],
        }),
      ],
    });
    showTabs("tab-b");
    renderResult("tab-b");
    renderHookInAppCommandScope(() => useUnreadEnvironmentSync());
    expect(appCommandStore(environmentStore).getState().getEnvironmentById("env-1")).toMatchObject({
      hasUnreadWork: true,
      unreadSessionKeys: [finished],
      unreadReason: "agent_finished",
    });
  });

  test("reverse-order partial responses do not resurrect a cleared badge after switching away", async () => {
    const first = sessionKey("tab-a");
    const second = sessionKey("tab-b");
    appCommandStore(environmentStore).setState({
      environments: [environment({ unreadRevision: 3, unreadSessionKeys: [first, second] })],
    });
    showTabs("tab-a");
    renderResult("tab-a");
    renderHookInAppCommandScope(() => useUnreadEnvironmentSync());
    act(() => {
      appCommandStore(paneLayoutStore).getState().setActiveTab("pane-1", "tab-b", "env-1");
      renderResult("tab-b");
    });
    expect(
      setUnread.mock.calls.map((call: Parameters<typeof backend.setEnvironmentUnread>) => call[3]),
    ).toEqual([[first], [second]]);
    act(() => appCommandStore(uiStore).setState({ selectedEnvironmentId: null }));
    await act(async () => {
      persistResolvers[1]!(environment({ unreadRevision: 5, hasUnreadWork: false }));
    });
    await act(async () => {
      persistResolvers[0]!(environment({ unreadRevision: 4, unreadSessionKeys: [second] }));
    });
    expect(appCommandStore(environmentStore).getState().getEnvironmentById("env-1")).toMatchObject({
      hasUnreadWork: false,
      unreadRevision: 5,
    });
  });

  test("clears only environment-wide work while a mixed badge's session is hidden", () => {
    appCommandStore(environmentStore).setState({
      environments: [
        environment({
          unreadEnvironmentReason: "terminal_finished",
          unreadSessionKeys: [sessionKey("tab-a")],
        }),
      ],
    });
    showTabs("tab-b");
    renderHookInAppCommandScope(() => useUnreadEnvironmentSync());
    expect(setUnread).toHaveBeenCalledTimes(1);
    expect(setUnread).toHaveBeenCalledWith("env-1", false, "2026-09-15T08:00:00.000Z", []);
    expect(appCommandStore(environmentStore).getState().getEnvironmentById("env-1")).toMatchObject({
      hasUnreadWork: true,
      unreadSessionKeys: [sessionKey("tab-a")],
    });
  });
});

test("visibilitychange gates unread acknowledgement even while the document has focus", () => {
  const focus = spyOn(document, "hasFocus").mockReturnValue(true);
  const original = Object.getOwnPropertyDescriptor(document, "visibilityState");
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    renderHookInAppCommandScope(() => useUnreadEnvironmentSync());
    expect(setUnread).not.toHaveBeenCalled();
    act(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(setUnread).toHaveBeenCalledTimes(1);
  } finally {
    if (original) Object.defineProperty(document, "visibilityState", original);
    else Reflect.deleteProperty(document, "visibilityState");
    focus.mockRestore();
  }
});
