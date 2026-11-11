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
 */
import { describe, expect, test } from "bun:test";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, realpath, writeFile } from "node:fs/promises";
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
});
