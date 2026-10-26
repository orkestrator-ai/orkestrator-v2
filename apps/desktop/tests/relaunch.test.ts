import { describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appImageRelaunchEnvironment,
  relaunchApplication,
  type RelaunchContext,
} from "../electron/relaunch";
import { registerQuitReopenRelaunch } from "../electron/quit-policy";
import { showRestartPrompt } from "../electron/restart-prompt";

const MOUNT = "/tmp/.mount_orkestAPAiGd";
const STALE_MOUNT = "/tmp/.mount_orkestJdCeKP";

function context(overrides: Partial<RelaunchContext> = {}) {
  const spawned: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  const errorListeners: ((error: Error) => void)[] = [];
  const unref = mock(() => undefined);
  const value: RelaunchContext = {
    platform: "linux",
    env: {
      APPIMAGE: "/home/user/AppImages/orkestrator.appimage",
      APPDIR: MOUNT,
      ARGV0: "/home/user/AppImages/orkestrator.appimage",
      OWD: "/home/user/projects",
      HOME: "/home/user",
      LD_LIBRARY_PATH: `${MOUNT}/usr/lib:${STALE_MOUNT}/usr/lib:/opt/lib`,
      PATH: `${MOUNT}/usr/bin:/usr/bin`,
    },
    pid: 4242,
    argv: [`${MOUNT}/orkestrator-v2`, "orkestrator://open"],
    homeDirectory: "/home/user",
    spawn: (command, args, options) => {
      spawned.push({ command, args, options });
      return { unref, once: (_event, listener) => errorListeners.push(listener) };
    },
    ...overrides,
  };
  return { value, spawned, unref, errorListeners };
}

describe("relaunchApplication", () => {
  test("uses Electron's relaunch outside an AppImage", () => {
    const app = { relaunch: mock(() => undefined) };
    const linux = context({ env: { HOME: "/home/user" } });
    relaunchApplication(app, linux.value);
    const mac = context({ platform: "darwin" });
    relaunchApplication(app, mac.value);
    expect(app.relaunch).toHaveBeenCalledTimes(2);
    expect(linux.spawned).toEqual([]);
    expect(mac.spawned).toEqual([]);
  });

  test("restarts an AppImage from its image file once this process exits", () => {
    // app.relaunch() would restart the mounted executable, which the runtime
    // removes when this process exits: the new instance then dies at startup.
    const app = { relaunch: mock(() => undefined) };
    const { value, spawned, unref } = context();
    relaunchApplication(app, value);
    expect(app.relaunch).not.toHaveBeenCalled();
    expect(spawned).toHaveLength(1);
    const [{ command, args, options }] = spawned as [(typeof spawned)[number]];
    expect(command).toBe("/bin/sh");
    expect(args.slice(3)).toEqual([
      "4242",
      "/home/user/AppImages/orkestrator.appimage",
      "orkestrator://open",
    ]);
    expect(options).toMatchObject({ detached: true, stdio: "ignore", cwd: "/home/user/projects" });
    expect(unref).toHaveBeenCalled();
  });

  test("never starts from a working directory inside a mount", () => {
    const { value, spawned } = context();
    value.env.OWD = `${MOUNT}/resources`;
    relaunchApplication({ relaunch: () => undefined }, value);
    expect(spawned[0]!.options.cwd).toBe("/home/user");
  });

  test("falls back to Electron's relaunch when the waiter cannot start", () => {
    const app = { relaunch: mock(() => undefined) };
    const { value, errorListeners } = context();
    const logged = mock(() => undefined);
    const original = console.error;
    console.error = logged;
    try {
      relaunchApplication(app, value);
      errorListeners.forEach((listener) => listener(new Error("spawn /bin/sh ENOENT")));
    } finally {
      console.error = original;
    }
    expect(app.relaunch).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalled();
  });

  test("drops every AppImage mount path from the inherited environment", () => {
    const env = appImageRelaunchEnvironment(context().value.env);
    expect(env).toEqual({
      OWD: "/home/user/projects",
      HOME: "/home/user",
      LD_LIBRARY_PATH: "/opt/lib",
      PATH: "/usr/bin",
    });
  });

  test("the waiter starts the image only after the process it watches exits", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ork-relaunch-"));
    try {
      const marker = path.join(directory, "started");
      const image = path.join(directory, "fake.appimage");
      await writeFile(image, `#!/bin/sh\necho "$@" > "${marker}"\n`, { mode: 0o755 });
      const watched = Bun.spawn(["sleep", "30"]);
      let waiter: ReturnType<typeof Bun.spawn> | undefined;
      relaunchApplication(
        { relaunch: () => undefined },
        context({
          env: { APPIMAGE: image, PATH: process.env.PATH },
          pid: watched.pid,
          argv: ["/irrelevant", "--flag"],
          homeDirectory: directory,
          spawn: (command, args, options) => {
            waiter = Bun.spawn([command, ...args], {
              cwd: options.cwd,
              env: options.env,
              stdio: ["ignore", "ignore", "ignore"],
            });
            return { unref: () => undefined, once: () => undefined };
          },
        }).value,
      );
      await Bun.sleep(400);
      expect(await Bun.file(marker).exists()).toBe(false);
      watched.kill();
      await waiter!.exited;
      expect(await readFile(marker, "utf8")).toBe("--flag\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("the waiter script is valid POSIX sh", () => {
    const { value, spawned } = context();
    relaunchApplication({ relaunch: () => undefined }, value);
    expect(spawnSync("/bin/sh", ["-n", "-c", spawned[0]!.args[1]!]).status).toBe(0);
  });
});

describe("registerQuitReopenRelaunch", () => {
  test("schedules the injected relaunch instead of app.relaunch", () => {
    const app = { on: () => app, relaunch: mock(() => undefined) };
    const relaunch = mock(() => undefined);
    const guard = registerQuitReopenRelaunch({
      app: app as never,
      allowRelaunch: true,
      relaunch,
    });
    guard.scheduleRelaunch();
    guard.scheduleRelaunch();
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(app.relaunch).not.toHaveBeenCalled();
  });
});

describe("showRestartPrompt", () => {
  const prompt = (response: number | Error) => {
    const restart = mock(() => undefined);
    const showMessageBox = mock((options: Electron.MessageBoxOptions) => {
      void options;
      return response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve({ response, checkboxChecked: false });
    });
    return { restart, showMessageBox };
  };

  test("restarts only when Restart is chosen", async () => {
    const chosen = prompt(0);
    await showRestartPrompt({ title: "Backend stopped", detail: "exited", ...chosen });
    expect(chosen.restart).toHaveBeenCalledTimes(1);
    expect(chosen.showMessageBox.mock.calls[0]![0]).toMatchObject({
      type: "error",
      title: "Backend stopped",
      detail: "exited",
      buttons: ["Restart", "Close"],
      cancelId: 1,
    });

    const closed = prompt(1);
    await showRestartPrompt({ title: "Backend stopped", detail: "exited", ...closed });
    expect(closed.restart).not.toHaveBeenCalled();
  });

  test("a dialog failure is logged, never thrown", async () => {
    const failing = prompt(new Error("no display"));
    const original = console.error;
    const logged = mock(() => undefined);
    console.error = logged;
    try {
      await showRestartPrompt({ title: "Backend stopped", detail: "exited", ...failing });
    } finally {
      console.error = original;
    }
    expect(failing.restart).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();
  });
});
