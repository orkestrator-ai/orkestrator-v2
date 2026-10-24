/**
 * The shared execution-policy conformance suite (`tests/conformance/execution-policy`)
 * from the backend's side.
 *
 * Three things only the backend can check: that each shape is what the
 * resolver really returns, that the axes a container owns (its boundary and
 * its firewall) match the environment, and that a build prompt carries the
 * approval controls the bridge runners assume. It also runs the suite for
 * OpenCode, whose adapter lives here: the session's permission rules are
 * captured from the `session.create` call itself.
 */
import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  policyQualificationCli,
  policyCliOutput,
  withPolicyCliFixture,
} from "../../../../tests/conformance/execution-policy/vendor-cli.js";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { PINNED_TOOLCHAIN_VERSIONS } from "@orkestrator/toolchain/manifest";
import {
  nativeAgentPolicyEffects,
  resolveNativeAgentApprovalMode,
} from "@orkestrator/protocol/native-agent";
import {
  conformancePromptControls,
  POLICY_SHAPES,
  runExecutionPolicyConformance,
  type AdapterEffects,
  type PolicyShape,
} from "../../../../tests/conformance/execution-policy/suite.js";
import type { BridgeConnection } from "./agent-provider-contract.js";
import { bridgePromptBody } from "./http-bridge-prompt-body.js";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";
import { OpenCodeReviewSessionPermissions } from "./opencode-review-session-permissions.js";

const shapes = POLICY_SHAPES as readonly PolicyShape[];

describe("execution policy shapes", () => {
  test.each(shapes.map((shape) => [shape.id, shape] as const))(
    "%s is what the resolver returns",
    (_id, shape) => {
      expect(
        resolveNativeAgentExecutionPolicy(shape.environment, shape.origin, shape.override),
      ).toEqual(shape.policy);
    },
  );

  test.each(shapes.map((shape) => [shape.id, shape] as const))(
    "%s claims only the container boundary the environment has",
    (_id, shape) => {
      const effects = nativeAgentPolicyEffects(shape.policy);
      const containerized = shape.environment.environmentType === "containerized";
      expect(effects.isolation === "container").toBe(
        containerized && shape.policy.sandbox !== "provider",
      );
      // The firewall follows the environment's setting (`commands-containers.ts`).
      if (effects.networkHeldBy === "container") {
        expect(shape.environment.networkAccessMode).toBe("restricted");
      }
      if (containerized && shape.environment.networkAccessMode === "restricted") {
        expect(effects.network).toBe("restricted");
      }
    },
  );

  test.each(
    shapes.flatMap((shape) =>
      (["claude", "codex"] as const).map((agent) => [shape.id, agent, shape] as const),
    ),
  )("%s: a %s build prompt carries the controls the bridge runner assumes", (_id, agent, shape) => {
    const connection: BridgeConnection = { agent, baseUrl: "http://127.0.0.1:1", authToken: "t" };
    const approvalMode = resolveNativeAgentApprovalMode(agent, shape.policy, undefined);
    const body = bridgePromptBody(
      agent,
      connection,
      "prompt",
      { requestId: "conformance", mode: "build", ...(approvalMode ? { approvalMode } : {}) },
      [],
    );
    const controls = conformancePromptControls(agent, shape.policy);
    expect({
      ...(body.permissionMode !== undefined ? { permissionMode: body.permissionMode } : {}),
      ...(body.approvalMode !== undefined ? { approvalMode: body.approvalMode } : {}),
    }).toEqual(controls);
  });
});

type OpenCodeRule = { permission: string; pattern: string; action: "allow" | "ask" | "deny" };

/** OpenCode applies the last rule whose permission matches (`*` matches all). */
function ruleAction(rules: readonly OpenCodeRule[], permission: string) {
  return rules.findLast((rule) => rule.permission === permission || rule.permission === "*")
    ?.action;
}

/** What OpenCode does with the rules it was created with. */
function observeOpenCode(
  rules: readonly OpenCodeRule[],
  projectResources: boolean,
): AdapterEffects {
  const shell = ruleAction(rules, "bash");
  return {
    // OpenCode has no sandbox; its rules are the only boundary.
    providerSandbox: false,
    approvals: shell === "allow" ? "auto-approve" : shell === "ask" ? "ask" : "deny",
    // Observed independently from the pinned CLI loading a fixture in that directory.
    projectResources,
    restrictsNetwork: shell === "deny" && ruleAction(rules, "webfetch") === "deny",
  };
}

const opencode = policyQualificationCli("opencode");

runExecutionPolicyConformance(
  {
    platform: "opencode",
    async apply(shape) {
      return withPolicyCliFixture(async (fixture) => {
        await writeFile(
          join(fixture.cwd, "opencode.json"),
          JSON.stringify({ instructions: ["POLICY_PROBE.md"] }),
        );
        const created: Array<Record<string, unknown>> = [];
        const client = {
          session: {
            create: async (body: Record<string, unknown>) => {
              created.push(body);
              return { data: { id: `session-${shape.id}` } };
            },
          },
        } as unknown as OpencodeClient;
        const permissions = new OpenCodeReviewSessionPermissions(
          client,
          fixture.cwd,
          () => ({ signal: new AbortController().signal }),
          () => undefined,
        );
        const { policy } = await permissions.createSession("conformance", { policy: shape.policy });
        expect(created).toHaveLength(1);
        expect(await policyCliOutput(opencode!, ["--version"], fixture)).toContain(
          PINNED_TOOLCHAIN_VERSIONS.opencode,
        );
        const config = JSON.parse(await policyCliOutput(opencode!, ["debug", "config"], fixture));
        const projectResources = config.instructions?.includes("POLICY_PROBE.md") === true;
        expect(projectResources).toBe(true);
        return {
          // The provider reports this policy in its session snapshots.
          reported: policy!,
          observed: observeOpenCode(created[0]!.permission as OpenCodeRule[], projectResources),
        };
      });
    },
  },
  {
    timeoutMs: 20_000,
    skipReason: opencode ? undefined : "install the pinned OpenCode CLI for offline qualification",
  },
);
