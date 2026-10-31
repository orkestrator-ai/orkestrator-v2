import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { parseGitHubDeviceLoginOutput } from "./agent-accounts-login.js";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands.js";
import { gitHubCli, setManagedGitHubCli } from "./github-cli-binary.js";
import {
  cancelGitHubCliLogin,
  getGitHubCliStatus,
  gitHubCliLoginCommand,
  gitHubCliLoginProgress,
  startGitHubCliLogin,
} from "./github-cli-setup.js";
import { GitHubCliLoginSlot } from "./github-cli-login.js";

// What gh 2.102 prints for `gh auth login --web` without a terminal.
const GH_LOGIN_OUTPUT = [
  "! One-time code (A1B2-C3D4) copied to clipboard",
  "Open this URL to continue in your web browser: https://github.com/login/device",
  "",
].join("\n");

type FakeChild = ChildProcess & {
  stdoutStream: PassThrough;
  stderrStream: PassThrough;
  finish: (code: number | null, signal?: NodeJS.Signals | null) => void;
};

function fakeSpawn() {
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  let current: FakeChild | undefined;
  const spawnImpl = (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, env: options.env });
    const emitter = new EventEmitter() as FakeChild;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(emitter, {
      stdout,
      stderr,
      stdin: new PassThrough(),
      exitCode: null,
      signalCode: null,
      stdoutStream: stdout,
      stderrStream: stderr,
      kill: (signal: NodeJS.Signals = "SIGTERM") => {
        emitter.finish(null, signal);
        return true;
      },
      finish: (code: number | null, signal: NodeJS.Signals | null = null) => {
        Object.assign(emitter, { exitCode: code, signalCode: signal });
        emitter.emit("exit", code, signal);
      },
    });
    current = emitter;
    return emitter;
  };
  return { spawnImpl, calls, child: () => current! };
}

async function waitForSpawn(calls: unknown[]): Promise<void> {
  for (let attempt = 0; calls.length === 0 && attempt < 200; attempt += 1) await Bun.sleep(5);
  if (calls.length === 0) throw new Error("gh was not started");
}

describe("GitHub CLI setup", () => {
  let root: string;
  let previousPath: string | undefined;
  let reminderDismissed: boolean | undefined;
  let gitHubCliLogin: GitHubCliLoginSlot;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "ork-github-cli-setup-"));
    previousPath = process.env.PATH;
    reminderDismissed = undefined;
    gitHubCliLogin = new GitHubCliLoginSlot();
  });

  afterEach(() => {
    setManagedGitHubCli(undefined);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  });

  function contextFor(runtimeFlavor: CommandContext["runtimeFlavor"] = "development") {
    const toolchainBinDir = path.join(root, "toolchain");
    const appRoot = path.join(root, "app");
    mkdirSync(toolchainBinDir, { recursive: true });
    mkdirSync(appRoot, { recursive: true });
    return {
      runtimeFlavor,
      toolchainBinDir,
      appRoot,
      resourceRoot: appRoot,
      runtime: { localServers: { gitHubCliLogin } },
      storage: {
        agentAccounts: {
          agentAccountsDirectory: () => path.join(root, "accounts"),
        },
        loadConfig: async () => ({ global: { githubCliReminderDismissed: reminderDismissed } }),
      },
    } as unknown as CommandContext;
  }

  /** A fake `gh` whose `auth token` prints a token only when `signedIn`. */
  function writeGh(directory: string, signedIn: boolean): string {
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "gh");
    writeFileSync(
      file,
      signedIn ? "#!/bin/sh\necho gho_test_token\n" : "#!/bin/sh\necho not logged in >&2\nexit 1\n",
    );
    chmodSync(file, 0o755);
    return file;
  }

  /**
   * A PATH holding only the named fake tools and the `which` used to find them.
   * System directories stay off it: CI images ship `gh` in /usr/bin, and the
   * host's own tools must not decide what these tests see.
   */
  function pathWith(...names: string[]): void {
    const bin = path.join(root, "bin");
    rmSync(bin, { recursive: true, force: true });
    mkdirSync(bin, { recursive: true });
    for (const name of names) {
      writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 0\n");
      chmodSync(path.join(bin, name), 0o755);
    }
    const lookup = path.join(root, "lookup");
    rmSync(lookup, { recursive: true, force: true });
    mkdirSync(lookup, { recursive: true });
    const which = Bun.which("which", { PATH: previousPath ?? "/usr/bin:/bin" });
    if (!which) throw new Error("`which` is required to resolve tools on PATH");
    symlinkSync(which, path.join(lookup, "which"));
    process.env.PATH = [bin, lookup].join(path.delimiter);
  }

  test("parses gh's device code and URL", () => {
    expect(parseGitHubDeviceLoginOutput(GH_LOGIN_OUTPUT)).toEqual({
      url: "https://github.com/login/device",
      userCode: "A1B2-C3D4",
    });
    expect(parseGitHubDeviceLoginOutput("https://example.com/login/device A1B2-C3D4")).toEqual({
      userCode: "A1B2-C3D4",
    });
  });

  test("builds a login that cannot reuse an inherited token or open a browser", () => {
    const command = gitHubCliLoginCommand("/shim", {
      PATH: "/usr/bin",
      GH_TOKEN: "inherited",
      GITHUB_TOKEN: "inherited",
    });
    expect(command.command).toBe("gh");
    expect(command.args).toEqual(["auth", "login", "--web", "--hostname", "github.com"]);

    // With a toolchain copy, sign-in drives the same gh every GitHub call uses.
    setManagedGitHubCli("/toolchain/gh");
    expect(gitHubCliLoginCommand("/shim", {}).command).toBe("/toolchain/gh");
    expect(command.env.GH_TOKEN).toBeUndefined();
    expect(command.env.GITHUB_TOKEN).toBeUndefined();
    expect(command.env.GH_BROWSER).toBe("/shim/open");
    expect(command.env.PATH).toBe(["/shim", "/usr/bin"].join(path.delimiter));
  });

  test("signs in through the device flow and reports completion", async () => {
    const fake = fakeSpawn();
    const started = startGitHubCliLogin(contextFor(), {
      spawnImpl: fake.spawnImpl,
      shimDirectory: path.join(root, "shim"),
    });
    await waitForSpawn(fake.calls);
    fake.child().stderrStream.write(GH_LOGIN_OUTPUT);
    const progress = await started;

    expect(progress).toMatchObject({
      state: "pending",
      url: "https://github.com/login/device",
      userCode: "A1B2-C3D4",
    });
    // A second start while pending returns the same sign-in.
    expect(
      (await startGitHubCliLogin(contextFor(), { spawnImpl: fake.spawnImpl })).operationId,
    ).toBe(progress.operationId);
    expect(fake.calls).toHaveLength(1);

    fake.child().finish(0);
    await Bun.sleep(0);
    expect(gitHubCliLoginProgress(contextFor())).toEqual({
      state: "succeeded",
      operationId: progress.operationId,
    });
    expect(cancelGitHubCliLogin(contextFor())).toEqual({ state: "idle" });
  });

  test("cancelling a pending sign-in stops gh", async () => {
    const fake = fakeSpawn();
    const started = startGitHubCliLogin(contextFor(), {
      spawnImpl: fake.spawnImpl,
      shimDirectory: path.join(root, "shim"),
    });
    await waitForSpawn(fake.calls);
    fake.child().stdoutStream.write(GH_LOGIN_OUTPUT);
    const progress = await started;

    expect(cancelGitHubCliLogin(contextFor(), "another-operation")).toMatchObject({
      state: "pending",
    });
    expect(cancelGitHubCliLogin(contextFor(), progress.operationId)).toEqual({ state: "idle" });
    expect(fake.child().signalCode).toBe("SIGTERM");
  });

  test("refuses sign-in in an isolated agent-test profile", async () => {
    const fake = fakeSpawn();
    await expect(
      startGitHubCliLogin(contextFor("agent-test"), { spawnImpl: fake.spawnImpl }),
    ).rejects.toThrow("isolated test profile");
    expect(fake.calls).toHaveLength(0);
  });

  test("cancels before the login handle resolves and allows a new operation", async () => {
    const fake = fakeSpawn();
    const started = startGitHubCliLogin(contextFor(), {
      spawnImpl: fake.spawnImpl,
      shimDirectory: path.join(root, "shim"),
    });
    // Attach a rejection handler before cancelling a process still starting.
    const outcome = started.catch((error: unknown) => error);
    await waitForSpawn(fake.calls);
    expect(cancelGitHubCliLogin(contextFor())).toEqual({ state: "idle" });

    const replacement = fakeSpawn();
    const restarted = startGitHubCliLogin(contextFor(), {
      spawnImpl: replacement.spawnImpl,
      shimDirectory: path.join(root, "shim"),
    });
    await waitForSpawn(replacement.calls);
    replacement.child().stderrStream.write(GH_LOGIN_OUTPUT);
    const progress = await restarted;

    fake.child().stderrStream.write(GH_LOGIN_OUTPUT);
    expect(await outcome).toMatchObject({ message: "The sign-in was cancelled" });
    expect(fake.child().signalCode).toBe("SIGTERM");
    expect(gitHubCliLoginProgress(contextFor())).toEqual(progress);
    cancelGitHubCliLogin(contextFor());
  });

  test("reports startup rejection and permits another sign-in", async () => {
    const fake = fakeSpawn();
    const started = startGitHubCliLogin(contextFor(), {
      spawnImpl: fake.spawnImpl,
      shimDirectory: path.join(root, "shim"),
    });
    const outcome = started.catch((error: unknown) => error);
    await waitForSpawn(fake.calls);
    fake.child().emit("error", new Error("gh unavailable"));
    expect(await outcome).toMatchObject({ message: "gh unavailable" });
    expect(gitHubCliLoginProgress(contextFor())).toMatchObject({
      state: "failed",
      error: "gh unavailable",
    });

    const restarted = startGitHubCliLogin(contextFor(), {
      spawnImpl: fake.spawnImpl,
      shimDirectory: path.join(root, "shim"),
    });
    for (let attempt = 0; fake.calls.length < 2 && attempt < 200; attempt += 1) await Bun.sleep(5);
    expect(fake.calls).toHaveLength(2);
    fake.child().stdoutStream.write(GH_LOGIN_OUTPUT);
    expect((await restarted).state).toBe("pending");
    cancelGitHubCliLogin(contextFor());
  });

  test("reports nonzero completion after a device prompt", async () => {
    const fake = fakeSpawn();
    const started = startGitHubCliLogin(contextFor(), {
      spawnImpl: fake.spawnImpl,
      shimDirectory: path.join(root, "shim"),
    });
    await waitForSpawn(fake.calls);
    fake.child().stdoutStream.write(GH_LOGIN_OUTPUT);
    const progress = await started;
    fake.child().finish(1);
    await Bun.sleep(0);
    expect(gitHubCliLoginProgress(contextFor())).toEqual({
      state: "failed",
      operationId: progress.operationId,
      error: "The sign-in did not complete (exit code 1)",
    });
  });

  describe("GitHub CLI registry commands", () => {
    const registry = createCommandRegistry();
    function invoke(name: string, args: Record<string, unknown> = {}, context = contextFor()) {
      const handler = registry.get(name);
      if (!handler) throw new Error(`${name} is not registered`);
      return Promise.resolve().then(() => handler(args, context));
    }

    test.each([
      "get_github_cli_status",
      "start_github_cli_login",
      "get_github_cli_login",
      "cancel_github_cli_login",
    ])("%s rejects unknown arguments before acting", async (name) => {
      await expect(invoke(name, { unexpected: true })).rejects.toThrow("unexpected");
      expect(gitHubCliLoginProgress(contextFor())).toEqual({ state: "idle" });
    });

    test.each([null, 123, false, {}])(
      "rejects invalid cancellation operationId %j",
      async (operationId) => {
        await expect(invoke("cancel_github_cli_login", { operationId })).rejects.toThrow(
          "operationId",
        );
      },
    );

    test("forwards the runtime context when starting sign-in", async () => {
      await expect(invoke("start_github_cli_login", {}, contextFor("agent-test"))).rejects.toThrow(
        "isolated test profile",
      );
      expect(gitHubCliLoginProgress(contextFor())).toEqual({ state: "idle" });
    });

    test.skipIf(process.platform === "win32")(
      "starts and cancels a device login through the registry",
      async () => {
        pathWith();
        const context = contextFor();
        const binary = writeGh(context.toolchainBinDir!, false);
        writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '${GH_LOGIN_OUTPUT}'\nread answer\n`);
        setManagedGitHubCli(binary);
        try {
          const progress = await invoke("start_github_cli_login", {}, context);
          expect(progress).toMatchObject({
            state: "pending",
            userCode: "A1B2-C3D4",
            url: "https://github.com/login/device",
          });
          expect(await invoke("get_github_cli_login")).toEqual(progress);
          expect(await invoke("cancel_github_cli_login")).toEqual({ state: "idle" });
        } finally {
          cancelGitHubCliLogin(contextFor());
        }
      },
    );

    test("polls the active operation and forwards the cancellation operationId", async () => {
      const fake = fakeSpawn();
      const started = startGitHubCliLogin(contextFor(), {
        spawnImpl: fake.spawnImpl,
        shimDirectory: path.join(root, "shim"),
      });
      await waitForSpawn(fake.calls);
      fake.child().stdoutStream.write(GH_LOGIN_OUTPUT);
      const progress = await started;
      expect(await invoke("get_github_cli_login")).toEqual(progress);
      expect(await invoke("cancel_github_cli_login", { operationId: "other" })).toEqual(progress);
      expect(fake.child().signalCode).toBeNull();
      expect(
        await invoke("cancel_github_cli_login", { operationId: progress.operationId }),
      ).toEqual({ state: "idle" });
      expect(fake.child().signalCode).toBe("SIGTERM");
      expect(await invoke("get_github_cli_login")).toEqual({ state: "idle" });
    });

    test("cancels without an operationId when no operation is pending", async () => {
      expect(await invoke("cancel_github_cli_login")).toEqual({ state: "idle" });
    });

    test.skipIf(process.platform === "win32")(
      "forwards status and reminder configuration",
      async () => {
        pathWith();
        const context = contextFor();
        setManagedGitHubCli(writeGh(context.toolchainBinDir!, true));
        reminderDismissed = true;
        expect(await invoke("get_github_cli_status", {}, context)).toEqual({
          installed: true,
          authenticated: true,
          canSignIn: true,
          reminderDismissed: true,
        });
      },
    );
  });

  test.skipIf(process.platform === "win32")(
    "uses gh from PATH when the managed copy is unavailable",
    async () => {
      pathWith();
      writeGh(path.join(root, "bin"), true);
      expect(gitHubCli()).toBe("gh");
      expect(await getGitHubCliStatus(contextFor())).toEqual({
        installed: true,
        authenticated: true,
        canSignIn: true,
        reminderDismissed: false,
      });
    },
  );

  test.skipIf(process.platform === "win32")(
    "reports the toolchain's gh as installed without one on PATH",
    async () => {
      pathWith();
      const context = contextFor();
      setManagedGitHubCli(writeGh(context.toolchainBinDir!, true));
      expect(await getGitHubCliStatus(context)).toEqual({
        installed: true,
        authenticated: true,
        canSignIn: true,
        reminderDismissed: false,
      });
    },
  );

  test.skipIf(process.platform === "win32")("reports a signed-out gh", async () => {
    pathWith();
    const context = contextFor();
    setManagedGitHubCli(writeGh(context.toolchainBinDir!, false));
    expect(await getGitHubCliStatus(context)).toEqual({
      installed: true,
      authenticated: false,
      canSignIn: true,
      reminderDismissed: false,
    });
    reminderDismissed = true;
    expect((await getGitHubCliStatus(context)).reminderDismissed).toBe(true);
    // An isolated profile may not sign in, so it is never offered there.
    expect((await getGitHubCliStatus(contextFor("agent-test"))).canSignIn).toBe(false);
  });

  test.skipIf(process.platform === "win32")("reports a missing gh", async () => {
    pathWith();
    expect(gitHubCli()).toBe("gh");
    expect(await getGitHubCliStatus(contextFor())).toEqual({
      installed: false,
      authenticated: false,
      canSignIn: false,
      reminderDismissed: false,
    });
  });
});
