import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { environmentStore } from "@/stores/environmentStore";
import { projectStore } from "@/stores/projectStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useUIStore } from "@/stores/uiStore";
import type { Environment, Project } from "@/types";
import {
  __testing,
  desktopNotificationPermission,
  requestDesktopNotificationPermission,
  showQuestionDesktopNotification,
} from "./question-desktop-notification";
import { appCommandStore } from "@/test/app-command-store";

interface Shown {
  title: string;
  options: NotificationOptions;
  listeners: Map<string, () => void>;
  closed: boolean;
}

const shown: Shown[] = [];
let throwOnConstruct = false;
let requested = 0;

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static async requestPermission(): Promise<NotificationPermission> {
    requested += 1;
    FakeNotification.permission = "granted";
    return "granted";
  }
  private readonly record: Shown;
  constructor(title: string, options: NotificationOptions = {}) {
    if (throwOnConstruct) throw new TypeError("Illegal constructor");
    this.record = { title, options, listeners: new Map(), closed: false };
    shown.push(this.record);
  }
  addEventListener(event: string, listener: () => void) {
    this.record.listeners.set(event, listener);
  }
  close() {
    this.record.closed = true;
  }
}

const descriptor = Object.getOwnPropertyDescriptor(window, "Notification");
const question = {
  environmentId: "env-1",
  projectId: "project-1",
  reason: "agent_question" as const,
  silent: true,
};

beforeEach(() => {
  shown.length = 0;
  throwOnConstruct = false;
  requested = 0;
  FakeNotification.permission = "granted";
  __testing.reset();
  Object.defineProperty(window, "Notification", { configurable: true, value: FakeNotification });
  appCommandStore(environmentStore).setState({
    environments: [{ id: "env-1", projectId: "project-1", name: "fix-login" } as Environment],
  });
  appCommandStore(projectStore).setState({
    projects: [{ id: "project-1", name: "webapp" } as Project],
  });
  useUIStore.setState({ selectedEnvironmentId: null, selectedProjectId: null });
});

afterEach(() => {
  if (descriptor) Object.defineProperty(window, "Notification", descriptor);
  else delete (window as unknown as { Notification?: unknown }).Notification;
  appCommandStore(environmentStore).setState({ environments: [] });
  appCommandStore(projectStore).setState({ projects: [] });
});

describe("question desktop notifications", () => {
  test("names the project and environment, nothing the agent wrote", () => {
    expect(showQuestionDesktopNotification(question)).toBe(true);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      title: "Agent asked a question",
      options: {
        body: "webapp · fix-login: waiting for your answer.",
        tag: "orkestrator-question:env-1",
        silent: true,
      },
    });
  });

  test("falls back to generic copy for an environment this client does not know", () => {
    showQuestionDesktopNotification({
      ...question,
      environmentId: "unknown",
      projectId: "elsewhere",
      reason: "agent_waiting",
    });
    expect(shown[0]?.title).toBe("Agent needs your input");
    expect(shown[0]?.options.body).toBe("An agent is waiting for your answer.");
  });

  test("shows nothing without permission or support, and survives a refusing constructor", () => {
    FakeNotification.permission = "denied";
    expect(showQuestionDesktopNotification(question)).toBe(false);
    FakeNotification.permission = "granted";
    throwOnConstruct = true;
    expect(showQuestionDesktopNotification(question)).toBe(false);
    delete (window as unknown as { Notification?: unknown }).Notification;
    expect(desktopNotificationPermission()).toBe("unsupported");
    expect(showQuestionDesktopNotification(question)).toBe(false);
    expect(shown).toHaveLength(0);
  });

  test("clicking opens the environment in the local workspace and releases it", () => {
    useRemoteWorkspaceStore.setState({
      active: { nodeId: "leaf", projectId: "remote", environmentId: "remote-env" },
    });
    showQuestionDesktopNotification(question);
    expect(__testing.openNotifications()).toBe(1);
    shown[0]!.listeners.get("click")!();
    expect(useRemoteWorkspaceStore.getState().active).toBeNull();
    expect(useUIStore.getState().selectedProjectId).toBe("project-1");
    expect(useUIStore.getState().selectedEnvironmentId).toBe("env-1");
    expect(shown[0]!.closed).toBe(true);
    expect(__testing.openNotifications()).toBe(0);
  });

  test("opens Project home from a coordinator tab", () => {
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          projectHome: true,
          name: "project-home",
        } as Environment,
      ],
    });
    useUIStore.setState({ projectBoardTab: "coordinator" });
    showQuestionDesktopNotification(question);
    shown[0]!.listeners.get("click")!();
    expect(useUIStore.getState().projectBoardTab).toBe("home");
    expect(useUIStore.getState().selectedEnvironmentId).toBe("env-1");
  });

  test("keeps a bounded number of notifications reachable", () => {
    for (let index = 0; index < 40; index += 1) showQuestionDesktopNotification(question);
    expect(__testing.openNotifications()).toBe(32);
    expect(shown.filter((notification) => notification.closed)).toHaveLength(8);
    shown[39]!.listeners.get("close")!();
    expect(__testing.openNotifications()).toBe(31);
  });

  test("asks the browser only while undecided", async () => {
    FakeNotification.permission = "default";
    expect(await requestDesktopNotificationPermission()).toBe("granted");
    expect(await requestDesktopNotificationPermission()).toBe("granted");
    expect(requested).toBe(1);
  });
});
