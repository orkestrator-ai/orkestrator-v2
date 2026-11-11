/**
 * The shared execution-policy conformance suite (`tests/conformance/execution-policy`)
 * from the backend's side.
 *
 * Three things only the backend can check: that each shape is what the
 * resolver really returns, that the axes a container owns (its boundary and
 * its firewall) match the environment, and that a build prompt carries the
 * approval controls the bridge runners assume. It also runs the suite for
 * OpenCode, whose adapter lives here: a session's base permission rules are
 * the ones `opencode2/permissions.ts` builds for its execution policy.
 */
import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  policyQualificationCli,
  policyCliOutput,
  withPolicyCliFixture,
} from "../../../../tests/conformance/execution-policy/vendor-cli.js";
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
import { bridgePromptBody } from "./http-bridge/prompt-body.js";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";
import { openCode2PolicyRules } from "./opencode2/permissions.js";
import { effectiveOpenCodePolicy } from "./opencode2/policy-rules.js";
import type { OpenCode2PermissionRule } from "./opencode2/types.js";

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

/** OpenCode applies the last rule whose action matches (`*` matches all). */
function ruleEffect(rules: readonly OpenCode2PermissionRule[], action: string) {
  return rules.findLast((rule) => rule.action === action || rule.action === "*")?.effect;
}

/** What OpenCode does with the rules a session was created with. */
function observeOpenCode(
  rules: readonly OpenCode2PermissionRule[],
  projectResources: boolean,
): AdapterEffects {
  const shell = ruleEffect(rules, "shell");
  return {
    // OpenCode has no sandbox; its rules are the only boundary.
    providerSandbox: false,
    approvals: shell === "allow" ? "auto-approve" : shell === "ask" ? "ask" : "deny",
    // Observed independently from the pinned CLI loading a fixture in that directory.
    projectResources,
    restrictsNetwork: shell === "deny" && ruleEffect(rules, "webfetch") === "deny",
  };
}

const opencode = policyQualificationCli("opencode2");

async function writeOpenCodeProbe(cwd: string): Promise<void> {
  await writeFile(
    join(cwd, "opencode.json"),
    JSON.stringify({ instructions: ["POLICY_PROBE.md"] }),
  );
}

/**
 * Whether the pinned CLI loads project resources from a directory holding the
 * probe. Every shape writes the same probe, and the CLI's view of it does not
 * depend on the shape, so the CLI runs once per file rather than per shape.
 */
let openCodeProjectResources: Promise<boolean> | undefined;
function observeOpenCodeProjectResources(): Promise<boolean> {
  openCodeProjectResources ??= withPolicyCliFixture(async (fixture) => {
    await writeOpenCodeProbe(fixture.cwd);
    expect(await policyCliOutput(opencode!, ["--version"], fixture)).toContain(
      PINNED_TOOLCHAIN_VERSIONS.opencode2,
    );
    // 2.x lists each configuration source it loaded, a document with its contents.
    // `--standalone` answers from a private server. Without it the CLI joins or
    // starts the per-user background service on its fixed port: on a host
    // already running OpenCode's service that port is taken and the probe hangs
    // past the spawn timeout (exit 143), and elsewhere it leaves a daemon
    // running after the test.
    const sources = JSON.parse(
      await policyCliOutput(opencode!, ["debug", "config", "--standalone"], fixture),
    ) as {
      info?: { instructions?: unknown };
    }[];
    return sources.some(
      (source) =>
        Array.isArray(source.info?.instructions) &&
        source.info.instructions.includes("POLICY_PROBE.md"),
    );
  });
  // A failed probe is not remembered, so one failure is reported once rather
  // than by every later shape in under a millisecond.
  openCodeProjectResources.catch(() => {
    openCodeProjectResources = undefined;
  });
  return openCodeProjectResources;
}

runExecutionPolicyConformance(
  {
    platform: "opencode",
    async apply(shape) {
      return withPolicyCliFixture(async (fixture) => {
        await writeOpenCodeProbe(fixture.cwd);
        const projectResources = await observeOpenCodeProjectResources();
        expect(projectResources).toBe(true);
        return {
          // What OpenCode can honour of the policy, notes included.
          reported: effectiveOpenCodePolicy(shape.policy),
          observed: observeOpenCode(openCode2PolicyRules(shape.policy), projectResources),
        };
      });
    },
  },
  {
    timeoutMs: 20_000,
    skipReason: opencode ? undefined : "install the pinned OpenCode CLI for offline qualification",
  },
);
