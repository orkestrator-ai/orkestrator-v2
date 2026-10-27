/** Offline qualification of the real pinned Claude CLI's private-input contract. */
import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  policyQualificationCli,
  withPolicyCliFixture,
} from "../../../../tests/conformance/execution-policy/vendor-cli.js";
import {
  scriptedAnthropicEndpoint,
  scriptedClaudeEnv,
} from "../../../../tests/conformance/execution-policy/scripted-anthropic.js";
import { generateClaudeSessionTitle } from "./session-title-runners.js";
import { runCommand } from "./shell.js";

const cli = policyQualificationCli("claude");
(cli ? test : test.skip)(
  "the pinned Claude title runner accepts stdin and returns a title without a persisted session",
  async () => {
    await withPolicyCliFixture(async (fixture) => {
      const endpoint = scriptedAnthropicEndpoint(() => [
        [{ type: "text", text: "Private input title" }],
      ]);
      try {
        expect(
          await generateClaudeSessionTitle({
            executable: cli!,
            env: scriptedClaudeEnv(fixture, endpoint, join(fixture.root, "claude")),
            source: "PRIVATE-STDIN-MARKER fixture request",
            run: runCommand,
            temporaryRoot: fixture.root,
            timeoutMs: 15_000,
          }),
        ).toBe("Private input title");
        expect(endpoint.modelCalls()).toBe(1);
        const { readdir } = await import("node:fs/promises");
        const files = await readdir(fixture.root, { recursive: true });
        expect(files.some((name) => name.endsWith(".jsonl"))).toBe(false);
        expect(files.some((name) => name.includes("orkestrator-session-title-"))).toBe(false);
      } finally {
        endpoint.stop();
      }
    });
  },
  20_000,
);
