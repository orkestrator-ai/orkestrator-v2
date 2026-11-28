import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  formatProfileEnvironmentScrub,
  isKeptProfileKnob,
  scrubProfileEnvironment,
} from "./profile-environment.js";

const homeDir = "/home/tester";
const productionDataDir = "/home/tester/.config/orkestrator-v2";
const roots = { homeDir, productionDataDir };
const options = { roots, platform: "linux" as const };
const accountHome = `${productionDataDir}/agent-accounts/claude/0b3c`;

/** What an agent session launched by the production app inherits (values are fakes). */
const productionShell: NodeJS.ProcessEnv = {
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
  CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/claude-messaging.sock",
  CLAUDE_CODE_MESSAGING_TOKEN: "fake-messaging-token",
  CLAUDE_CODE_SESSION_ID: "fake-session",
  CLAUDE_PID: "4242",
  CLAUDE_AGENT_SDK_VERSION: "0.0.0",
  CLAUDE_CLI_PATH: `${productionDataDir}/toolchains/bin/abc/claude`,
  CLAUDE_CONFIG_DIR: accountHome,
  CODEX_CLI_PATH: `${productionDataDir}/toolchains/bin/abc/codex`,
  CODEX_HOME: `${productionDataDir}/agent-accounts/codex/77aa`,
  ANTHROPIC_BASE_URL: "http://127.0.0.1:45507/anthropic",
  NODE_ENV: "production",
  ORKESTRATOR_AGENT_MCP_URL: "http://127.0.0.1:45507/mcp",
  ORKESTRATOR_AGENT_MCP_TOKEN: "fake-mcp-token",
  ORKESTRATOR_CAPABILITY_SESSION_PLUGINS_DIR: `${productionDataDir}/capability-session-plugins`,
  ORKESTRATOR_CLAUDE_ACCOUNT_HOME: accountHome,
  ORKESTRATOR_ENVIRONMENT_ID: "parent-environment",
  ORKESTRATOR_GATEWAY_DISABLED: "1",
  ORKESTRATOR_NATIVE_AGENT_BRIDGE: "claude",
  ORKESTRATOR_PARENT_PID: "1234",
  ORKESTRATOR_PORT_BASE: "21000",
  ORKESTRATOR_PORT_COUNT: "10",
  ORKESTRATOR_PORT_MAX: "21009",
  ORKESTRATOR_RUNTIME_PROFILE_FILE: "/elsewhere/profile.json",
  ORKESTRATOR_TOOLCHAIN_BIN: `${productionDataDir}/toolchains/bin/abc`,
  ORKESTRATOR_VERSION: "2.39.15",
  // A parent profile's backend sets these for its own children.
  ORKESTRATOR_AGENT_TEST_ISOLATED: "1",
  ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR: accountHome,
  // Some other tool's variable that happens to point into the data directory.
  SOME_TOOL_CACHE: `${productionDataDir}/cache`,
};

/** Variables a profile needs, and the documented test knobs. */
const keptShell: NodeJS.ProcessEnv = {
  HOME: homeDir,
  PWD: "/work/checkout",
  LANG: "en_US.UTF-8",
  DISPLAY: ":0",
  DOCKER_HOST: "unix:///home/tester/.colima/docker.sock",
  ANTHROPIC_API_KEY: "fake-api-key",
  OPENAI_API_KEY: "fake-openai-key",
  PI_CODING_AGENT_DIR: "/home/tester/.pi/agent",
  ORKESTRATOR_HOST_REACHABILITY_CHECK: "off",
  ORKESTRATOR_LOG_LEVEL: "review=debug",
  ORKESTRATOR_BRIDGE_DEBUG: "0",
  ORKESTRATOR_AGENT_TEST_HEADLESS: "1",
  ORKESTRATOR_AGENT_TEST_PROFILE: "qa-scrub",
  ORKESTRATOR_AGENT_TEST_USAGE_ORIGIN: "http://127.0.0.1:41234",
  ORKESTRATOR_TEST_SCHEDULER_DIR: "/home/tester/.config/orkestrator-v2-dev/profiles/qa/sched",
  ORKESTRATOR_CONTROL_MCP_PORT: "0",
  ORKESTRATOR_PROVIDER_RECORD_DIR: "/tmp/recordings",
};

describe("scrubProfileEnvironment", () => {
  test("drops every production-pointing variable and keeps the rest", () => {
    const scrub = scrubProfileEnvironment(
      { ...productionShell, ...keptShell, PATH: "/usr/bin" },
      options,
    );
    expect(scrub.dropped).toEqual(Object.keys(productionShell).sort());
    expect(scrub.env).toEqual({ ...keptShell, PATH: "/usr/bin" });
    expect(scrub.droppedPathEntries).toBe(0);
  });

  test("never mutates the inherited environment", () => {
    const inherited = { ...productionShell };
    scrubProfileEnvironment(inherited, options);
    expect(inherited).toEqual(productionShell);
  });

  test("drops NODE_ENV whatever its value", () => {
    for (const value of ["production", "development", "test"]) {
      expect(scrubProfileEnvironment({ NODE_ENV: value }, options).dropped).toEqual(["NODE_ENV"]);
    }
  });

  test("keeps a provider home outside the data directory for --credential-source routes", () => {
    const outside = {
      CLAUDE_CONFIG_DIR: "/home/tester/.claude-work",
      CODEX_HOME: "/home/tester/.codex",
    };
    expect(scrubProfileEnvironment(outside, options)).toEqual({
      env: outside,
      dropped: [],
      droppedPathEntries: 0,
    });
  });

  test("recognises a home-relative path and the macOS data directory", () => {
    const scrub = scrubProfileEnvironment(
      {
        CLAUDE_CONFIG_DIR: "~/.config/orkestrator-v2/agent-accounts/claude/1",
        CODEX_HOME: "/home/tester/Library/Application Support/orkestrator-v2/agent-accounts/x",
      },
      options,
    );
    expect(scrub.dropped).toEqual(["CLAUDE_CONFIG_DIR", "CODEX_HOME"]);
  });

  test("removes only the PATH entries inside the data directory", () => {
    const scrub = scrubProfileEnvironment(
      { PATH: `/usr/bin:${productionDataDir}/toolchains/bin/abc:/bin` },
      options,
    );
    expect(scrub.env.PATH).toBe("/usr/bin:/bin");
    expect(scrub.droppedPathEntries).toBe(1);
    expect(scrub.dropped).toEqual([]);
  });

  test("drops an unlisted variable that addresses an installed app port", () => {
    expect(
      scrubProfileEnvironment({ SOME_PROXY: "http://localhost:34121/" }, options).dropped,
    ).toEqual(["SOME_PROXY"]);
    // Only the port itself, not a number that starts with it.
    expect(
      scrubProfileEnvironment({ SOME_PROXY: "http://localhost:345070" }, options).dropped,
    ).toEqual([]);
  });

  test("refuses a kept knob that points at the real install, naming it but not its value", () => {
    const run = (env: NodeJS.ProcessEnv) => () => scrubProfileEnvironment(env, options);
    expect(run({ ORKESTRATOR_CONTROL_MCP_PORT: "34122" })).toThrow(
      /Refusing to start the profile: ORKESTRATOR_CONTROL_MCP_PORT points/,
    );
    const secretPath = `${productionDataDir}/recordings`;
    let message = "";
    try {
      scrubProfileEnvironment(
        {
          ORKESTRATOR_PROVIDER_RECORD_DIR: secretPath,
          ORKESTRATOR_AGENT_TEST_USAGE_ORIGIN: "http://127.0.0.1:45507",
        },
        options,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(
      "ORKESTRATOR_AGENT_TEST_USAGE_ORIGIN, ORKESTRATOR_PROVIDER_RECORD_DIR point",
    );
    expect(message).not.toContain(secretPath);
    expect(message).not.toContain("45507/");
  });
});

describe("formatProfileEnvironmentScrub", () => {
  test("names the dropped variables and PATH entries without their values", () => {
    const scrub = scrubProfileEnvironment(
      { ...productionShell, PATH: `${productionDataDir}/toolchains/bin/abc:/usr/bin` },
      options,
    );
    const line = formatProfileEnvironmentScrub(scrub)!;
    expect(line).toStartWith(
      `Profile environment: dropped ${Object.keys(productionShell).length} inherited environment variables that could reach the parent Orkestrator install: ANTHROPIC_BASE_URL, CLAUDECODE,`,
    );
    expect(line).toEndWith(
      "; removed 1 PATH entry inside the production data directory (values not shown).",
    );
    for (const name of Object.keys(productionShell)) expect(line).toContain(name);
    for (const value of Object.values(productionShell)) {
      // Paths, URLs and tokens; short switches such as "1" are not distinctive.
      if (/[/]|token/.test(value!)) expect(line).not.toContain(value!);
    }
  });

  test("uses the singular for one variable and says nothing when nothing was dropped", () => {
    expect(formatProfileEnvironmentScrub({ dropped: ["NODE_ENV"], droppedPathEntries: 0 })).toBe(
      "Profile environment: dropped 1 inherited environment variable that could reach the parent Orkestrator install: NODE_ENV (values not shown).",
    );
    expect(formatProfileEnvironmentScrub({ dropped: [], droppedPathEntries: 0 })).toBeNull();
  });
});

describe("isKeptProfileKnob", () => {
  test("every ORKESTRATOR_ name agent-testing.md documents for a caller is kept or dropped on purpose", () => {
    // Names the guide mentions that a caller must not pass to a profile: the
    // launcher, Electron or the profile's backend set them itself, or the
    // guide names them as parent-app values the scrub drops.
    const setByTheProfile = new Set([
      "ORKESTRATOR_AGENT_MCP_URL",
      "ORKESTRATOR_ENVIRONMENT_ID",
      "ORKESTRATOR_RENDERER_DEV_SERVER_URL",
      "ORKESTRATOR_VERSION",
      "ORKESTRATOR_WORKTREE_DIR",
    ]);
    const guide = readFileSync(
      path.resolve(import.meta.dir, "../../../../docs/development/agent-testing.md"),
      "utf8",
    );
    const documented = new Set(guide.match(/\bORKESTRATOR_[A-Z0-9_]*[A-Z0-9]\b/g) ?? []);
    const unaccounted = [...documented].filter(
      (name) =>
        !isKeptProfileKnob(name) &&
        !setByTheProfile.has(name) &&
        !name.startsWith("ORKESTRATOR_AGENT_TEST_HOST_") &&
        name !== "ORKESTRATOR_AGENT_TEST_ISOLATED" &&
        name !== "ORKESTRATOR_AGENT_TEST_HIDDEN_WINDOWS",
    );
    expect(unaccounted).toEqual([]);
  });
});
