import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createDialogAttention } from "../electron/dialog-attention";

function harness(
  input: {
    platform?: NodeJS.Platform;
    agentTest?: boolean;
    focused?: boolean;
    minimized?: boolean;
    supported?: boolean;
    dock?: boolean;
  } = {},
) {
  const notifications: FakeNotification[] = [];
  class FakeNotification extends EventEmitter {
    static isSupported = mock(() => input.supported ?? true);
    show = mock(() => undefined);
    constructor(readonly options: Electron.NotificationConstructorOptions) {
      super();
      notifications.push(this);
    }
  }
  const bounce = mock((_type: "informational" | "critical") => 1);
  const window = {
    isFocused: mock(() => input.focused ?? false),
    isDestroyed: mock(() => false),
    isMinimized: mock(() => input.minimized ?? false),
    restore: mock(() => undefined),
    show: mock(() => undefined),
    focus: mock(() => undefined),
  };
  const requestAttention = createDialogAttention({
    platform: input.platform ?? "darwin",
    agentTest: input.agentTest ?? false,
    productName: "Orkestrator",
    dock: () => (input.dock === false ? undefined : { bounce }),
    Notification: FakeNotification,
  });
  return { requestAttention, window, notifications, bounce, FakeNotification };
}

describe("dialog attention", () => {
  test.each([{ focused: true }, { agentTest: true }])("skips attention for %j", (input) => {
    const run = harness(input);
    run.requestAttention(run.window, "Waiting for you");
    expect(run.bounce).not.toHaveBeenCalled();
    expect(run.FakeNotification.isSupported).not.toHaveBeenCalled();
    expect(run.notifications).toHaveLength(0);
  });

  test.each(["darwin", "linux", "win32"] as const)(
    "notifies on %s and bounces only on macOS without taking focus",
    (platform) => {
      const run = harness({ platform });
      run.requestAttention(run.window, "Waiting for you");
      expect(run.bounce.mock.calls).toEqual(platform === "darwin" ? [["informational"]] : []);
      expect(run.notifications).toHaveLength(1);
      expect(run.notifications[0]?.options).toEqual({
        title: "Orkestrator",
        body: "Waiting for you",
      });
      expect(run.notifications[0]?.show).toHaveBeenCalledTimes(1);
      expect(run.window.focus).not.toHaveBeenCalled();
      expect(run.window.show).not.toHaveBeenCalled();
    },
  );

  test("still bounces when notifications are unsupported", () => {
    const run = harness({ supported: false });
    run.requestAttention(run.window, "Waiting");
    expect(run.bounce).toHaveBeenCalledWith("informational");
    expect(run.notifications).toHaveLength(0);
  });

  test("can notify without a dock", () => {
    const run = harness({ dock: false });
    run.requestAttention(run.window, "Waiting");
    expect(run.bounce).not.toHaveBeenCalled();
    expect(run.notifications).toHaveLength(1);
  });

  test.each([true, false])("a click shows and focuses a minimized=%s parent", (minimized) => {
    const run = harness({ minimized });
    const actions: string[] = [];
    run.window.restore.mockImplementation(() => {
      actions.push("restore");
    });
    run.window.show.mockImplementation(() => {
      actions.push("show");
    });
    run.window.focus.mockImplementation(() => {
      actions.push("focus");
    });
    run.requestAttention(run.window, "Waiting");
    run.notifications[0]!.emit("click");
    expect(actions).toEqual(minimized ? ["restore", "show", "focus"] : ["show", "focus"]);
    run.notifications[0]!.emit("click");
    expect(run.window.focus).toHaveBeenCalledTimes(1);
  });

  test("a late click ignores a parent destroyed after the notification was shown", () => {
    const run = harness({ minimized: true });
    run.requestAttention(run.window, "Waiting");
    run.window.isDestroyed.mockReturnValue(true);
    run.notifications[0]!.emit("click");
    expect(run.window.isMinimized).not.toHaveBeenCalled();
    expect(run.window.restore).not.toHaveBeenCalled();
    expect(run.window.show).not.toHaveBeenCalled();
    expect(run.window.focus).not.toHaveBeenCalled();
  });

  test("closing a notification leaves its parent alone", () => {
    const run = harness();
    run.requestAttention(run.window, "Waiting");
    run.notifications[0]!.emit("close");
    expect(run.window.show).not.toHaveBeenCalled();
    expect(run.window.focus).not.toHaveBeenCalled();
  });
});
