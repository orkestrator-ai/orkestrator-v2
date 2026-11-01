import { configureLogger, resetLogger } from "@orkestrator/protocol/logger";
import { afterAll } from "bun:test";
import { describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  createNativeDialogs,
  installUncaughtExceptionDialog,
  type NativeDialogApi,
} from "../electron/native-dialogs";

type FakeWindow = {
  name: string;
  visible: boolean;
  minimized: boolean;
  destroyed: boolean;
  closed: boolean;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  close(): void;
};

function fakeWindow(name: string, state: Partial<FakeWindow> = {}): FakeWindow {
  return {
    name,
    visible: true,
    minimized: false,
    destroyed: false,
    closed: false,
    isDestroyed() {
      return this.destroyed;
    },
    isVisible() {
      return this.visible;
    },
    isMinimized() {
      return this.minimized;
    },
    close() {
      this.closed = true;
    },
    ...state,
  };
}

const OPTIONS: Electron.MessageBoxOptions = {
  message: "secret /Users/someone/path",
  detail: "secret detail",
  buttons: ["OK", "Cancel"],
  cancelId: 1,
};

function harness(
  input: {
    platform?: NodeJS.Platform;
    current?: FakeWindow | null;
    createHostWindow?: () => Promise<FakeWindow>;
  } = {},
) {
  let clock = 1_000;
  const logs: string[] = [];
  const errors: string[] = [];
  const pending: Array<(value: Electron.MessageBoxReturnValue) => void> = [];
  const calls: Array<{ parent: string | null; options: Electron.MessageBoxOptions }> = [];
  const nativeBox = (...args: unknown[]) => {
    const parent = args.length === 2 ? (args[0] as FakeWindow).name : null;
    calls.push({ parent, options: args.at(-1) as Electron.MessageBoxOptions });
    return new Promise<Electron.MessageBoxReturnValue>((resolve) => pending.push(resolve));
  };
  const errorBox = mock(() => undefined);
  const dialog = {
    showMessageBox: nativeBox,
    showErrorBox: errorBox,
  } as NativeDialogApi<FakeWindow>;
  const host = fakeWindow("host");
  const createHostWindow = mock(input.createHostWindow ?? (async () => host));
  const requestAttention = mock((_window: FakeWindow, _message: string) => undefined);
  configureLogger({
    sink: ({ method, line }) => (method === "info" ? logs : errors).push(line),
  });
  const dialogs = createNativeDialogs<FakeWindow>({
    dialog,
    platform: input.platform ?? "darwin",
    currentWindow: () => input.current ?? null,
    createHostWindow,
    requestAttention,
    now: () => clock,
  });
  const answer = async (response = 0, index = 0) => {
    pending.splice(index, 1)[0]!({ response, checkboxChecked: false });
    await Bun.sleep(0);
  };
  return {
    setCurrent: (window: FakeWindow | null) => {
      input.current = window;
    },
    dialog,
    dialogs,
    logs,
    errors,
    calls,
    answer,
    host,
    errorBox,
    createHostWindow,
    requestAttention,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("native dialogs", () => {
  test("logs the source and parent before opening and the time after, never the text", async () => {
    const run = harness();
    const window = fakeWindow("main");
    const shown = run.dialogs.showMessageBox("updater", OPTIONS, window);
    expect(run.logs).toEqual(["[desktop.dialog] opening source=updater parent=visible"]);
    run.advance(1_500);
    await run.answer(1);
    expect(await shown).toEqual({ response: 1, checkboxChecked: false });
    expect(run.logs[1]).toBe("[desktop.dialog] closed source=updater durationMs=1500");
    expect(run.logs.join("\n")).not.toContain("secret");
  });

  test.each([
    ["minimized", { minimized: true }],
    ["not visible", { visible: false }],
  ])("attaches to a %s window and logs it as hidden", async (_name, state) => {
    const run = harness();
    void run.dialogs.showMessageBox("updater", OPTIONS, fakeWindow("main", state));
    await Bun.sleep(0);
    expect(run.calls[0]?.parent).toBe("main");
    expect(run.logs[0]).toBe("[desktop.dialog] opening source=updater parent=hidden");
  });

  test("on macOS uses the current window when the caller has none", async () => {
    const run = harness({ current: fakeWindow("current") });
    void run.dialogs.showMessageBox("backend-error", OPTIONS);
    await Bun.sleep(0);
    expect(run.calls[0]?.parent).toBe("current");
    expect(run.createHostWindow).not.toHaveBeenCalled();
  });

  test("on macOS replaces a destroyed window", async () => {
    const run = harness({ current: fakeWindow("current") });
    void run.dialogs.showMessageBox("updater", OPTIONS, fakeWindow("old", { destroyed: true }));
    await Bun.sleep(0);
    expect(run.calls[0]?.parent).toBe("current");
  });

  test("on macOS never opens a windowless box: a host window parents it, then closes", async () => {
    const run = harness();
    const shown = run.dialogs.showMessageBox("startup-failure", OPTIONS);
    await Bun.sleep(0);
    expect(run.calls[0]?.parent).toBe("host");
    expect(run.logs[0]).toBe("[desktop.dialog] opening source=startup-failure parent=host");
    expect(run.host.closed).toBe(false);
    await run.answer();
    await shown;
    await Bun.sleep(0);
    expect(run.host.closed).toBe(true);
  });

  test("concurrent windowless dialogs share one host until the last is answered", async () => {
    const run = harness();
    const first = run.dialogs.showMessageBox("a", OPTIONS);
    const second = run.dialogs.showMessageBox("b", OPTIONS);
    await Bun.sleep(0);
    expect(run.createHostWindow).toHaveBeenCalledTimes(1);
    await run.answer();
    await first;
    await Bun.sleep(0);
    expect(run.host.closed).toBe(false);
    await run.answer();
    await second;
    await Bun.sleep(0);
    expect(run.host.closed).toBe(true);
  });

  for (const route of ["current", "explicit"] as const) {
    test.each([0, 1])(
      `a reused ${route} host stays open when dialog %i finishes first`,
      async (firstToFinish) => {
        const run = harness();
        const first = run.dialogs.showMessageBox("a", OPTIONS);
        await Bun.sleep(0);
        run.setCurrent(run.host);
        const second = run.dialogs.showMessageBox(
          "b",
          OPTIONS,
          route === "explicit" ? run.host : undefined,
        );
        await Bun.sleep(0);
        expect(run.calls.map((call) => call.parent)).toEqual(["host", "host"]);
        expect(run.createHostWindow).toHaveBeenCalledTimes(1);
        expect(run.logs[1]).toBe("[desktop.dialog] opening source=b parent=host");
        const shown = [first, second];
        await run.answer(0, firstToFinish);
        await shown[firstToFinish];
        expect(run.host.closed).toBe(false);
        await run.answer();
        await shown[1 - firstToFinish];
        expect(run.host.closed).toBe(true);
      },
    );
  }

  test("replaces a retiring host still returned by the current-window lookup", async () => {
    const oldHost = fakeWindow("old-host");
    const newHost = fakeWindow("new-host");
    const hosts = [oldHost, newHost];
    const run = harness({ createHostWindow: async () => hosts.shift()! });
    const first = run.dialogs.showMessageBox("a", OPTIONS);
    await Bun.sleep(0);
    await run.answer();
    await first;
    expect(oldHost.closed).toBe(true);
    // Electron can still list a closing window until it is destroyed.
    run.setCurrent(oldHost);
    const second = run.dialogs.showMessageBox("b", OPTIONS);
    await Bun.sleep(0);
    expect(run.calls.map((call) => call.parent)).toEqual(["old-host", "new-host"]);
    expect(run.createHostWindow).toHaveBeenCalledTimes(2);
    expect(newHost.closed).toBe(false);
    await run.answer();
    await second;
    expect(newHost.closed).toBe(true);
  });

  test("on macOS refuses as cancelled rather than going windowless when no host opens", async () => {
    const run = harness({
      createHostWindow: () => Promise.reject(new Error("no display")),
    });
    expect(await run.dialogs.showMessageBox("toolchain-setup", OPTIONS)).toEqual({
      response: 1,
      checkboxChecked: false,
    });
    expect(run.calls).toEqual([]);
    expect(run.errors).toHaveLength(1);
    expect(run.errors[0]).toStartWith("[desktop.dialog] open-failed source=toolchain-setup");
  });

  test("elsewhere a windowless box stays windowless", async () => {
    const run = harness({ platform: "linux", current: fakeWindow("current") });
    void run.dialogs.showMessageBox("backend-error", OPTIONS);
    await Bun.sleep(0);
    expect(run.calls[0]?.parent).toBeNull();
    expect(run.logs[0]).toBe("[desktop.dialog] opening source=backend-error parent=none");
    expect(run.createHostWindow).not.toHaveBeenCalled();
  });

  test("asks for attention with the dialog's parent, only when it has one", async () => {
    const run = harness();
    const window = fakeWindow("main");
    void run.dialogs.showMessageBox("updater", OPTIONS, window);
    await Bun.sleep(0);
    expect(run.requestAttention).toHaveBeenCalledWith(window, OPTIONS.message);

    const linux = harness({ platform: "linux" });
    void linux.dialogs.showMessageBox("updater", OPTIONS);
    await Bun.sleep(0);
    expect(linux.requestAttention).not.toHaveBeenCalled();
  });

  test("still opens the dialog when asking for attention fails", async () => {
    const run = harness();
    run.requestAttention.mockImplementationOnce(() => {
      throw new Error("no notifications yet");
    });
    void run.dialogs.showMessageBox("updater", OPTIONS, fakeWindow("main"));
    await Bun.sleep(0);
    expect(run.calls[0]?.parent).toBe("main");
    expect(run.errors).toHaveLength(1);
    expect(run.errors[0]).toStartWith("[desktop.dialog] attention-failed source=updater");
  });

  test("install routes Electron's own callers, with and without a window", async () => {
    const run = harness({ current: fakeWindow("current") });
    run.dialogs.install();
    const owner = fakeWindow("owner");
    void run.dialog.showMessageBox(owner, OPTIONS);
    void run.dialog.showMessageBox(OPTIONS);
    await Bun.sleep(0);
    expect(run.calls.map((call) => call.parent)).toEqual(["owner", "current"]);
    expect(run.logs).toEqual([
      "[desktop.dialog] opening source=unrouted parent=visible",
      "[desktop.dialog] opening source=unrouted parent=visible",
    ]);
  });

  test("a stub set after install still answers routed dialogs", async () => {
    const run = harness({ current: fakeWindow("current") });
    run.dialogs.install();
    const stub = mock(async (..._args: unknown[]) => ({ response: 7, checkboxChecked: false }));
    run.dialog.showMessageBox = stub as never;
    expect(await run.dialogs.showMessageBox("backend-error", OPTIONS)).toMatchObject({
      response: 7,
    });
    expect(stub.mock.calls[0]?.at(-1)).toBe(OPTIONS);
    expect(run.calls).toEqual([]);
  });

  test.each(["darwin", "linux", "win32"] as const)(
    "install routes error boxes through an asynchronous message box on %s",
    async (platform) => {
      const run = harness({ platform, current: fakeWindow("current") });
      run.dialogs.install();
      run.dialog.showErrorBox("Title", "secret content");
      await Bun.sleep(0);
      expect(run.errorBox).not.toHaveBeenCalled();
      expect(run.calls[0]).toMatchObject({
        parent: platform === "darwin" ? "current" : null,
        options: { type: "error", message: "Title", detail: "secret content" },
      });
      expect(run.logs).toEqual([
        `[desktop.dialog] opening source=error-box parent=${platform === "darwin" ? "visible" : "none"}`,
      ]);
      expect(run.createHostWindow).not.toHaveBeenCalled();
      await run.answer();
    },
  );

  describe("describeStall", () => {
    test("names a dialog still open", () => {
      const run = harness({ current: fakeWindow("current") });
      void run.dialogs.showMessageBox("remote-restart", OPTIONS);
      run.advance(5_000);
      expect(run.dialogs.describeStall(5_000)).toBe(
        "; dialog remote-restart (parent: visible) was open",
      );
    });

    test("names a dialog that closed during the stall, as the timer fires after it", async () => {
      const run = harness({ current: fakeWindow("current") });
      const shown = run.dialogs.showMessageBox("updater", OPTIONS);
      await Bun.sleep(0);
      run.advance(5_000);
      await run.answer();
      await shown;
      run.advance(100);
      expect(run.dialogs.describeStall(5_100)).toContain("dialog updater");
    });

    test("names nothing when no dialog overlapped the stall", async () => {
      const run = harness({ current: fakeWindow("current") });
      const shown = run.dialogs.showMessageBox("updater", OPTIONS);
      await Bun.sleep(0);
      await run.answer();
      await shown;
      run.advance(10_000);
      expect(run.dialogs.describeStall(5_000)).toBe("");
    });
  });
});

describe("uncaught exceptions", () => {
  test("logs each one and shows one box at a time", async () => {
    let listener!: (error: Error) => void;
    let close!: (value: Electron.MessageBoxReturnValue) => void;
    const showMessageBox = mock(
      (_source: string, _options: Electron.MessageBoxOptions) =>
        new Promise<Electron.MessageBoxReturnValue>((resolve) => {
          close = resolve;
        }),
    );
    const logError = mock((_event: string) => undefined);
    installUncaughtExceptionDialog(
      {
        on: (_event, added) => {
          listener = added;
        },
      },
      { showMessageBox },
      { error: logError },
    );
    listener(new Error("first"));
    listener(new Error("second"));
    expect(logError).toHaveBeenCalledTimes(2);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(showMessageBox.mock.calls[0]?.[0]).toBe("uncaught-exception");
    close({ response: 0, checkboxChecked: false });
    await Bun.sleep(0);
    listener(new Error("third"));
    expect(showMessageBox).toHaveBeenCalledTimes(2);
  });
});

test("only the helper opens dialogs from the main process", () => {
  const directory = path.join(import.meta.dir, "../electron");
  const offenders = readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .filter((file) => file !== "native-dialogs.ts")
    .filter((file) =>
      /\bdialog\.show[A-Z]/.test(
        // Prose about `dialog.showErrorBox` in a comment is not a call.
        readFileSync(path.join(directory, file), "utf8").replace(/^\s*\*.*$/gm, ""),
      ),
    );
  expect(offenders).toEqual([]);
});

afterAll(resetLogger);
