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
const liveTest = cli ? test : test.skip;

/**
 * `claude -p` exits 1 on a startup failure since 2.1.31x. Whatever the failure,
 * the runner has to reject so the service moves to its next strategy, and the
 * error the CLI printed must never come back as a title.
 */
async function expectRejected(
  fixture: { root: string; env: Record<string, string> },
  env: Record<string, string | undefined>,
): Promise<void> {
  const outcome = await generateClaudeSessionTitle({
    executable: cli!,
    env,
    source: "fixture request",
    run: runCommand,
    temporaryRoot: fixture.root,
    timeoutMs: 15_000,
  }).then(
    (title) => ({ title }),
    (error: unknown) => ({ error }),
  );
  expect(outcome).toEqual({ error: expect.any(Error) });
  const { readdir } = await import("node:fs/promises");
  expect(
    (await readdir(fixture.root)).some((name) => name.startsWith("orkestrator-session-title-")),
  ).toBe(false);
}

liveTest(
  "a startup failure of the pinned CLI rejects without a title",
  async () => {
    await withPolicyCliFixture(async (fixture) => {
      const endpoint = scriptedAnthropicEndpoint(() => []);
      try {
        const env = scriptedClaudeEnv(fixture, endpoint, join(fixture.root, "claude"));
        // An unusable proxy is one of the CLI's own startup refusals.
        await expectRejected(fixture, { ...env, HTTPS_PROXY: "not a url::" });
        expect(endpoint.modelCalls()).toBe(0);
      } finally {
        endpoint.stop();
      }
    });
  },
  20_000,
);

liveTest(
  "missing credentials and a refused request both reject without a title",
  async () => {
    await withPolicyCliFixture(async (fixture) => {
      const endpoint = scriptedAnthropicEndpoint(() => []);
      try {
        const env = scriptedClaudeEnv(fixture, endpoint, join(fixture.root, "claude"));
        await expectRejected(fixture, { ...env, ANTHROPIC_API_KEY: undefined });
        // The script has no turns, so the first model call answers HTTP 400.
        await expectRejected(fixture, env);
      } finally {
        endpoint.stop();
      }
    });
  },
  35_000,
);

liveTest(
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
