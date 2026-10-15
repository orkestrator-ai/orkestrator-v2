import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { parseGitHubDeviceLoginOutput } from "./agent-accounts-login.js";
import type { CommandContext } from "./commands-context.js";
import {
  cancelGitHubCliLogin,
  getGitHubCliStatus,
  gitHubCliInstallProgress,
  gitHubCliLoginCommand,
  gitHubCliLoginProgress,
  resetGitHubCliSetupForTests,
  startGitHubCliInstall,
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

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "ork-github-cli-setup-"));
    previousPath = process.env.PATH;
    resetGitHubCliSetupForTests();
  });

  afterEach(() => {
    resetGitHubCliSetupForTests();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  });

  function contextFor(runtimeFlavor: CommandContext["runtimeFlavor"] = "development") {
    return {
      runtimeFlavor,
      storage: { agentAccountsDirectory: () => path.join(root, "accounts") },
    } as unknown as CommandContext;
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

  test("refuses host setup in an isolated agent-test profile", async () => {
    const fake = fakeSpawn();
    await expect(
      startGitHubCliLogin(contextFor("agent-test"), { spawnImpl: fake.spawnImpl }),
    ).rejects.toThrow("isolated test profile");
    await expect(
      startGitHubCliInstall(contextFor("agent-test"), {
        spawnImpl: fake.spawnImpl,
        platform: "darwin",
      }),
    ).rejects.toThrow("isolated test profile");
    expect(fake.calls).toHaveLength(0);
  });

  test.skipIf(process.platform === "win32")(
    "offers Homebrew only on macOS when gh is missing and brew is present",
    async () => {
      pathWith("brew");
      expect(await getGitHubCliStatus(contextFor(), { platform: "darwin" })).toEqual({
        installed: false,
        authenticated: false,
        canInstallWithHomebrew: true,
      });
      expect(
        (await getGitHubCliStatus(contextFor(), { platform: "linux" })).canInstallWithHomebrew,
      ).toBe(false);
      expect(
        (await getGitHubCliStatus(contextFor("agent-test"), { platform: "darwin" }))
          .canInstallWithHomebrew,
      ).toBe(false);

      pathWith();
      expect(
        (await getGitHubCliStatus(contextFor(), { platform: "darwin" })).canInstallWithHomebrew,
      ).toBe(false);
      await expect(startGitHubCliInstall(contextFor(), { platform: "darwin" })).rejects.toThrow(
        "only be installed automatically on macOS with Homebrew",
      );
    },
  );

  test.skipIf(process.platform === "win32")(
    "installs with Homebrew and reports success",
    async () => {
      pathWith("brew");
      const fake = fakeSpawn();
      const progress = await startGitHubCliInstall(contextFor(), {
        spawnImpl: fake.spawnImpl,
        platform: "darwin",
      });

      expect(progress.state).toBe("pending");
      expect(fake.calls[0]?.command).toBe("brew");
      expect(fake.calls[0]?.args).toEqual(["install", "gh"]);
      expect(fake.calls[0]?.env.NONINTERACTIVE).toBe("1");

      fake.child().finish(0);
      expect(gitHubCliInstallProgress()).toEqual({
        state: "succeeded",
        operationId: progress.operationId,
      });
    },
  );

  test.skipIf(process.platform === "win32")(
    "reports the end of Homebrew's output when the install fails",
    async () => {
      pathWith("brew");
      const fake = fakeSpawn();
      await startGitHubCliInstall(contextFor(), { spawnImpl: fake.spawnImpl, platform: "darwin" });
      fake.child().stderrStream.write("==> Fetching gh\nError: No such file or directory\n");
      await Bun.sleep(0);
      fake.child().finish(1);

      const progress = gitHubCliInstallProgress();
      expect(progress.state).toBe("failed");
      expect(progress.error).toContain("exit code 1");
      expect(progress.error).toContain("Error: No such file or directory");
    },
  );

  test.skipIf(process.platform === "win32")(
    "does not reinstall when gh is already present",
    async () => {
      pathWith("brew", "gh");
      const fake = fakeSpawn();
      const progress = await startGitHubCliInstall(contextFor(), {
        spawnImpl: fake.spawnImpl,
        platform: "darwin",
      });
      expect(progress.state).toBe("succeeded");
      expect(fake.calls).toHaveLength(0);
    },
  );
});
