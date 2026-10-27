/**
 * Agent Info's policy summary against the options each adapter actually sends.
 *
 * For every platform and every shape in `shapes.ts`, the platform's runner
 * sends the policy through its real option builders, captures what reaches the
 * SDK or CLI, and decodes that into an `AdapterObservation`. The suite
 * derives the same axes from the policy the adapter reports (the one Agent
 * Info renders, through `nativeAgentPolicyEffects`) and requires the two to
 * match. Nothing compares strings: both sides are the shared effects model.
 *
 * The only tolerated difference is a narrowing declared in `narrowings.ts`,
 * which must be stricter than the summary on every axis it names and must
 * still be observed, so a fixed gap cannot linger as a stale entry.
 *
 * Runners: `bridges/<name>/src/conformance-execution-policy.test.ts` for the
 * five bridges, and `apps/backend/src/core/conformance-execution-policy.test.ts`
 * for OpenCode (which runs in the backend) and the resolver itself.
 */
import { describe, expect, test } from "bun:test";
import {
  isNativeAgentExecutionPolicy,
  nativeAgentPolicyEffects,
  resolveNativeAgentApprovalMode,
  SANDBOXED_FOR_NETWORK_RESTRICTION_NOTE,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";
import { EXECUTION_POLICY_NARROWINGS, type Narrowing } from "./narrowings.js";
import { POLICY_SHAPES, type PolicyPlatform, type PolicyShape } from "./shapes.js";

export { POLICY_PLATFORMS, POLICY_SHAPES } from "./shapes.js";
export type { PolicyPlatform, PolicyShape, PolicyShapeId } from "./shapes.js";

/** The axes an adapter controls, decoded from what it hands its SDK or CLI. */
export interface AdapterEffects {
  /** The vendor sandbox holds the agent's commands, with no unattended way out. */
  providerSandbox: boolean;
  /** What becomes of an action the session has not already allowed. */
  approvals: "ask" | "auto-approve" | "deny";
  /** Repository-owned settings, hooks, MCP servers, extensions or skills load. */
  projectResources: boolean;
  /** The adapter itself keeps the agent's commands off the network. */
  restrictsNetwork: boolean;
}

/** An adapter that refuses to start a session it cannot run is failing closed. */
export type AdapterObservation = AdapterEffects | { refused: string };

export interface ExecutionPolicyApplication {
  /** The policy the adapter reports for the session: what Agent Info renders. */
  reported: NativeAgentExecutionPolicy;
  observed: AdapterObservation;
}

export interface ExecutionPolicyAdapter {
  platform: PolicyPlatform;
  /** Send `shape.policy` through the adapter's real option builders. */
  apply(shape: PolicyShape): Promise<ExecutionPolicyApplication>;
}

/**
 * The approval controls the backend puts on a build prompt when nobody picked
 * a mode, mirroring `bridgePromptBody`; the backend runner holds the two equal.
 */
export function conformancePromptControls(
  platform: PolicyPlatform,
  policy: NativeAgentExecutionPolicy,
): { approvalMode?: string; permissionMode?: string } {
  const approvalMode = resolveNativeAgentApprovalMode(platform, policy, undefined);
  if (platform === "claude") {
    return {
      permissionMode: approvalMode ?? "bypassPermissions",
      ...(approvalMode ? { approvalMode } : {}),
    };
  }
  return approvalMode ? { approvalMode } : {};
}

/** What the adapter must do for the summary of `reported` to be true. */
export function expectedAdapterEffects(reported: NativeAgentExecutionPolicy): AdapterEffects {
  const effects = nativeAgentPolicyEffects(reported);
  return {
    providerSandbox: effects.isolation === "provider-sandbox",
    approvals: effects.approvals,
    projectResources: effects.projectResources,
    // A container's firewall is the environment's, not the adapter's.
    restrictsNetwork: effects.network === "restricted" && effects.networkHeldBy !== "container",
  };
}

const APPROVAL_STRICTNESS = { "auto-approve": 0, ask: 1, deny: 2 } as const;

/** Every axis a narrowing names must be stricter than what the summary says. */
export function narrowingIsStricter(expected: AdapterEffects, narrowing: Narrowing): boolean {
  const observed = narrowing.observed;
  if (observed === "refused") return true;
  const axes = Object.entries(observed);
  return (
    axes.length > 0 &&
    axes.every(([axis, value]) => {
      const key = axis as keyof AdapterEffects;
      if (key === "approvals") {
        return (
          APPROVAL_STRICTNESS[value as AdapterEffects["approvals"]] >
          APPROVAL_STRICTNESS[expected.approvals]
        );
      }
      if (key === "projectResources") return value === false && expected.projectResources;
      return value === true && expected[key] === false;
    })
  );
}

export function runExecutionPolicyConformance(
  adapter: ExecutionPolicyAdapter,
  options: { timeoutMs?: number; skipReason?: string } = {},
): void {
  const narrowings = EXECUTION_POLICY_NARROWINGS[adapter.platform];
  describe(`execution policy conformance: ${adapter.platform}`, () => {
    for (const shape of POLICY_SHAPES as readonly PolicyShape[]) {
      (options.skipReason ? test.skip : test)(
        `${shape.id}: ${shape.title}${options.skipReason ? ` (${options.skipReason})` : ""}`,
        async () => {
          const { reported, observed } = await adapter.apply(shape);
          expect(isNativeAgentExecutionPolicy(reported)).toBe(true);
          const expected = expectedAdapterEffects(reported);
          if (!expected.providerSandbox) {
            expect(reported.note ?? "").not.toContain(SANDBOXED_FOR_NETWORK_RESTRICTION_NOTE);
          }
          if (shape.policy.containerNetworkAccess && !expected.providerSandbox) {
            expect(reported.sandbox).toBe("container");
            if (shape.environment.networkAccessMode === "restricted") {
              expect(reported.networkAccess).toBe("restricted");
              expect(nativeAgentPolicyEffects(reported).networkHeldBy).toBe("container");
            } else if (reported.networkAccess === "restricted") {
              expect(nativeAgentPolicyEffects(reported).networkHeldBy).toBe("toolset");
            }
          }
          const narrowing = narrowings[shape.id as keyof typeof narrowings] as
            Narrowing | undefined;
          if (!narrowing) {
            expect(observed).toEqual(expected);
            return;
          }
          expect(narrowing.reason.trim().length).toBeGreaterThan(20);
          expect(narrowingIsStricter(expected, narrowing)).toBe(true);
          expect(observed).toEqual(
            narrowing.observed === "refused"
              ? { refused: expect.any(String) }
              : { ...expected, ...narrowing.observed },
          );
        },
        options.timeoutMs,
      );
    }
  });
}
