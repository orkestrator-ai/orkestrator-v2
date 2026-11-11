import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { READ_ONLY_TURN_POLICY } from "./claude-query-config.js";
import {
  connectionEnvFingerprint,
  isReadOnlyConnectionEnvName,
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
