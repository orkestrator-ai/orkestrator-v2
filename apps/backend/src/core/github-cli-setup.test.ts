import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { parseGitHubDeviceLoginOutput } from "./agent-accounts-login.js";
import type { CommandContext } from "./commands-context.js";
import { gitHubCli, setManagedGitHubCli } from "./github-cli-binary.js";
import {
  cancelGitHubCliLogin,
  getGitHubCliStatus,
  gitHubCliLoginCommand,
  gitHubCliLoginProgress,
  resetGitHubCliSetupForTests,
  startGitHubCliLogin,
} from "./github-cli-setup.js";

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

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "ork-github-cli-setup-"));
    previousPath = process.env.PATH;
    reminderDismissed = undefined;
    resetGitHubCliSetupForTests();
  });

  afterEach(() => {
    resetGitHubCliSetupForTests();
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
      storage: {
        agentAccountsDirectory: () => path.join(root, "accounts"),
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

  /** A PATH holding only the named fake tools and the system basics. */
  function pathWith(...names: string[]): void {
    const bin = path.join(root, "bin");
    rmSync(bin, { recursive: true, force: true });
    mkdirSync(bin, { recursive: true });
    for (const name of names) {
      writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 0\n");
      chmodSync(path.join(bin, name), 0o755);
    }
    process.env.PATH = [bin, "/usr/bin", "/bin"].join(path.delimiter);
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
    expect(gitHubCliLoginProgress()).toEqual({
      state: "succeeded",
      operationId: progress.operationId,
    });
    expect(cancelGitHubCliLogin()).toEqual({ state: "idle" });
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

    expect(cancelGitHubCliLogin("another-operation")).toMatchObject({ state: "pending" });
    expect(cancelGitHubCliLogin(progress.operationId)).toEqual({ state: "idle" });
    expect(fake.child().signalCode).toBe("SIGTERM");
  });

  test("refuses sign-in in an isolated agent-test profile", async () => {
    const fake = fakeSpawn();
    await expect(
      startGitHubCliLogin(contextFor("agent-test"), { spawnImpl: fake.spawnImpl }),
    ).rejects.toThrow("isolated test profile");
    expect(fake.calls).toHaveLength(0);
  });

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
