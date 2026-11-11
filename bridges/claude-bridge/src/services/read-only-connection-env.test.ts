import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  claudeHomeOverrideForTesting,
  claudeUserSettingsPath,
  setClaudeHomeForTesting,
} from "./claude-home.js";
import { READ_ONLY_TURN_POLICY } from "./claude-query-config.js";
import {
  bedrockResolvesAwsProfiles,
  connectionEnvFingerprint,
  isReadOnlyConnectionEnvName,
  readOnlyConnectionOverlay,
  readUserSettingsConnectionEnv,
  selectReadOnlyConnectionEnv,
  withReadOnlyConnectionEnv,
} from "./read-only-connection-env.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function settingsFile(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "claude-connection-env-"));
  directories.push(directory);
  const file = join(directory, "settings.json");
  await writeFile(file, contents);
  return file;
}

const ordinaryPolicy: NativeAgentExecutionPolicy = {
  id: "interactive-host",
  sandbox: "provider",
  approvals: "auto-approve",
  projectResources: true,
  networkAccess: "full",
};

describe("which settings `env` entries a read-only turn keeps (to-do 7565)", () => {
  test("keeps the endpoint, credential and model names of every documented provider", () => {
    for (const name of [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_CUSTOM_HEADERS",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_FABLE_MODEL",
      "CLAUDE_CODE_USE_BEDROCK",
      "AWS_REGION",
      "AWS_BEARER_TOKEN_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "ANTHROPIC_VERTEX_PROJECT_ID",
      "CLOUD_ML_REGION",
      "VERTEX_REGION_CLAUDE_5_5_OPUS",
      "CLAUDE_CODE_USE_FOUNDRY",
      "ANTHROPIC_FOUNDRY_RESOURCE",
      "HTTPS_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "CLAUDE_CODE_CLIENT_CERT",
    ]) {
      expect(isReadOnlyConnectionEnvName(name)).toBe(true);
    }
  });

  test("drops anything that runs a program, loads configuration or changes behaviour", () => {
    for (const name of [
      "NODE_OPTIONS",
      "BASH_ENV",
      "PATH",
      "LD_PRELOAD",
      "CLAUDE_CODE_SHELL_PREFIX",
      "BASH_MAX_OUTPUT_LENGTH",
      "AWS_CONFIG_FILE",
      "AWS_SHARED_CREDENTIALS_FILE",
      // Selects a profile, which can name a credential_process.
      "AWS_PROFILE",
      "GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES",
      "ANTHROPIC_CONFIG_DIR",
      "ANTHROPIC_LOG",
      "CLAUDE_CONFIG_DIR",
      "anthropic_base_url",
    ]) {
      expect(isReadOnlyConnectionEnvName(name)).toBe(false);
    }
  });

  test("selects only connection entries from a settings document, never its other keys", () => {
    expect(
      selectReadOnlyConnectionEnv({
        apiKeyHelper: "/bin/echo key",
        hooks: { Stop: [] },
        permissions: { allow: ["Bash(*)"] },
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:47123",
          ANTHROPIC_AUTH_TOKEN: "fixture-token",
          CLAUDE_CODE_USE_BEDROCK: 1,
          CLAUDE_CODE_SKIP_BEDROCK_AUTH: true,
          NODE_OPTIONS: "--require /tmp/evil.js",
          BASH_MAX_OUTPUT_LENGTH: "200000",
          AWS_REGION: { nested: true },
          AWS_PROFILE: null,
          ANTHROPIC_API_KEY: "a\0b",
          ANTHROPIC_MODEL: "x".repeat(16 * 1024 + 1),
        },
      }),
    ).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:47123",
      ANTHROPIC_AUTH_TOKEN: "fixture-token",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: "true",
    });
  });

  test("a malformed document or `env` names nothing", () => {
    for (const document of [null, "text", [], {}, { env: null }, { env: ["A"] }, { env: "A=1" }]) {
      expect(selectReadOnlyConnectionEnv(document)).toEqual({});
    }
  });

  test("bounds how many entries it takes", () => {
    const env = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`VERTEX_REGION_CLAUDE_${index}`, "us-east5"]),
    );
    expect(Object.keys(selectReadOnlyConnectionEnv({ env }))).toHaveLength(64);
  });

  test("reads the user settings file, and a missing or malformed one names nothing", async () => {
    const file = await settingsFile(
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1", PATH: "/tmp" } }),
    );
    expect(await readUserSettingsConnectionEnv(file)).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
    });
    expect(await readUserSettingsConnectionEnv(await settingsFile("{ not json"))).toEqual({});
    expect(await readUserSettingsConnectionEnv(join(tmpdir(), "missing-claude-settings"))).toEqual(
      {},
    );
  });
});

describe("withReadOnlyConnectionEnv", () => {
  const connection = async () => ({
    ANTHROPIC_BASE_URL: "http://127.0.0.1:47123",
    ANTHROPIC_AUTH_TOKEN: "settings-token",
  });

  test("adds the settings' connection to a read-only turn, over the bridge's own values", async () => {
    const environment = await withReadOnlyConnectionEnv(
      READ_ONLY_TURN_POLICY,
      { PATH: "/usr/bin", ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
      connection,
    );
    expect(environment).toEqual({
      PATH: "/usr/bin",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:47123",
      ANTHROPIC_AUTH_TOKEN: "settings-token",
    });
  });

  test("leaves a turn that loads the settings file itself unchanged, without reading it", async () => {
    let reads = 0;
    const counted = async () => {
      reads += 1;
      return connection();
    };
    const environment = { PATH: "/usr/bin" };
    expect(await withReadOnlyConnectionEnv(ordinaryPolicy, environment, counted)).toBe(environment);
    expect(await withReadOnlyConnectionEnv(undefined, environment, counted)).toBe(environment);
    expect(reads).toBe(0);
  });

  test("keeps the environment as it was when the settings name no connection", async () => {
    const environment = { PATH: "/usr/bin" };
    expect(
      await withReadOnlyConnectionEnv(READ_ONLY_TURN_POLICY, environment, async () => ({})),
    ).toBe(environment);
  });
});

describe("a Bedrock connection that would resolve AWS profiles (review finding)", () => {
  test("is one that names no skip flag, bearer token or static key pair", () => {
    expect(bedrockResolvesAwsProfiles({})).toBe(false);
    expect(bedrockResolvesAwsProfiles({ CLAUDE_CODE_USE_BEDROCK: "0" })).toBe(false);
    expect(bedrockResolvesAwsProfiles({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe(true);
    // A doubtful switch counts as on, and a doubtful skip flag as off.
    expect(bedrockResolvesAwsProfiles({ CLAUDE_CODE_USE_BEDROCK: "maybe" })).toBe(true);
    expect(
      bedrockResolvesAwsProfiles({
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_SKIP_BEDROCK_AUTH: "x",
      }),
    ).toBe(true);
    expect(
      bedrockResolvesAwsProfiles({
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
      }),
    ).toBe(false);
    expect(
      bedrockResolvesAwsProfiles({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_BEARER_TOKEN_BEDROCK: "t" }),
    ).toBe(false);
    expect(
      bedrockResolvesAwsProfiles({ CLAUDE_CODE_USE_BEDROCK: "true", AWS_ACCESS_KEY_ID: "AKIA" }),
    ).toBe(true);
    expect(
      bedrockResolvesAwsProfiles({
        CLAUDE_CODE_USE_BEDROCK: "true",
        AWS_ACCESS_KEY_ID: "AKIA",
        AWS_SECRET_ACCESS_KEY: "secret",
      }),
    ).toBe(false);
  });

  test("the settings' Bedrock switch and credentials are withheld; endpoint and models stay", async () => {
    const settings = {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      AWS_SESSION_TOKEN: "partial",
      ANTHROPIC_BEDROCK_BASE_URL: "http://127.0.0.1:47123",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-arn",
    };
    expect(readOnlyConnectionOverlay({ PATH: "/usr/bin" }, settings)).toEqual({
      overlay: {
        AWS_REGION: "us-east-1",
        ANTHROPIC_BEDROCK_BASE_URL: "http://127.0.0.1:47123",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-arn",
      },
      withheldBedrock: true,
    });
    const environment = await withReadOnlyConnectionEnv(
      READ_ONLY_TURN_POLICY,
      { PATH: "/usr/bin" },
      async () => settings,
    );
    expect(environment.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(environment.AWS_SESSION_TOKEN).toBeUndefined();
    expect(bedrockResolvesAwsProfiles(environment)).toBe(false);
  });

  test("a settings key pair the bridge's environment completes is not the profile chain", () => {
    expect(
      readOnlyConnectionOverlay(
        { AWS_SECRET_ACCESS_KEY: "bridge-secret" },
        { CLAUDE_CODE_USE_BEDROCK: "1", AWS_ACCESS_KEY_ID: "AKIA" },
      ).withheldBedrock,
    ).toBe(false);
  });

  test("an emptied bridge credential cannot send the turn to the profile chain", () => {
    expect(
      readOnlyConnectionOverlay(
        { CLAUDE_CODE_USE_BEDROCK: "1", AWS_BEARER_TOKEN_BEDROCK: "bridge-token" },
        { AWS_BEARER_TOKEN_BEDROCK: "" },
      ),
    ).toEqual({ overlay: {}, withheldBedrock: true });
  });

  test("bearer token, static key pair and skip flag connections are taken whole", () => {
    for (const credential of [
      { AWS_BEARER_TOKEN_BEDROCK: "bearer" },
      { AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "secret", AWS_SESSION_TOKEN: "s" },
      { CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1", ANTHROPIC_BEDROCK_BASE_URL: "http://gateway" },
    ]) {
      const settings = { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1", ...credential };
      expect(readOnlyConnectionOverlay({}, settings)).toEqual({
        overlay: settings,
        withheldBedrock: false,
      });
    }
  });

  test("a bridge already on the profile chain is the launch's choice and is left as it is", () => {
    const settings = { AWS_REGION: "eu-west-1", ANTHROPIC_MODEL: "model" };
    expect(readOnlyConnectionOverlay({ CLAUDE_CODE_USE_BEDROCK: "1" }, settings)).toEqual({
      overlay: settings,
      withheldBedrock: false,
    });
  });
});

describe("which settings file a coordinator bridge reads (review finding)", () => {
  test("its private CLAUDE_CONFIG_DIR, so the host settings' connection never reaches it", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-coordinator-settings-"));
    directories.push(root);
    const hostConfig = join(root, "host-claude");
    const coordinatorHome = join(root, "coordinator");
    await mkdir(hostConfig, { recursive: true });
    await mkdir(coordinatorHome, { mode: 0o700 });
    await writeFile(
      join(hostConfig, "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1" } }),
    );
    const previous = process.env.CLAUDE_CONFIG_DIR;
    const previousOverride = claudeHomeOverrideForTesting();
    // Follow the environment, as a launched bridge does. CLAUDE_CONFIG_DIR is
    // always set here, so the developer's own settings are never read.
    setClaudeHomeForTesting(null);
    try {
      // A bridge on the host's configuration reads its settings file.
      process.env.CLAUDE_CONFIG_DIR = hostConfig;
      expect(claudeUserSettingsPath()).toBe(join(hostConfig, "settings.json"));
      expect(await readUserSettingsConnectionEnv()).toEqual({
        ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
      });
      // `applyCoordinatorClaudeAccount` points a coordinator at its own home.
      process.env.CLAUDE_CONFIG_DIR = coordinatorHome;
      expect(claudeUserSettingsPath()).toBe(join(coordinatorHome, "settings.json"));
      expect(await withReadOnlyConnectionEnv(READ_ONLY_TURN_POLICY, { PATH: "/usr/bin" })).toEqual({
        PATH: "/usr/bin",
      });
    } finally {
      setClaudeHomeForTesting(previousOverride);
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
});

describe("connectionEnvFingerprint", () => {
  test("names only connection variables, in a stable order", () => {
    expect(
      connectionEnvFingerprint({
        PATH: "/usr/bin",
        ANTHROPIC_BASE_URL: "http://b",
        ANTHROPIC_API_KEY: "a",
        GH_TOKEN: "gh",
      }),
    ).toEqual([
      ["ANTHROPIC_API_KEY", "a"],
      ["ANTHROPIC_BASE_URL", "http://b"],
    ]);
  });
});
