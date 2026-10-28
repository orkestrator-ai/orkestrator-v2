/** Qualify the criterion object array against the pinned CLI and real model. */
import { expect, test } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";
import {
  VERIFICATION_VERDICT_SCHEMA,
  isVerificationVerdict,
} from "@orkestrator/protocol/build-pipeline";
import {
  policyQualificationCli,
  withPolicyCliFixture,
} from "../../../tests/conformance/execution-policy/vendor-cli.js";
import {
  scriptedAnthropicEndpoint,
  scriptedClaudeEnv,
} from "../../../tests/conformance/execution-policy/scripted-anthropic.js";

const cli = policyQualificationCli("claude");
const verdict = {
  complete: false,
  rationale: "One requirement failed and another needs live evidence.",
  acceptanceCriteria: [
    { id: "ac-4", status: "passed", evidence: "The fixture supplies a passing result." },
    { id: "ac-5", status: "failed", evidence: "The fixture supplies a failing result." },
    { id: "ac-6", status: "not-checked", evidence: "The fixture requires unavailable evidence." },
  ],
};

async function qualify(live: boolean) {
  await withPolicyCliFixture(async (fixture) => {
    const endpoint = live
      ? undefined
      : scriptedAnthropicEndpoint(() => [
          [{ type: "tool_use", id: "criteria_output", name: "StructuredOutput", input: verdict }],
          [{ type: "text", text: "Verification complete." }],
        ]);
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 55_000);
    let result: unknown;
    try {
      for await (const message of query({
        prompt: `Return exactly this verification verdict using the structured output schema: ${JSON.stringify(verdict)}`,
        options: {
          pathToClaudeCodeExecutable: cli!,
          cwd: fixture.cwd,
          model: "haiku",
          persistSession: false,
          settingSources: [],
          tools: [],
          maxTurns: 3,
          abortController,
          outputFormat: { type: "json_schema", schema: VERIFICATION_VERDICT_SCHEMA },
          env: endpoint
            ? scriptedClaudeEnv(fixture, endpoint, join(fixture.root, "claude"))
            : { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
          stderr: () => {},
        },
      })) {
        if (message.type === "result") {
          expect(message.subtype).toBe("success");
          if (message.subtype === "success") result = message.structured_output;
        }
      }
      expect(isVerificationVerdict(result)).toBe(true);
      expect(result).toEqual(verdict);
      if (endpoint) expect(endpoint.modelCalls()).toBeGreaterThan(0);
    } finally {
      clearTimeout(timeout);
      abortController.abort();
      endpoint?.stop();
    }
  });
}

(cli ? test : test.skip)(
  "pinned Claude CLI retains criterion objects and statuses through structured output",
  () => qualify(false),
  60_000,
);
(process.env.ORKESTRATOR_VERIFY_CRITERIA_LIVE === "1" && cli ? test : test.skip)(
  "live Claude model returns the criterion object array",
  () => qualify(true),
  60_000,
);
