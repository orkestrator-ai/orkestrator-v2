/**
 * Offline qualification, on the pinned CLI and a scripted local Messages
 * endpoint, of a read-only turn whose model connection lives only in the user
 * settings file (to-do 7565). No login and no billed turn: the endpoint is a
 * loopback fixture and the key is a fixture string.
 *
 * - `ordinary`: a turn that loads the user settings file reaches the endpoint
 *   the file names, which is what every ordinary turn of a session does.
 * - `read-only-before`: the read-only turn as it was (no settings file, the
 *   bridge's environment as is) never reaches it.
 * - `read-only-after`: the same turn with the environment the bridge now gives
 *   it (`withReadOnlyConnectionEnv`) reaches it, still loading no settings file.
 *
 * The Bedrock cases pin the review finding that an AWS profile can run a
 * command. The private HOME's `~/.aws/config` gives the default profile and a
 * `source_profile` chain a `credential_process` that only writes a marker:
 *
 * - `bedrock-profile-unfiltered`: the settings `env` passed as is
 *   (`AWS_PROFILE` included) makes the CLI run the helper. This is the control
 *   that shows the sentinel detects the risk.
 * - `bedrock-profile-after`: the bridge's environment withholds that Bedrock
 *   connection, and no helper runs.
 * - `bedrock-static-after`: a static key pair in the settings `env` still
 *   reaches the Bedrock endpoint, signed, and no helper runs.
 */
import { describe, expect, test } from "bun:test";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  scriptedAnthropicEndpoint,
  scriptedClaudeEnv,
} from "../../../tests/conformance/execution-policy/scripted-anthropic.js";
import { withPolicyCliFixture } from "../../../tests/conformance/execution-policy/vendor-cli.js";
import { READ_ONLY_TURN_POLICY } from "./services/claude-query-config.js";
import {
  readUserSettingsConnectionEnv,
  withReadOnlyConnectionEnv,
} from "./services/read-only-connection-env.js";

async function collect(options: Options, controller: AbortController): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  try {
    for await (const message of query({ prompt: "Say done", options })) {
      messages.push(message);
      if (messages.length > 32) {
        controller.abort();
        throw new Error("CLI fixture message bound exceeded");
      }
    }
  } catch {
    // A refused turn may end the stream with an error; the result says why.
  }
  return messages;
}

type Case = "ordinary" | "read-only-before" | "read-only-after";

async function runTurn(scenario: Case) {
  return withPolicyCliFixture(async (fixture) => {
    const cwd = await realpath(fixture.cwd);
    const endpoint = scriptedAnthropicEndpoint(() => [[{ type: "text", text: "Done." }]]);
    const configDir = join(fixture.root, "claude");
    await mkdir(configDir);
    const settingsPath = join(configDir, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: endpoint.url.origin, ANTHROPIC_API_KEY: "fixture-key" },
      }),
    );
    // The bridge's own environment names no endpoint and no credential.
    const bridgeEnvironment = {
      ...scriptedClaudeEnv(fixture, endpoint, configDir),
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: undefined,
    } as NodeJS.ProcessEnv;
    const env =
      scenario === "read-only-after"
        ? await withReadOnlyConnectionEnv(READ_ONLY_TURN_POLICY, bridgeEnvironment, () =>
            readUserSettingsConnectionEnv(settingsPath),
          )
        : bridgeEnvironment;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const cliPath = process.env.ORKESTRATOR_POLICY_CLAUDE_PATH?.trim();
    const options: Options = {
      cwd,
      ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {}),
      model: "claude-sonnet-4-6",
      maxTurns: 1,
      persistSession: false,
      settingSources: scenario === "ordinary" ? ["user"] : [],
      tools: [],
      abortController: controller,
      env,
      stderr: () => {},
    };
    let messages: SDKMessage[];
    try {
      messages = await collect(options, controller);
    } finally {
      clearTimeout(timeout);
      endpoint.stop();
    }
    expect(controller.signal.aborted).toBe(false);
    const result = messages.find((message) => message.type === "result");
    return {
      modelCalls: endpoint.modelCalls(),
      succeeded: result?.type === "result" && result.subtype === "success" && !result.is_error,
      // The failure users saw in every reviewer (pinned CLI 2.1.319, 2026-11-10).
      notLoggedIn: JSON.stringify(messages).includes("Not logged in"),
    };
  });
}

type BedrockCase = "bedrock-profile-unfiltered" | "bedrock-profile-after" | "bedrock-static-after";

async function runBedrockTurn(scenario: BedrockCase) {
  return withPolicyCliFixture(async (fixture) => {
    const cwd = await realpath(fixture.cwd);
    // Any request is recorded and refused: these cases count requests and
    // helper runs, not a model answer. STS is pointed here too, so a role
    // chain never reaches the network.
    const seen: { path: string; signed: boolean }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (seen.length < 64)
          seen.push({
            path: new URL(request.url).pathname,
            signed: (request.headers.get("authorization") ?? "").startsWith("AWS4-HMAC-SHA256"),
          });
        return new Response("{}", { status: 500 });
      },
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const home = fixture.env.HOME!;
    const markers = join(fixture.root, "helper-markers");
    await mkdir(markers);
    await mkdir(join(home, ".aws"));
    const helper = join(fixture.root, "credential-helper.sh");
    await writeFile(
      helper,
      `#!/bin/sh\n: > "${markers}/$1"\nprintf '{"Version":1,"AccessKeyId":"AKIAFIXTURE","SecretAccessKey":"fixture"}'\n`,
      { mode: 0o700 },
    );
    await writeFile(
      join(home, ".aws", "config"),
      [
        "[default]",
        `credential_process = /bin/sh ${helper} default`,
        "[profile reviewer]",
        "role_arn = arn:aws:iam::000000000000:role/fixture",
        "source_profile = helper",
        "[profile helper]",
        `credential_process = /bin/sh ${helper} source-profile`,
        "",
      ].join("\n"),
    );
    const configDir = join(fixture.root, "claude");
    await mkdir(configDir);
    const settingsPath = join(configDir, "settings.json");
    const settingsEnv: Record<string, string> = {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      ANTHROPIC_BEDROCK_BASE_URL: origin,
      ...(scenario === "bedrock-static-after"
        ? { AWS_ACCESS_KEY_ID: "AKIASTATICFIXTURE", AWS_SECRET_ACCESS_KEY: "fixture-secret" }
        : { AWS_PROFILE: "reviewer" }),
    };
    await writeFile(settingsPath, JSON.stringify({ env: settingsEnv }));
    const bridgeEnvironment = {
      ...fixture.env,
      CLAUDE_CONFIG_DIR: configDir,
      AWS_ENDPOINT_URL_STS: origin,
      AWS_EC2_METADATA_DISABLED: "true",
      CLAUDE_CODE_MAX_RETRIES: "0",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
    } as NodeJS.ProcessEnv;
    const env =
      scenario === "bedrock-profile-unfiltered"
        ? { ...bridgeEnvironment, ...settingsEnv }
        : await withReadOnlyConnectionEnv(READ_ONLY_TURN_POLICY, bridgeEnvironment, () =>
            readUserSettingsConnectionEnv(settingsPath),
          );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const cliPath = process.env.ORKESTRATOR_POLICY_CLAUDE_PATH?.trim();
    const options: Options = {
      cwd,
      ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {}),
      model: "claude-sonnet-4-6",
      maxTurns: 1,
      persistSession: false,
      settingSources: [],
      tools: [],
      abortController: controller,
      env,
      stderr: () => {},
    };
    try {
      await collect(options, controller);
    } finally {
      clearTimeout(timeout);
      await server.stop(true);
    }
    return {
      helperRuns: (await readdir(markers)).sort(),
      bedrockRequests: seen.filter((request) => request.path.startsWith("/model/")).length > 0,
      signed: seen.some((request) => request.path.startsWith("/model/") && request.signed),
    };
  });
}

const supported = process.platform === "darwin" || process.platform === "linux";
describe("Claude read-only turn on a settings-file connection (to-do 7565)", () => {
  (supported ? test : test.skip)(
    "ordinary",
    async () => {
      expect(await runTurn("ordinary")).toEqual({
        modelCalls: 1,
        succeeded: true,
        notLoggedIn: false,
      });
    },
    20_000,
  );
  (supported ? test : test.skip)(
    "read-only-before",
    async () => {
      expect(await runTurn("read-only-before")).toEqual({
        modelCalls: 0,
        succeeded: false,
        notLoggedIn: true,
      });
    },
    20_000,
  );
  (supported ? test : test.skip)(
    "read-only-after",
    async () => {
      expect(await runTurn("read-only-after")).toEqual({
        modelCalls: 1,
        succeeded: true,
        notLoggedIn: false,
      });
    },
    20_000,
  );
  (supported ? test : test.skip)(
    "bedrock-profile-unfiltered",
    async () => {
      const outcome = await runBedrockTurn("bedrock-profile-unfiltered");
      expect(outcome.helperRuns).toContain("source-profile");
    },
    20_000,
  );
  (supported ? test : test.skip)(
    "bedrock-profile-after",
    async () => {
      expect(await runBedrockTurn("bedrock-profile-after")).toEqual({
        helperRuns: [],
        bedrockRequests: false,
        signed: false,
      });
    },
    20_000,
  );
  (supported ? test : test.skip)(
    "bedrock-static-after",
    async () => {
      expect(await runBedrockTurn("bedrock-static-after")).toEqual({
        helperRuns: [],
        bedrockRequests: true,
        signed: true,
      });
    },
    20_000,
  );
});
