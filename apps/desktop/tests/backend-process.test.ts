import { afterEach, describe, expect, mock, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { MAX_GATEWAY_EVENT_FRAME_BYTES } from "@orkestrator/protocol/gateway-event-stream";
import { applyPiHostCredentialEnvironment } from "../../backend/src/core/host-agent-credentials";
import type { CommandContext } from "../../backend/src/core/commands-context";
import { defaultConfig } from "../../backend/src/core/storage";
import {
  configureSshAgentSocketEnvironment,
  discoverSessionSshAgentSockets,
  isUsableOwnedSocket,
  readConfiguredSshAgentSocket,
  resolveSshAgentSocket,
} from "../../backend/src/ssh-agent-socket";
import {
  BackendHttpClient,
  BackendProcess,
  agentTestDockerConfigDir,
  agentTestKeychainDir,
  createBackendProcessEnvironment,
  getBrowserGatewayStatus,
  hostDockerConfigDir,
  removeAgentTestHostKeychainLink,
  seedAgentTestDockerConfig,
} from "../electron/backend-process";
import { installControlledTimeout } from "../../../tests/helpers/controlled-timeout";

const directories: string[] = [];
const processes: BackendProcess[] = [];
const originalFetch = globalThis.fetch;

function stubFetch(
  implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = Object.assign(mock(implementation), { preconnect: originalFetch.preconnect });
}

async function waitForWebClientStatus(
  client: BackendHttpClient,
  predicate: (status: Awaited<ReturnType<BackendHttpClient["getWebClientStatus"]>>) => boolean,
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs;
  let status = await client.getWebClientStatus();
  while (!predicate(status) && Date.now() < deadline) {
    await Bun.sleep(25);
    status = await client.getWebClientStatus();
  }
  return status;
}

async function waitForPath(target: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      await access(target).then(
        () => true,
        () => false,
      )
    )
      return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${target}`);
}

/**
 * Waits until `lines` contains an entry that includes `substring`.
 */
async function waitForCapturedLine(
  lines: string[],
  substring: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lines.some((line) => line.includes(substring))) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for console line containing ${JSON.stringify(substring)}`);
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(
    processes.splice(0).map(async (backend) => {
      const child = (
        backend as unknown as {
          child: { once(event: "exit", listener: () => void): void } | null;
        }
      ).child;
      const exited = child
        ? new Promise<void>((resolve) => {
            child.once("exit", resolve);
            setTimeout(resolve, 2_000);
          })
        : Promise.resolve();
      backend.stop();
      await exited;
    }),
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// These tests spawn a real backend child process and wait for it to boot.
// Bun's 5s default is not enough when the suite runs files in parallel on a
// loaded machine, which showed up as an intermittent timeout here.
const SPAWN_TIMEOUT_MS = 30_000;
/** What the gateway sends first to a client that has no cursor yet. */
const FRESH_CONNECTED_FRAME = `id: desktop1:0\ndata: ${JSON.stringify({
  event: "gateway.connected",
  payload: { generation: "desktop1", revision: 0, status: "fresh", replayed: 0 },
})}\n\n`;

describe("Electron backend process supervisor", () => {
  test("accepts a live SSH-agent socket through a stable symlink and rejects an unreachable socket", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "orkestrator-ssh-agent-socket-"));
    directories.push(directory);
    const socketPath = path.join(directory, "agent.sock");
    const symlinkPath = path.join(directory, "stable-agent.sock");
    const server = createNetServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await symlink(socketPath, symlinkPath);

    try {
      await expect(isUsableOwnedSocket(symlinkPath)).resolves.toBe(true);
      await expect(
        isUsableOwnedSocket(socketPath, { canConnect: async () => false }),
      ).resolves.toBe(false);
      await expect(
        isUsableOwnedSocket(socketPath, {
          canConnect: async () => true,
          statPath: async () => ({ isSocket: () => true, uid: 502 }),
          uid: 501,
        }),
      ).resolves.toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("discovers Linux session sockets from systemd, runtime defaults, and gpg-agent", async () => {
    const calls: string[] = [];
    const commandOutput = mock(async (command: string, args: string[]) => {
      calls.push([command, ...args].join(" "));
      if (command === "systemctl") {
        return "SSH_AUTH_SOCK=/run/user/501/custom-agent.sock\nXDG_RUNTIME_DIR=/run/user/501\n";
      }
      if (command === "gpgconf") return "/run/user/501/gnupg/S.gpg-agent.ssh";
      return undefined;
    });

    await expect(
      discoverSessionSshAgentSockets("linux", { commandOutput, env: {}, uid: 501 }),
    ).resolves.toEqual([
      "/run/user/501/custom-agent.sock",
      "/run/user/501/gcr/ssh",
      "/run/user/501/keyring/ssh",
      "/run/user/501/ssh-agent.socket",
      "/run/user/501/gnupg/S.gpg-agent.ssh",
    ]);
    expect(calls).toEqual([
      "systemctl --user show-environment",
      "gpgconf --list-dirs agent-ssh-socket",
    ]);
  });

  test("discovers macOS launchd and gpg-agent sockets", async () => {
    const commandOutput = mock(async (command: string, args: string[]) => {
      if (command === "launchctl" && args[0] === "getenv") return "/private/tmp/launchd/Listeners";
      if (command === "launchctl") return undefined;
      return "/Users/tester/.gnupg/S.gpg-agent.ssh";
    });

    await expect(
      discoverSessionSshAgentSockets("darwin", { commandOutput, uid: 501 }),
    ).resolves.toEqual(["/private/tmp/launchd/Listeners", "/Users/tester/.gnupg/S.gpg-agent.ssh"]);
  });

  test("discovers the macOS system agent socket from its launchd job when getenv is empty", async () => {
    const calls: string[] = [];
    const commandOutput = mock(async (command: string, args: string[]) => {
      calls.push([command, ...args].join(" "));
      if (command !== "launchctl" || args[0] !== "print") return undefined;
      return [
        "gui/501/com.openssh.ssh-agent = {",
        "\tpath = /System/Library/LaunchAgents/com.openssh.ssh-agent.plist",
        "\tprogram = /usr/bin/ssh-agent",
        "\tsockets = {",
        '\t\t"Listeners" = {',
        "\t\t\ttype = stream",
        "\t\t\tpath = /var/run/com.apple.launchd.abc123/Listeners",
        "\t\t\tsecure key = SSH_AUTH_SOCK",
        "\t\t\towner uid = 501",
        "\t\t}",
        "\t}",
        "}",
      ].join("\n");
    });

    await expect(
      discoverSessionSshAgentSockets("darwin", { commandOutput, uid: 501 }),
    ).resolves.toEqual(["/var/run/com.apple.launchd.abc123/Listeners"]);
    expect(calls).toEqual([
      "launchctl getenv SSH_AUTH_SOCK",
      "launchctl print gui/501/com.openssh.ssh-agent",
      "gpgconf --list-dirs agent-ssh-socket",
    ]);
  });

  test("ignores a macOS launchd job that does not publish an SSH_AUTH_SOCK socket", async () => {
    const commandOutput = mock(async (command: string, args: string[]) => {
      if (command !== "launchctl" || args[0] !== "print") return undefined;
      return [
        "gui/501/com.openssh.ssh-agent = {",
        "\tpath = /System/Library/LaunchAgents/com.openssh.ssh-agent.plist",
        "\tprogram = /usr/bin/ssh-agent",
        "\tsockets = {",
        '\t\t"Other" = {',
        "\t\t\tpath = /var/run/com.apple.launchd.abc123/Other",
        "\t\t\tsecure key = OTHER_SOCK",
        "\t\t}",
        "\t}",
        "}",
      ].join("\n");
    });

    await expect(
      discoverSessionSshAgentSockets("darwin", { commandOutput, uid: 501 }),
    ).resolves.toEqual([]);
  });

  test("skips the macOS launchd job lookup when no uid is available", async () => {
    const calls: string[] = [];
    const commandOutput = mock(async (command: string, args: string[]) => {
      calls.push([command, ...args].join(" "));
      return undefined;
    });
    const originalGetuid = process.getuid;
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    try {
      await expect(discoverSessionSshAgentSockets("darwin", { commandOutput })).resolves.toEqual(
        [],
      );
    } finally {
      Object.defineProperty(process, "getuid", { configurable: true, value: originalGetuid });
    }
    expect(calls).toEqual([
      "launchctl getenv SSH_AUTH_SOCK",
      "gpgconf --list-dirs agent-ssh-socket",
    ]);
  });

  test("applies resolved sockets to standalone backend environments and clears agent-test access", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "orkestrator-ssh-agent-config-"));
    directories.push(directory);
    const socketPath = path.join(directory, "agent.sock");
    const server = createNetServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await writeFile(
      path.join(directory, "config.json"),
      JSON.stringify({ global: { sshAgentSocketPath: socketPath } }),
    );

    try {
      const productionEnv: NodeJS.ProcessEnv = {};
      await expect(
        configureSshAgentSocketEnvironment({
          dataDir: directory,
          runtimeFlavor: "production",
          env: productionEnv,
        }),
      ).resolves.toEqual({ path: socketPath, source: "configured" });
      expect(productionEnv.SSH_AUTH_SOCK).toBe(socketPath);

      const unavailableEnv: NodeJS.ProcessEnv = { SSH_AUTH_SOCK: socketPath };
      await expect(
        configureSshAgentSocketEnvironment(
          { dataDir: directory, runtimeFlavor: "production", env: unavailableEnv },
          {
            readConfiguredSocket: async () => undefined,
            resolveSocket: async () => null,
          },
        ),
      ).resolves.toBeNull();
      expect(unavailableEnv.SSH_AUTH_SOCK).toBeUndefined();

      const agentTestEnv: NodeJS.ProcessEnv = { SSH_AUTH_SOCK: socketPath };
      await expect(
        configureSshAgentSocketEnvironment({
          dataDir: directory,
          runtimeFlavor: "agent-test",
          env: agentTestEnv,
        }),
      ).resolves.toBeNull();
      expect(agentTestEnv.SSH_AUTH_SOCK).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("resolves SSH agent sockets by explicit override, inherited environment, then session", async () => {
    const checked: string[] = [];
    const discoverSessionSockets = mock(async () => [
      "/run/user/501/stale-session-agent.sock",
      "/run/user/501/session-agent.sock",
    ]);
    const isUsableSocket = mock(async (candidate: string) => {
      checked.push(candidate);
      return !candidate.includes("stale");
    });

    expect(
      await resolveSshAgentSocket(
        {
          configuredPath: "/run/user/501/configured-agent.sock",
          inheritedPath: "/run/user/501/inherited-agent.sock",
        },
        { isUsableSocket, discoverSessionSockets },
      ),
    ).toEqual({ path: "/run/user/501/configured-agent.sock", source: "configured" });
    expect(checked).toEqual(["/run/user/501/configured-agent.sock"]);
    expect(discoverSessionSockets).not.toHaveBeenCalled();

    checked.length = 0;
    expect(
      await resolveSshAgentSocket(
        { inheritedPath: "/run/user/501/stale-agent.sock", platform: "linux" },
        { isUsableSocket, discoverSessionSockets },
      ),
    ).toEqual({ path: "/run/user/501/session-agent.sock", source: "session" });
    expect(checked).toEqual([
      "/run/user/501/stale-agent.sock",
      "/run/user/501/stale-session-agent.sock",
      "/run/user/501/session-agent.sock",
    ]);
    expect(discoverSessionSockets).toHaveBeenCalledWith("linux");
  });

  test("does not silently ignore an unavailable configured SSH agent socket", async () => {
    const discoverSessionSockets = mock(async () => "/run/user/501/session-agent.sock");
    expect(
      await resolveSshAgentSocket(
        { configuredPath: "/run/user/501/missing-agent.sock" },
        {
          isUsableSocket: async () => false,
          discoverSessionSockets,
        },
      ),
    ).toBeNull();
    expect(discoverSessionSockets).not.toHaveBeenCalled();
  });

  test("rejects relative SSH agent paths before probing the filesystem", async () => {
    const isUsableSocket = mock(async () => true);
    const discoverSessionSockets = mock(async () => undefined);
    expect(
      await resolveSshAgentSocket(
        { inheritedPath: "relative/agent.sock" },
        { isUsableSocket, discoverSessionSockets },
      ),
    ).toBeNull();
    expect(isUsableSocket).not.toHaveBeenCalled();
  });

  test("reads the persisted SSH agent override without exposing other config values", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "orkestrator-ssh-agent-config-"));
    directories.push(directory);
    await writeFile(
      path.join(directory, "config.json"),
      JSON.stringify({
        global: {
          sshAgentSocketPath: " /run/user/501/configured-agent.sock ",
          githubToken: "must-not-be-returned",
        },
      }),
    );

    expect(await readConfiguredSshAgentSocket(directory)).toBe(
      "/run/user/501/configured-agent.sock",
    );
  });

  test("isolates the child from remote gateway and Tailscale Serve shell settings", () => {
    const parent = {
      PATH: "/bin",
      NODE_PATH: "/existing",
      ORKESTRATOR_GATEWAY_HOST: "100.64.0.1",
      ORKESTRATOR_GATEWAY_PORT: "9999",
      ORKESTRATOR_GATEWAY_TOKEN: "not-forwarded",
      ORKESTRATOR_GATEWAY_ALLOWED_ORIGINS: "https://untrusted.example",
      ORKESTRATOR_TAILSCALE_SERVE: "1",
      ORKESTRATOR_TAILSCALE_SERVE_PORT: "8443",
      ORKESTRATOR_TAILSCALE_BIN: "/tmp/tailscale",
      ORKESTRATOR_TOOLCHAIN_BIN: "/tmp/untrusted-tools",
      ORKESTRATOR_VERSION: "untrusted-shell-version",
    };

    const development = createBackendProcessEnvironment(parent);
    expect(development).toEqual({
      PATH: "/bin",
      NODE_PATH: "/existing",
      ORKESTRATOR_DESKTOP_SUPERVISED: "1",
      ORKESTRATOR_GATEWAY_DISABLED: "0",
    });
    expect(parent.ORKESTRATOR_GATEWAY_TOKEN).toBe("not-forwarded");
    expect(development.ORKESTRATOR_VERSION).toBeUndefined();

    const production = createBackendProcessEnvironment(parent, "2.4.9");
    expect(production.NODE_PATH).toBe("/existing");
    expect(production.ORKESTRATOR_VERSION).toBe("2.4.9");
  });

  test("treats a blank application version as absent rather than exporting an empty one", () => {
    // `"" !== undefined`, so the naive check exported ORKESTRATOR_VERSION="",
    // which the backend and both bridges read as a defined value and therefore
    // do not replace with their own fallback.
    const parent = { ORKESTRATOR_VERSION: "untrusted-shell-version" };
    for (const blank of ["", "   ", "\t"]) {
      expect(createBackendProcessEnvironment(parent, blank)).not.toHaveProperty(
        "ORKESTRATOR_VERSION",
      );
    }
    expect(createBackendProcessEnvironment(parent, " 2.5.0 ")).toMatchObject({
      ORKESTRATOR_VERSION: "2.5.0",
    });
  });

  test("preserves NODE_PATH while applying Electron's application version", () => {
    const development = createBackendProcessEnvironment({ NODE_PATH: "/existing" }, "2.4.9");

    expect(development).toEqual({
      NODE_PATH: "/existing",
      ORKESTRATOR_DESKTOP_SUPERVISED: "1",
      ORKESTRATOR_GATEWAY_DISABLED: "0",
      ORKESTRATOR_VERSION: "2.4.9",
    });
  });

  test("agent-test child environments suppress ambient credentials by default", () => {
    const isolated = createBackendProcessEnvironment(
      {
        HOME: "/Users/tester",
        ANTHROPIC_API_KEY: "anthropic-secret",
        OPENAI_API_KEY: "openai-secret",
        OPENCODE_API_KEY: "opencode-secret",
        GH_TOKEN: "github-secret",
        CURSOR_API_KEY: "cursor-secret",
        AWS_ACCESS_KEY_ID: "aws-secret",
        NPM_TOKEN: "npm-secret",
        DATABASE_URL: "postgres://secret",
        SSH_AUTH_SOCK: "/tmp/private-agent.sock",
        CUSTOM_SERVICE_LOGIN: "unexpected-credential-name",
        ORKESTRATOR_TEST_SCHEDULER_DIR: "/profiles/qa/test-scheduler",
        ORKESTRATOR_TEST_HOST_WORKERS: "2",
        ORKESTRATOR_TEST_HOST_MEMORY_MIB: "2048",
        ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK: "all",
        ORKESTRATOR_NATIVE_OBSERVATION_SHARING: "0",
        ORKESTRATOR_RECURRING_METRICS: "1",
        ORKESTRATOR_PREVIEW_TRANSPORT: "1",
        ORKESTRATOR_PREVIEW_RELAY: "0",
      },
      "2.8.2",
      {
        flavor: "agent-test",
        credentialSources: [],
        isolatedCredentialRoot: "/profiles/qa/credentials",
      },
    );

    expect(isolated.ANTHROPIC_API_KEY).toBeUndefined();
    expect(isolated.OPENAI_API_KEY).toBeUndefined();
    expect(isolated.OPENCODE_API_KEY).toBeUndefined();
    expect(isolated.GH_TOKEN).toBeUndefined();
    expect(isolated.CURSOR_API_KEY).toBeUndefined();
    expect(isolated.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(isolated.NPM_TOKEN).toBeUndefined();
    expect(isolated.DATABASE_URL).toBeUndefined();
    expect(isolated.SSH_AUTH_SOCK).toBeUndefined();
    expect(isolated.CUSTOM_SERVICE_LOGIN).toBeUndefined();
    expect(isolated.ORKESTRATOR_TEST_SCHEDULER_DIR).toBe("/profiles/qa/test-scheduler");
    expect(isolated.ORKESTRATOR_TEST_HOST_WORKERS).toBe("2");
    expect(isolated.ORKESTRATOR_TEST_HOST_MEMORY_MIB).toBe("2048");
    // Recurring-work policy switches reach the backend so a profile can
    // qualify the rollback drivers.
    expect(isolated.ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK).toBe("all");
    expect(isolated.ORKESTRATOR_NATIVE_OBSERVATION_SHARING).toBe("0");
    expect(isolated.ORKESTRATOR_RECURRING_METRICS).toBe("1");
    // So do the service-preview transport overrides, so a profile can
    // qualify the desktop tunnel and relay.
    expect(isolated.ORKESTRATOR_PREVIEW_TRANSPORT).toBe("1");
    expect(isolated.ORKESTRATOR_PREVIEW_RELAY).toBe("0");
    expect(isolated.HOME).toBe("/profiles/qa/credentials/home");
    expect(isolated.ORKESTRATOR_AGENT_TEST_HOST_HOME).toBe("/Users/tester");
    expect(isolated.CODEX_HOME).toBe("/profiles/qa/credentials/codex");
    expect(isolated.CLAUDE_CONFIG_DIR).toBe("/profiles/qa/credentials/claude");
    expect(isolated.GIT_CONFIG_GLOBAL).toBe(process.platform === "win32" ? "NUL" : "/dev/null");
  });

  test("agent-test environments restore only explicitly allowed provider credentials", () => {
    const isolated = createBackendProcessEnvironment(
      {
        HOME: "/Users/tester",
        OPENAI_API_KEY: "allowed-openai",
        CURSOR_API_KEY: "allowed-cursor",
        ANTHROPIC_API_KEY: "blocked-anthropic",
        NPM_TOKEN: "blocked-npm",
      },
      "2.8.2",
      {
        flavor: "agent-test",
        credentialSources: ["codex", "cursor"],
        isolatedCredentialRoot: "/profiles/qa/credentials",
      },
    );

    expect(isolated.OPENAI_API_KEY).toBe("allowed-openai");
    expect(isolated.CURSOR_API_KEY).toBe("allowed-cursor");
    expect(isolated.ANTHROPIC_API_KEY).toBeUndefined();
    expect(isolated.NPM_TOKEN).toBeUndefined();
    expect(isolated.CLAUDE_CONFIG_DIR).toBe("/profiles/qa/credentials/claude");
  });

  test("authorized Codex and OpenCode keep the profile's own provider homes", () => {
    const parent = {
      HOME: "/Users/tester",
      CODEX_HOME: "/Users/tester/custom-codex",
      XDG_CONFIG_HOME: "/Users/tester/.xdg/config",
      XDG_DATA_HOME: "/Users/tester/.xdg/data",
      XDG_STATE_HOME: "/Users/tester/.xdg/state",
      OPENAI_API_KEY: "allowed-openai",
      OPENCODE_API_KEY: "allowed-opencode",
    };
    const runtime = {
      flavor: "agent-test" as const,
      isolatedCredentialRoot: "/profiles/qa/credentials",
    };
    // The host login reaches these homes only as the restricted snapshot
    // `seedAgentTestProviderCredentials` writes, never as the host directory.
    for (const credentialSources of [[], ["codex", "opencode"]]) {
      const isolated = createBackendProcessEnvironment(parent, "2.8.2", {
        ...runtime,
        credentialSources,
      });
      expect(isolated.CODEX_HOME).toBe("/profiles/qa/credentials/codex");
      expect(isolated.XDG_CONFIG_HOME).toBe("/profiles/qa/credentials/xdg-config");
      expect(isolated.XDG_DATA_HOME).toBe("/profiles/qa/credentials/xdg-data");
      expect(isolated.XDG_STATE_HOME).toBe("/profiles/qa/credentials/xdg-state");
      const authorized = credentialSources.length > 0;
      expect(isolated.OPENAI_API_KEY).toBe(authorized ? "allowed-openai" : undefined);
      expect(isolated.OPENCODE_API_KEY).toBe(authorized ? "allowed-opencode" : undefined);
    }
  });

  test("keeps host Claude configuration provider-scoped", () => {
    const isolated = createBackendProcessEnvironment(
      {
        HOME: "/Users/tester",
      },
      "2.8.2",
      {
        flavor: "agent-test",
        credentialSources: ["claude"],
        isolatedCredentialRoot: "/profiles/qa/credentials",
      },
    );

    expect(isolated.CLAUDE_CONFIG_DIR).toBe("/profiles/qa/credentials/claude");
    expect(isolated.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR).toBe("/Users/tester/.claude");
    expect(isolated.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    // Defaulted, so the backend reads Claude's plain Keychain entry.
    expect(isolated.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_EXPLICIT).toBeUndefined();
  });

  test("records that the shell named its Claude directory, so its own login is used", () => {
    const runtime = {
      flavor: "agent-test" as const,
      credentialSources: ["claude"],
      isolatedCredentialRoot: "/profiles/qa/credentials",
    };
    const added = createBackendProcessEnvironment(
      {
        HOME: "/Users/tester",
        CLAUDE_CONFIG_DIR: "/data/agent-accounts/claude/11111111-2222-4333-8444-555555555555",
      },
      "2.8.2",
      runtime,
    );
    expect(added.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR).toBe(
      "/data/agent-accounts/claude/11111111-2222-4333-8444-555555555555",
    );
    expect(added.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_EXPLICIT).toBe("1");

    // An explicit ~/.claude has a hashed Keychain entry of its own too.
    const spelled = createBackendProcessEnvironment(
      { HOME: "/Users/tester", CLAUDE_CONFIG_DIR: "/Users/tester/.claude" },
      "2.8.2",
      runtime,
    );
    expect(spelled.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_EXPLICIT).toBe("1");

    // Never inherited from the parent, and never set without a Claude grant.
    const injected = createBackendProcessEnvironment(
      { HOME: "/Users/tester", ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_EXPLICIT: "1" },
      "2.8.2",
      { ...runtime, credentialSources: ["codex"] },
    );
    expect(injected.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_EXPLICIT).toBeUndefined();
  });

  test("a profile without a Claude source receives no host Claude path", () => {
    const isolated = createBackendProcessEnvironment(
      {
        HOME: "/Users/tester",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
        ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR: "/tmp/injected-host-config",
      },
      "2.8.2",
      {
        flavor: "agent-test",
        credentialSources: ["codex"],
        isolatedCredentialRoot: "/profiles/qa/credentials",
      },
    );

    expect(isolated.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    expect(isolated.CLAUDE_CONFIG_DIR).toBe("/profiles/qa/credentials/claude");
    expect(isolated.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  test("names only the host Pi agent directory, and only when Pi is authorized", () => {
    const parent = {
      HOME: "/Users/tester",
      PI_CODING_AGENT_DIR: "/Users/tester/dotfiles/pi",
      ORKESTRATOR_AGENT_TEST_HOST_PI_AGENT_DIR: "/tmp/injected-host-pi",
    };
    const runtime = { flavor: "agent-test" as const, isolatedCredentialRoot: "/profiles/qa/creds" };

    const authorized = createBackendProcessEnvironment(parent, "2.8.2", {
      ...runtime,
      credentialSources: ["pi"],
    });
    // The host's own override wins, as it does for `pi` itself; the variable
    // never reaches the profile, so Pi there keeps the isolated HOME's directory.
    expect(authorized.ORKESTRATOR_AGENT_TEST_HOST_PI_AGENT_DIR).toBe("/Users/tester/dotfiles/pi");
    expect(authorized.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(authorized.PI_AGENT_DIR).toBeUndefined();
    expect(authorized.HOME).toBe("/profiles/qa/creds/home");

    const defaulted = createBackendProcessEnvironment({ HOME: "/Users/tester" }, "2.8.2", {
      ...runtime,
      credentialSources: ["pi"],
    });
    expect(defaulted.ORKESTRATOR_AGENT_TEST_HOST_PI_AGENT_DIR).toBe("/Users/tester/.pi/agent");

    const denied = createBackendProcessEnvironment(parent, "2.8.2", {
      ...runtime,
      credentialSources: ["claude"],
    });
    expect(denied.ORKESTRATOR_AGENT_TEST_HOST_PI_AGENT_DIR).toBeUndefined();

    const production = createBackendProcessEnvironment(parent, "2.8.2");
    expect(production.ORKESTRATOR_AGENT_TEST_HOST_PI_AGENT_DIR).toBeUndefined();
  });

  test("normalizes host Pi overrides before HOME changes and hands off only auth", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-pi-handoff-"));
    directories.push(root);
    const hostHome = path.join(root, "host");
    const authPath = path.join(hostHome, ".pi-custom", "auth.json");
    await mkdir(path.dirname(authPath), { recursive: true });
    await writeFile(authPath, "{}");
    const isolated = createBackendProcessEnvironment(
      { HOME: hostHome, PI_CODING_AGENT_DIR: "~/.pi-custom" },
      undefined,
      {
        flavor: "agent-test",
        credentialSources: ["pi"],
        isolatedCredentialRoot: path.join(root, "credentials"),
      },
    );
    expect(isolated.HOME).not.toBe(hostHome);
    expect(isolated.ORKESTRATOR_AGENT_TEST_HOST_PI_AGENT_DIR).toBe(path.dirname(authPath));
    const name = "ORKESTRATOR_AGENT_TEST_HOST_PI_AGENT_DIR";
    const previous = process.env[name];
    process.env[name] = isolated[name];
    try {
      const env: NodeJS.ProcessEnv = { HOME: isolated.HOME };
      await applyPiHostCredentialEnvironment(
        {
          runtimeFlavor: "agent-test",
          credentialSources: new Set(["pi"]),
        } as unknown as CommandContext,
        env,
      );
      expect(env.PI_BRIDGE_AUTH_FILE).toBe(authPath);
      expect(env.PI_AGENT_DIR).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
    for (const override of ["~", "relative/pi", "/absolute/pi"]) {
      const env = createBackendProcessEnvironment(
        { HOME: hostHome, PI_CODING_AGENT_DIR: override },
        undefined,
        { flavor: "agent-test", credentialSources: ["pi"] },
      );
      expect(env[name]).toBe(override === "~" ? hostHome : path.resolve(override));
    }
  });

  test("agent-test environments keep the Docker daemon endpoint while isolating its credentials", () => {
    // Where the daemon is, is topology, not a credential. Stripping it sends
    // every backend `docker` call to the built-in default socket, which is not
    // where Colima, Rancher Desktop, or a remote daemon listen.
    const isolated = createBackendProcessEnvironment(
      {
        HOME: "/Users/tester",
        DOCKER_HOST: "unix:///Users/tester/.colima/default/docker.sock",
        DOCKER_CONTEXT: "colima",
        DOCKER_TLS_VERIFY: "1",
        DOCKER_CERT_PATH: "/Users/tester/.docker/certs",
        DOCKER_AUTH_CONFIG: '{"auths":{}}',
      },
      "2.8.2",
      {
        flavor: "agent-test",
        credentialSources: [],
        isolatedCredentialRoot: "/profiles/qa/credentials",
      },
    );

    expect(isolated.DOCKER_HOST).toBe("unix:///Users/tester/.colima/default/docker.sock");
    expect(isolated.DOCKER_CONTEXT).toBe("colima");
    expect(isolated.DOCKER_TLS_VERIFY).toBe("1");
    expect(isolated.DOCKER_CERT_PATH).toBe("/Users/tester/.docker/certs");
    // Registry credentials are not topology and stay behind.
    expect(isolated.DOCKER_AUTH_CONFIG).toBeUndefined();
    expect(isolated.DOCKER_CONFIG).toBe(agentTestDockerConfigDir("/profiles/qa/credentials"));
  });

  test("seeds the isolated Docker config with the host context and none of its credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-docker-config-"));
    directories.push(root);
    const source = path.join(root, "host-docker");
    await mkdir(path.join(source, "contexts", "meta", "abc123"), { recursive: true });
    await writeFile(
      path.join(source, "contexts", "meta", "abc123", "meta.json"),
      '{"Name":"desktop-linux"}',
    );
    await writeFile(
      path.join(source, "config.json"),
      JSON.stringify({
        currentContext: "desktop-linux",
        credsStore: "desktop",
        auths: { "registry.example.com": { auth: "c2VjcmV0OnRva2Vu" } },
      }),
    );

    const isolatedCredentialRoot = path.join(root, "credentials");
    await seedAgentTestDockerConfig({ isolatedCredentialRoot, sourceDir: source });

    const target = agentTestDockerConfigDir(isolatedCredentialRoot);
    // The context metadata is what makes `docker` reach the same daemon.
    await expect(
      readFile(path.join(target, "contexts", "meta", "abc123", "meta.json"), "utf8"),
    ).resolves.toBe('{"Name":"desktop-linux"}');
    const seeded = JSON.parse(await readFile(path.join(target, "config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(seeded).toEqual({ currentContext: "desktop-linux" });
    expect(Object.keys(seeded)).not.toContain("auths");
    expect(Object.keys(seeded)).not.toContain("credsStore");
  });

  test("removes a legacy host Keychain link when a persistent profile is reused", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-keychain-revoke-"));
    directories.push(root);
    const hostHome = path.join(root, "host-home");
    const hostKeychains = path.join(hostHome, "Library", "Keychains");
    await mkdir(hostKeychains, { recursive: true });
    await writeFile(path.join(hostKeychains, "login.keychain-db"), "host-login");
    const isolatedCredentialRoot = path.join(root, "credentials");
    const target = agentTestKeychainDir(isolatedCredentialRoot);
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(hostKeychains, target);

    await expect(removeAgentTestHostKeychainLink(isolatedCredentialRoot)).resolves.toBe(true);
    await expect(removeAgentTestHostKeychainLink(isolatedCredentialRoot)).resolves.toBe(false);

    expect(
      await access(target).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    await expect(readFile(path.join(hostKeychains, "login.keychain-db"), "utf8")).resolves.toBe(
      "host-login",
    );
  });

  test("legacy-link cleanup leaves real profile-owned Keychain state untouched", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-keychain-existing-"));
    directories.push(root);
    const isolatedCredentialRoot = path.join(root, "credentials");
    const target = agentTestKeychainDir(isolatedCredentialRoot);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "login.keychain-db"), "profile-owned");

    await expect(removeAgentTestHostKeychainLink(isolatedCredentialRoot)).resolves.toBe(false);

    await expect(readFile(path.join(target, "login.keychain-db"), "utf8")).resolves.toBe(
      "profile-owned",
    );
  });

  test("still produces a usable isolated Docker config when the host has none", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-docker-config-missing-"));
    directories.push(root);
    const isolatedCredentialRoot = path.join(root, "credentials");

    // A machine that has never run Docker must not fail profile startup.
    await seedAgentTestDockerConfig({
      isolatedCredentialRoot,
      sourceDir: path.join(root, "absent"),
    });

    const seeded = await readFile(
      path.join(agentTestDockerConfigDir(isolatedCredentialRoot), "config.json"),
      "utf8",
    );
    expect(JSON.parse(seeded)).toEqual({});
  });

  test("resolves the host Docker configuration directory from DOCKER_CONFIG or the home directory", () => {
    expect(hostDockerConfigDir({ DOCKER_CONFIG: "/custom/docker" }, "/Users/tester")).toBe(
      "/custom/docker",
    );
    expect(hostDockerConfigDir({ DOCKER_CONFIG: "   " }, "/Users/tester")).toBe(
      path.join("/Users/tester", ".docker"),
    );
    expect(hostDockerConfigDir({}, "/Users/tester")).toBe(path.join("/Users/tester", ".docker"));
  });

  test(
    "start threads the Electron application version into the spawned child",
    async () => {
      // start -> launch -> createBackendProcessEnvironment is the only path that
      // gives the backend and both bridges their version; deleting the argument
      // from the call site broke nothing that any test could see.
      const resourceRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-fake-backend-"));
      directories.push(resourceRoot);
      const marker = path.join(resourceRoot, "version-marker");
      const authFile = path.join(resourceRoot, "auth.json");
      await writeFile(authFile, JSON.stringify({ token: "fake-backend-token-1234567890" }));
      await mkdir(path.join(resourceRoot, "bin"), { recursive: true });
      // A stand-in for the packaged Bun runtime: records what it was handed and
      // then speaks just enough of the readiness protocol to complete startup.
      const fakeBun = path.join(resourceRoot, "bin", "bun");
      await writeFile(
        fakeBun,
        `#!/bin/sh
printf '%s' "\${ORKESTRATOR_VERSION-<unset>}" > ${JSON.stringify(marker)}
printf '{"type":"orkestrator-backend-ready","url":"http://127.0.0.1:1/","authFile":"%s","bindAddress":"127.0.0.1","port":1}\\n' ${JSON.stringify(authFile)}
sleep 5
`,
      );
      await chmod(fakeBun, 0o755);

      const errors = mock(() => undefined);
      const realError = console.error;
      console.error = errors as unknown as typeof console.error;
      try {
        const backendProcess = new BackendProcess();
        processes.push(backendProcess);
        await backendProcess.start({
          isDev: false,
          appVersion: "9.9.9-threaded",
          appRoot: resourceRoot,
          resourceRoot,
          dataDir: resourceRoot,
          gatewayPort: 0,
          onEvent: () => undefined,
        });

        expect(await readFile(marker, "utf8")).toBe("9.9.9-threaded");
      } finally {
        console.error = realError;
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "forwards backend stdio through console as complete lines",
    async () => {
      // Production logging tees `console`, so stderr/stdout have to reach it as
      // reassembled lines. A chunk-based forwarder would prefix each fragment.
      globalThis.fetch = Bun.fetch;
      const resourceRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-backend-stdio-"));
      directories.push(resourceRoot);
      const authFile = path.join(resourceRoot, "auth.json");
      await writeFile(authFile, JSON.stringify({ token: "fake-backend-token-1234567890" }));
      await mkdir(path.join(resourceRoot, "bin"), { recursive: true });
      const fakeBun = path.join(resourceRoot, "bin", "bun");
      await writeFile(
        fakeBun,
        `#!/bin/sh
printf '{"type":"orkestrator-backend-ready","url":"http://127.0.0.1:1/","authFile":"%s","bindAddress":"127.0.0.1","port":1}\\n' ${JSON.stringify(authFile)}
printf 'partial-'
printf 'stdout line\\n'
printf 'partial-' >&2
printf 'stderr line\\n' >&2
sleep 5
`,
      );
      await chmod(fakeBun, 0o755);

      const logs: string[] = [];
      const errors: string[] = [];
      const realLog = console.log;
      const realError = console.error;
      console.log = ((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      }) as typeof console.log;
      console.error = ((...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      }) as typeof console.error;
      try {
        const backendProcess = new BackendProcess();
        processes.push(backendProcess);
        await backendProcess.start({
          isDev: false,
          appVersion: "9.9.9-stdio",
          appRoot: resourceRoot,
          resourceRoot,
          dataDir: resourceRoot,
          gatewayPort: 0,
          onEvent: () => undefined,
        });

        await waitForCapturedLine(logs, "[Backend] partial-stdout line");
        await waitForCapturedLine(errors, "[Backend] partial-stderr line");
        expect(logs.some((line) => line === "[Backend] partial-")).toBe(false);
        expect(errors.some((line) => line === "[Backend] partial-")).toBe(false);
      } finally {
        console.log = realLog;
        console.error = realError;
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test("reports browser availability independently from the desktop control listener", () => {
    expect(getBrowserGatewayStatus(null)).toEqual({
      enabled: true,
      running: false,
      url: null,
      error: null,
    });
    expect(
      getBrowserGatewayStatus({
        bindAddress: "127.0.0.1",
        port: 1234,
        url: "http://127.0.0.1:1234/",
        authFile: "/tmp/auth.json",
        browserError: "address unavailable",
      }),
    ).toMatchObject({ running: false, url: null, error: "address unavailable" });
    expect(
      getBrowserGatewayStatus({
        bindAddress: "127.0.0.1",
        port: 1234,
        url: "http://127.0.0.1:1234/",
        authFile: "/tmp/auth.json",
        browserUrl: "http://100.80.1.2:34121/",
      }),
    ).toMatchObject({ running: true, url: "http://100.80.1.2:34121/", error: null });
  });

  test("HTTP client covers commands, settings, errors, and event delivery", async () => {
    const server = createServer(async (request, response) => {
      if (request.url === "/__orkestrator/events") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `: connected\n\n${FRESH_CONNECTED_FRAME}data: {"event":"changed","payload":{"ok":true}}\n\n`,
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length
        ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
        : {};
      response.setHeader("content-type", "application/json");
      if (request.url === "/__orkestrator/status") {
        response.end(JSON.stringify({ ok: true }));
      } else if (request.url === "/__orkestrator/invoke" && body.command === "fail") {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: "command failed" }));
      } else if (request.url === "/__orkestrator/invoke") {
        response.end(JSON.stringify({ result: body.args }));
      } else if (request.url === "/__orkestrator/gateway-settings") {
        const token =
          request.method === "PUT" ? (body.token as string) : "initial-client-token-123456";
        response.end(JSON.stringify({ token, editable: true, source: "file" }));
      } else if (request.url === "/__orkestrator/web-client-access") {
        const enabled =
          request.method === "DELETE" || (request.method === "PUT" && body.enabled === true);
        response.end(
          JSON.stringify({
            enabled,
            running: enabled,
            url: enabled ? "https://workstation.example.ts.net/" : null,
            error: null,
          }),
        );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = new BackendHttpClient(
      `http://127.0.0.1:${address.port}/`,
      "initial-client-token-123456",
    );

    await expect(client.invoke("echo", { value: 1 })).resolves.toEqual({ value: 1 });
    await expect(client.invoke("fail")).rejects.toThrow("command failed");
    await expect(client.probe(3_000)).resolves.toBe(true);
    await expect(client.getTokenSettings()).resolves.toMatchObject({
      token: "initial-client-token-123456",
    });
    await expect(client.setToken("changed-client-token-123456")).resolves.toMatchObject({
      token: "changed-client-token-123456",
    });
    await expect(client.getWebClientStatus()).resolves.toMatchObject({
      enabled: false,
      running: false,
    });
    await expect(client.setWebClientEnabled(true)).resolves.toMatchObject({
      enabled: true,
      running: true,
      url: "https://workstation.example.ts.net/",
    });
    await expect(client.resetWebClientServe()).resolves.toMatchObject({
      enabled: true,
      running: true,
    });
    const received: Array<{ event: string; payload: unknown }> = [];
    const delivered = new Promise<void>((resolve) =>
      client.listen((event, payload) => {
        received.push({ event, payload });
        if (event === "changed") resolve();
      }),
    );
    await delivered;
    expect(received).toEqual([
      { event: "terminal-event-stream-connected", payload: undefined },
      { event: "native-event-stream-connected", payload: undefined },
      { event: "changed", payload: { ok: true } },
    ]);
    client.stopListening();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING")
          reject(error);
        else resolve();
      }),
    );
  });

  test("HTTP client surfaces web access HTTP and malformed-response failures", async () => {
    const client = new BackendHttpClient("http://127.0.0.1:34121/", "test-token-123456");
    stubFetch(
      async () =>
        new Response(JSON.stringify({ error: "lifecycle unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(client.getWebClientStatus()).rejects.toThrow("lifecycle unavailable");

    stubFetch(async () => new Response("upstream exploded", { status: 503 }));
    await expect(client.invoke("fail")).rejects.toThrow("Backend request failed with HTTP 503");

    stubFetch(async () => new Response("not json", { status: 200 }));
    await expect(client.setWebClientEnabled(true)).rejects.toThrow();
  });

  test("HTTP client serializes terminal writes and coalesces input typed meanwhile", async () => {
    const client = new BackendHttpClient("http://127.0.0.1:34121/", "test-token-123456");
    const bodies: Array<{ command: string; args: Record<string, unknown> }> = [];
    const releases: Array<() => void> = [];
    stubFetch(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      await new Promise<void>((resolve) => releases.push(resolve));
      return Response.json({ result: { delivered: true } });
    });

    const writes = [client.invoke("terminal_write", { sessionId: "remote-1", data: "a" })];
    const otherTerminal = client.invoke("terminal_write", { sessionId: "remote-2", data: "z" });
    await Bun.sleep(0);
    writes.push(
      ...["b", "c"].map((data) => client.invoke("terminal_write", { sessionId: "remote-1", data })),
    );
    await Bun.sleep(0);
    // One in flight per terminal; other terminals and commands are not held up.
    expect(bodies.map((body) => body.args)).toEqual([
      { sessionId: "remote-1", data: "a" },
      { sessionId: "remote-2", data: "z" },
    ]);

    releases.shift()!();
    await Bun.sleep(0);
    expect(bodies[2]?.args).toEqual({ sessionId: "remote-1", data: "bc" });
    for (const release of releases.splice(0)) release();
    const allWrites = [...writes, otherTerminal];
    await expect(Promise.all(allWrites)).resolves.toEqual(
      Array.from({ length: 4 }, () => ({ delivered: true })),
    );
  });

  test("HTTP client fails terminal input queued behind a failed write", async () => {
    const client = new BackendHttpClient("http://127.0.0.1:34121/", "test-token-123456");
    const sent: string[] = [];
    let failFirst!: () => void;
    stubFetch(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.command !== "terminal_write") return Response.json({ result: undefined });
      const data = String(body.args.data);
      sent.push(data);
      if (sent.length === 1) {
        await new Promise<void>((resolve) => (failFirst = resolve));
        return new Response("gone", { status: 502 });
      }
      return Response.json({ result: { delivered: true } });
    });

    const first = client.invoke("terminal_write", { sessionId: "remote-1", data: "a" });
    await Bun.sleep(0);
    const queued = client.invoke("terminal_write", { sessionId: "remote-1", data: "b" });
    await Bun.sleep(0);
    failFirst();
    await expect(Promise.all([first.catch(String), queued.catch(String)])).resolves.toEqual([
      "Error: Backend request failed with HTTP 502",
      "Error: Backend request failed with HTTP 502",
    ]);
    await expect(
      client.invoke("terminal_write", { sessionId: "remote-1", data: "c" }),
    ).rejects.toThrow("HTTP 502");
    await client.invoke("start_terminal_session", { sessionId: "remote-1" });
    await expect(
      client.invoke("terminal_write", { sessionId: "remote-1", data: "c" }),
    ).resolves.toEqual({ delivered: true });
    expect(sent).toEqual(["a", "c"]);
  });

  test("delivers a legitimate event frame larger than 1 MiB", async () => {
    const payload = "y".repeat(1.5 * 1024 * 1024);
    const frame = `data: ${JSON.stringify({ event: "large-snapshot", payload })}\n\n`;
    expect(Buffer.byteLength(frame, "utf8")).toBeGreaterThan(1024 * 1024);
    expect(Buffer.byteLength(frame, "utf8")).toBeLessThan(MAX_GATEWAY_EVENT_FRAME_BYTES);
    stubFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(FRESH_CONNECTED_FRAME + frame));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    );
    const client = new BackendHttpClient("http://127.0.0.1:34121/", "test-token-123456");
    const events: Array<{ event: string; payload: unknown }> = [];
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("large frame was not delivered")), 2_000);
        client.listen((event, payload) => {
          events.push({ event, payload });
          if (event === "large-snapshot") {
            clearTimeout(timeout);
            client.stopListening();
            resolve();
          }
        });
      });
      expect(events).toEqual([
        { event: "terminal-event-stream-connected", payload: undefined },
        { event: "native-event-stream-connected", payload: undefined },
        { event: "large-snapshot", payload },
      ]);
    } finally {
      client.stopListening();
    }
  });

  test("drops malformed event frames and resumes from its cursor after an oversized frame", async () => {
    const urls: string[] = [];
    let firstCancelled = false;
    let reconnected!: () => void;
    const secondAttempt = new Promise<void>((resolve) => {
      reconnected = resolve;
    });
    stubFetch(async (input) => {
      urls.push(String(input));
      if (urls.length === 1) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `${FRESH_CONNECTED_FRAME}data: {not-json}\n\nid: desktop1:1\ndata: {"event":"kept","payload":1}\n\n`,
                ),
              );
              controller.enqueue(
                new TextEncoder().encode("x".repeat(MAX_GATEWAY_EVENT_FRAME_BYTES + 1)),
              );
            },
            cancel() {
              firstCancelled = true;
            },
          }),
          { status: 200 },
        );
      }
      reconnected();
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    });
    const error = mock(() => undefined);
    const warning = mock(() => undefined);
    const previousError = console.error;
    const previousWarning = console.warn;
    console.error = error;
    console.warn = warning;
    const client = new BackendHttpClient("http://127.0.0.1:34121/", "test-token-123456", {
      eventReconnectDelayMs: 5,
    });
    const events: string[] = [];
    try {
      client.listen((event) => events.push(event));
      await secondAttempt;
      client.stopListening();
      expect(events).toEqual([
        "terminal-event-stream-connected",
        "native-event-stream-connected",
        "kept",
      ]);
      expect(urls).toEqual([
        "http://127.0.0.1:34121/__orkestrator/events",
        "http://127.0.0.1:34121/__orkestrator/events?since=desktop1%3A1",
      ]);
      expect(firstCancelled).toBe(true);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      client.stopListening();
      console.error = previousError;
      console.warn = previousWarning;
    }
  });

  test("backs off instead of spinning when the gateway closes every stream at once", async () => {
    let attempts = 0;
    stubFetch(async () => {
      attempts += 1;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        { status: 200 },
      );
    });
    const client = new BackendHttpClient("http://127.0.0.1:34121/", "test-token-123456", {
      eventReconnectDelayMs: 20,
    });
    client.listen(() => undefined);
    await Bun.sleep(100);
    client.stopListening();
    // 20 ms, then at most 40, 80: a tight loop would have made hundreds.
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(attempts).toBeLessThanOrEqual(5);
  });

  test(
    "launches one service for both the Electron bridge and browser clients",
    async () => {
      const root = path.resolve(import.meta.dir, "../../..");
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
      directories.push(dataDir);
      const backendProcess = new BackendProcess();
      processes.push(backendProcess);
      const events: string[] = [];
      let freshConnection!: () => void;
      const connected = new Promise<void>((resolve) => {
        freshConnection = resolve;
      });

      const client = await backendProcess.start({
        isDev: true,
        appRoot: root,
        resourceRoot: root,
        dataDir,
        gatewayHost: "127.0.0.1",
        gatewayPort: 0,
        allowNonTailscaleBind: true,
        onEvent: (event) => {
          events.push(event);
          if (event === "native-event-stream-connected") freshConnection();
        },
      });

      const info = backendProcess.getInfo();
      expect(info?.bindAddress).toBe("127.0.0.1");
      expect(info?.browserUrl).toBeTruthy();
      expect(info?.url).not.toBe(info?.browserUrl);
      await expect(client.invoke("greet", { name: "Electron" })).resolves.toBe(
        "Hello, Electron! You've been greeted from the Orkestrator backend!",
      );
      // The real gateway's replay handshake reaches the desktop client as one
      // resync, and none of its control frames leak to the renderer.
      await connected;
      expect(events.filter((event) => event === "native-event-stream-connected")).toHaveLength(1);
      expect(events.some((event) => event.startsWith("gateway."))).toBe(false);

      if (!info) throw new Error("Expected shared backend start information");
      const auth = JSON.parse(await readFile(info.authFile, "utf8")) as { token: string };
      const browserResponse = await fetch(new URL("/__orkestrator/invoke", info.browserUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
        body: JSON.stringify({ command: "greet", args: { name: "Browser" } }),
      });
      expect(browserResponse.status).toBe(200);
      expect(await browserResponse.json()).toEqual({
        result: "Hello, Browser! You've been greeted from the Orkestrator backend!",
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "forwards the explicit managed toolchain directory through backend startup",
    async () => {
      const root = path.resolve(import.meta.dir, "../../..");
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
      const toolchainBinDir = await mkdtemp(
        path.join(os.tmpdir(), "orkestrator-electron-toolchain-"),
      );
      directories.push(dataDir, toolchainBinDir);
      await writeFile(path.join(toolchainBinDir, "codex"), "managed codex");
      const backendProcess = new BackendProcess();
      processes.push(backendProcess);

      const client = await backendProcess.start({
        isDev: true,
        appRoot: root,
        resourceRoot: root,
        dataDir,
        toolchainBinDir,
        gatewayHost: "127.0.0.1",
        gatewayPort: 0,
        allowNonTailscaleBind: true,
        onEvent: () => undefined,
      });

      const child = (backendProcess as unknown as { child: { spawnargs: string[] } }).child;
      const optionIndex = child.spawnargs.indexOf("--toolchain-bin-dir");
      expect(optionIndex).toBeGreaterThan(0);
      expect(child.spawnargs[optionIndex + 1]).toBe(toolchainBinDir);
      await expect(client.invoke("check_codex_cli")).resolves.toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "manages hosted web access without stopping the Electron backend",
    async () => {
      const root = path.resolve(import.meta.dir, "../../..");
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
      const toolsDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-tailscale-"));
      directories.push(dataDir, toolsDir);
      const executable = path.join(toolsDir, "tailscale");
      await writeFile(
        executable,
        `#!/bin/sh
if [ "$*" = "serve status --json" ]; then
  printf '{}\\n'
  exit 0
fi
case " $* " in
  *" off "*) exit 0 ;;
esac
printf 'Available within your tailnet:\\nhttps://workstation.example.ts.net\\n'
`,
      );
      await chmod(executable, 0o755);

      const backendProcess = new BackendProcess();
      processes.push(backendProcess);
      const client = await backendProcess.start({
        isDev: true,
        appRoot: root,
        resourceRoot: root,
        dataDir,
        gatewayPort: 0,
        desktopWebClient: true,
        tailscaleExecutable: executable,
        onEvent: () => undefined,
      });

      expect(backendProcess.getInfo()?.browserUrl).toBeUndefined();
      await expect(
        waitForWebClientStatus(client, (status) => status.running),
      ).resolves.toMatchObject({
        enabled: true,
        running: true,
        url: "https://workstation.example.ts.net/",
      });
      await expect(client.resetWebClientServe()).resolves.toMatchObject({
        enabled: true,
        running: true,
        url: "https://workstation.example.ts.net/",
      });
      await expect(client.setWebClientEnabled(false)).resolves.toMatchObject({
        enabled: false,
        running: false,
        url: null,
      });
      await expect(client.invoke("greet", { name: "Electron" })).resolves.toContain(
        "Hello, Electron!",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  test("reports backend readiness before slow managed Serve initialization finishes", async () => {
    const root = path.resolve(import.meta.dir, "../../..");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
    const toolsDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-tailscale-"));
    directories.push(dataDir, toolsDir);
    const executable = path.join(toolsDir, "tailscale");
    const statusStarted = path.join(toolsDir, "status-started");
    const releaseStatus = path.join(toolsDir, "release-status");
    await writeFile(
      executable,
      `#!/bin/sh
if [ "$*" = "serve status --json" ]; then
  : > ${JSON.stringify(statusStarted)}
  while [ ! -f ${JSON.stringify(releaseStatus)} ]; do sleep 0.01; done
  printf '{}\\n'
  exit 0
fi
case " $* " in
  *" off "*) exit 0 ;;
esac
printf 'Available within your tailnet:\\nhttps://slow.example.ts.net\\n'
`,
    );
    await chmod(executable, 0o755);

    const backendProcess = new BackendProcess();
    processes.push(backendProcess);
    const client = await backendProcess.start({
      isDev: true,
      appRoot: root,
      resourceRoot: root,
      dataDir,
      gatewayPort: 0,
      desktopWebClient: true,
      tailscaleExecutable: executable,
      onEvent: () => undefined,
    });

    await waitForPath(statusStarted, 10_000);
    await expect(client.invoke("greet", { name: "ready" })).resolves.toContain("Hello, ready!");
    await writeFile(releaseStatus, "release\n");
    await expect(waitForWebClientStatus(client, (status) => status.running)).resolves.toMatchObject(
      {
        running: true,
        url: "https://slow.example.ts.net/",
      },
    );
  }, 30_000);

  test(
    "honors a persisted disabled setting without invoking Tailscale",
    async () => {
      const root = path.resolve(import.meta.dir, "../../..");
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
      const toolsDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-tailscale-"));
      directories.push(dataDir, toolsDir);
      const config = defaultConfig();
      config.global.webClientEnabled = false;
      await writeFile(path.join(dataDir, "config.json"), JSON.stringify(config));
      const executable = path.join(toolsDir, "tailscale");
      const callsPath = path.join(toolsDir, "calls");
      await writeFile(
        executable,
        `#!/bin/sh
printf '%s\\n' "$*" >> "$(dirname "$0")/calls"
exit 1
`,
      );
      await chmod(executable, 0o755);

      const backendProcess = new BackendProcess();
      processes.push(backendProcess);
      const client = await backendProcess.start({
        isDev: true,
        appRoot: root,
        resourceRoot: root,
        dataDir,
        gatewayPort: 0,
        desktopWebClient: true,
        tailscaleExecutable: executable,
        onEvent: () => undefined,
      });

      await expect(client.setWebClientEnabled(false)).resolves.toMatchObject({
        enabled: false,
        running: false,
        error: null,
      });
      await expect(readFile(callsPath, "utf8")).rejects.toThrow();
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "keeps backend commands available when managed Serve initialization fails",
    async () => {
      const root = path.resolve(import.meta.dir, "../../..");
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
      directories.push(dataDir);
      const backendProcess = new BackendProcess();
      processes.push(backendProcess);
      const client = await backendProcess.start({
        isDev: true,
        appRoot: root,
        resourceRoot: root,
        dataDir,
        gatewayPort: 0,
        desktopWebClient: true,
        tailscaleExecutable: path.join(dataDir, "missing-tailscale"),
        onEvent: () => undefined,
      });

      await expect(
        waitForWebClientStatus(client, (status) => Boolean(status.error)),
      ).resolves.toMatchObject({
        enabled: true,
        running: false,
      });
      await expect(client.invoke("greet", { name: "still-ready" })).resolves.toContain(
        "Hello, still-ready!",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "adopts and removes an owned Serve route after an ungraceful backend restart",
    async () => {
      const root = path.resolve(import.meta.dir, "../../..");
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
      const toolsDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-tailscale-"));
      directories.push(dataDir, toolsDir);
      const executable = path.join(toolsDir, "tailscale");
      const serveState = path.join(toolsDir, "serve-target");
      await writeFile(
        executable,
        `#!/bin/sh
STATE="$(dirname "$0")/serve-target"
if [ "$*" = "serve status --json" ]; then
  if [ -f "$STATE" ]; then
    target="$(cat "$STATE")"
    printf '{"TCP":{"443":{"HTTPS":true}},"Web":{"workstation.example.ts.net:443":{"Handlers":{"/":{"Proxy":"%s"}}}}}\\n' "$target"
  else
    printf '{}\\n'
  fi
  exit 0
fi
case " $* " in
  *" off "*) rm -f "$STATE"; exit 0 ;;
esac
for last do :; done
printf '%s' "$last" > "$STATE"
printf 'Available within your tailnet:\\nhttps://workstation.example.ts.net\\n'
`,
      );
      await chmod(executable, 0o755);

      const portReservation = createServer();
      await new Promise<void>((resolve) => portReservation.listen(0, "127.0.0.1", resolve));
      const reservedAddress = portReservation.address();
      if (!reservedAddress || typeof reservedAddress === "string")
        throw new Error("Expected TCP address");
      const gatewayPort = reservedAddress.port;
      await new Promise<void>((resolve) => portReservation.close(() => resolve()));

      const firstProcess = new BackendProcess();
      processes.push(firstProcess);
      const firstClient = await firstProcess.start({
        isDev: true,
        appRoot: root,
        resourceRoot: root,
        dataDir,
        gatewayPort,
        desktopWebClient: true,
        tailscaleExecutable: executable,
        onEvent: () => undefined,
      });
      await expect(
        waitForWebClientStatus(firstClient, (status) => status.running),
      ).resolves.toMatchObject({
        running: true,
      });
      expect(await readFile(serveState, "utf8")).toMatch(/^http:\/\/127\.0\.0\.1:/);

      const child = (firstProcess as unknown as { child: { kill(signal: string): boolean } }).child;
      child.kill("SIGKILL");
      const stoppedDeadline = Date.now() + 5_000;
      while (firstProcess.getInfo() !== null && Date.now() < stoppedDeadline) await Bun.sleep(10);
      expect(firstProcess.getInfo()).toBeNull();

      const secondProcess = new BackendProcess();
      processes.push(secondProcess);
      const secondClient = await secondProcess.start({
        isDev: true,
        appRoot: root,
        resourceRoot: root,
        dataDir,
        gatewayPort,
        desktopWebClient: true,
        tailscaleExecutable: executable,
        onEvent: () => undefined,
      });
      await expect(
        waitForWebClientStatus(secondClient, (status) => status.running),
      ).resolves.toMatchObject({
        running: true,
        url: "https://workstation.example.ts.net/",
      });
      await expect(secondClient.setWebClientEnabled(false)).resolves.toMatchObject({
        enabled: false,
        running: false,
        error: null,
      });
      await expect(readFile(serveState, "utf8")).rejects.toThrow();
      await expect(
        readFile(path.join(dataDir, "managed-web-client.json"), "utf8"),
      ).rejects.toThrow();
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "shares concurrent startup and clears stale state when the child exits",
    async () => {
      const root = path.resolve(import.meta.dir, "../../..");
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
      directories.push(dataDir);
      const backendProcess = new BackendProcess();
      processes.push(backendProcess);
      const onUnexpectedExit = mock(() => undefined);
      const options = {
        isDev: true,
        appRoot: root,
        resourceRoot: root,
        dataDir,
        gatewayHost: "127.0.0.1",
        gatewayPort: 0,
        allowNonTailscaleBind: true,
        onEvent: () => undefined,
        onUnexpectedExit,
      };

      const [first, second] = await Promise.all([
        backendProcess.start(options),
        backendProcess.start(options),
      ]);
      expect(first).toBe(second);

      const child = (backendProcess as unknown as { child: { kill(signal: string): boolean } })
        .child;
      child.kill("SIGTERM");
      const deadline = Date.now() + 5_000;
      while (backendProcess.getInfo() !== null && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(backendProcess.getInfo()).toBeNull();
      expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "rotates the shared HTTP credential without losing command access",
    async () => {
      const root = path.resolve(import.meta.dir, "../../..");
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
      directories.push(dataDir);
      const backendProcess = new BackendProcess();
      processes.push(backendProcess);
      const client = await backendProcess.start({
        isDev: true,
        appRoot: root,
        resourceRoot: root,
        dataDir,
        gatewayHost: "127.0.0.1",
        gatewayPort: 0,
        allowNonTailscaleBind: true,
        onEvent: () => undefined,
      });

      await expect(client.setToken("replacement-backend-token-123456")).resolves.toMatchObject({
        token: "replacement-backend-token-123456",
      });
      await expect(client.invoke("greet", { name: "rotated" })).resolves.toContain(
        "Hello, rotated!",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "cleans up state when the child exits before readiness",
    async () => {
      const missingRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-missing-backend-"));
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-backend-"));
      directories.push(missingRoot, dataDir);
      const backendProcess = new BackendProcess();
      processes.push(backendProcess);

      await expect(
        backendProcess.start({
          isDev: true,
          appRoot: missingRoot,
          resourceRoot: missingRoot,
          dataDir,
          gatewayHost: "127.0.0.1",
          gatewayPort: 0,
          allowNonTailscaleBind: true,
          onEvent: () => undefined,
        }),
      ).rejects.toThrow("Backend service exited");
      expect(backendProcess.getInfo()).toBeNull();
      expect((backendProcess as unknown as { child: unknown }).child).toBeNull();
    },
    SPAWN_TIMEOUT_MS,
  );

  test("stop resolves only after the backend child has exited", async () => {
    const backendProcess = new BackendProcess();
    await expect(backendProcess.stop()).resolves.toBeUndefined();

    // A child that takes a moment to drain after SIGTERM, like the backend.
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100)); setInterval(() => {}, 1000);",
      ],
      { stdio: "ignore" },
    );
    await Bun.sleep(200);
    (backendProcess as unknown as { child: ChildProcess }).child = child;
    let exited = false;
    child.once("exit", () => (exited = true));

    await backendProcess.stop();
    expect(exited).toBe(true);
    expect(backendProcess.getPid()).toBeUndefined();
  });
});

describe("BackendProcess startup failure boundaries", () => {
  const READY_TIMEOUT_MS = 30_000;
  const TOKEN = "fake-backend-token-1234567890";

  /**
   * A stand-in for the packaged Bun runtime. It records its pid (kept across
   * `exec`) in `pidFile`, then runs `body`; `$AUTH` names the auth file it
   * should advertise.
   */
  async function fakeBackend(body: string, authFile?: string) {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-startup-boundary-"));
    directories.push(root);
    const auth = authFile ?? path.join(root, "auth.json");
    const pidFile = path.join(root, "pid");
    await mkdir(path.join(root, "bin"), { recursive: true });
    const fakeBun = path.join(root, "bin", "bun");
    await writeFile(
      fakeBun,
      `#!/bin/sh
AUTH=${JSON.stringify(auth)}
printf '%s' "$$" > ${JSON.stringify(pidFile)}.tmp && mv ${JSON.stringify(pidFile)}.tmp ${JSON.stringify(pidFile)}
${body}
`,
    );
    await chmod(fakeBun, 0o755);
    const backendProcess = new BackendProcess();
    processes.push(backendProcess);
    const onUnexpectedExit = mock((_error: Error) => undefined);
    const started = backendProcess.start({
      isDev: false,
      appVersion: "9.9.9-boundary",
      appRoot: root,
      resourceRoot: root,
      dataDir: root,
      gatewayPort: 0,
      onEvent: () => undefined,
      onUnexpectedExit,
    });
    // Observed only through its rejection; the tests assert on it.
    started.catch(() => undefined);
    const pid = async () => {
      await waitForPath(pidFile, 10_000);
      return Number(await readFile(pidFile, "utf8"));
    };
    return { root, auth, backendProcess, started, onUnexpectedExit, pid };
  }

  const READY_LINE = `printf '{"type":"orkestrator-backend-ready","url":"http://127.0.0.1:1/","authFile":"%s","bindAddress":"127.0.0.1","port":1}\\n' "$AUTH"`;

  async function waitForProcessGone(pid: number, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await Bun.sleep(10);
    }
    throw new Error(`Process ${pid} was still running`);
  }

  async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      await Bun.sleep(10);
    }
  }

  test(
    "rejects an auth file without a valid token and stops the child",
    async () => {
      const backend = await fakeBackend(
        `printf '%s' '{"token":"short"}' > "$AUTH"\n${READY_LINE}\nexec sleep 30`,
      );
      const pid = await backend.pid();

      await expect(backend.started).rejects.toThrow(
        "Backend authentication file does not contain a valid token",
      );
      expect(backend.backendProcess.getPid()).toBeUndefined();
      expect(backend.backendProcess.getInfo()).toBeNull();
      await waitForProcessGone(pid);
      expect(backend.onUnexpectedExit).not.toHaveBeenCalled();
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "rejects a child that exits between readiness and client setup",
    async () => {
      // Opening the FIFO writer proves startup processed readiness and opened
      // its reader. Keep the child alive until then, and hold back the token
      // until its exit is observed so client setup must see the dead child.
      const fifoRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-startup-fifo-"));
      directories.push(fifoRoot);
      const fifo = path.join(fifoRoot, "auth.fifo");
      await new Promise<void>((resolve, reject) =>
        spawn("mkfifo", [fifo], { stdio: "ignore" })
          .once("error", reject)
          .once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`mkfifo ${code}`)))),
      );
      const backend = await fakeBackend(`${READY_LINE}\nexec sleep 30`, fifo);
      const pid = await backend.pid();
      const writer = await open(fifo, "w");
      try {
        process.kill(pid, "SIGTERM");
        await waitUntil(() => backend.backendProcess.getPid() === undefined, "the child's exit");
        await writer.writeFile(JSON.stringify({ token: TOKEN }));
      } finally {
        await writer.close();
      }

      await expect(backend.started).rejects.toThrow("Backend service exited during startup");
      expect(backend.backendProcess.getInfo()).toBeNull();
      // Startup never completed, so this is a failed start, not a crash.
      expect(backend.onUnexpectedExit).not.toHaveBeenCalled();
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "rejects after the readiness deadline and stops the silent child",
    async () => {
      const clock = installControlledTimeout(READY_TIMEOUT_MS, {
        label: "backend readiness deadline",
      });
      try {
        const backend = await fakeBackend("exec sleep 30");
        const pid = await backend.pid();
        await waitUntil(() => clock.pendingCount() === 1, "the readiness deadline");

        clock.advance();
        await expect(backend.started).rejects.toThrow("Timed out waiting for the backend service");
        expect(backend.backendProcess.getPid()).toBeUndefined();
        await waitForProcessGone(pid);
        expect(backend.onUnexpectedExit).not.toHaveBeenCalled();
      } finally {
        clock.restore();
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "stop during startup rejects the start and leaves nothing running",
    async () => {
      const backend = await fakeBackend("exec sleep 30");
      const pid = await backend.pid();

      await backend.backendProcess.stop();
      await expect(backend.started).rejects.toThrow("Backend service exited");
      expect(backend.backendProcess.getPid()).toBeUndefined();
      expect(backend.backendProcess.getInfo()).toBeNull();
      await waitForProcessGone(pid);
      expect(backend.onUnexpectedExit).not.toHaveBeenCalled();

      // The supervisor is reusable: the next start launches a fresh child.
      const second = backend.backendProcess.start({
        isDev: false,
        appRoot: backend.root,
        resourceRoot: backend.root,
        dataDir: backend.root,
        gatewayPort: 0,
        onEvent: () => undefined,
      });
      second.catch(() => undefined);
      await waitUntil(() => backend.backendProcess.getPid() !== undefined, "a second child");
      expect(backend.backendProcess.getPid()).not.toBe(pid);
    },
    SPAWN_TIMEOUT_MS,
  );
});
