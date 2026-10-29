/**
 * Invariant 7 against the backend's real environment policies: a graph
 * capability profile, with any node overrides and any project ceiling, never
 * widens the policy `resolveNativeAgentExecutionPolicy` gives a host, a
 * container or a coordinator, and neither does the wire form a bridge receives.
 */
import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { COORDINATOR_WEB_RESEARCH_MODES } from "@orkestrator/protocol/coordinator-web-research";
import {
  compileGraphCapabilities,
  type GraphCapabilityCeiling,
} from "@orkestrator/protocol/graphs/capability-profiles";
import {
  GRAPH_CAPABILITY_PROFILES,
  type GraphCapabilityName,
  type GraphCapabilitySpec,
} from "@orkestrator/protocol/graphs/template";
import {
  NATIVE_AGENT_CAPABILITIES,
  NATIVE_AGENT_ORKESTRATOR_CAPABILITY_GROUPS,
  nativeAgentDeniedCapabilities,
  nativeAgentPolicyForBridge,
  type NativeAgentExecutionPolicy,
  type NativeAgentExecutionPolicyOverride,
} from "@orkestrator/protocol/native-agent";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";

const VOCABULARY: GraphCapabilityName[] = [
  ...NATIVE_AGENT_CAPABILITIES,
  "mcp:docs",
  "mcp:context7",
  ...NATIVE_AGENT_ORKESTRATOR_CAPABILITY_GROUPS.map((group) => `orkestrator:${group}` as const),
];

/** Whether a capability is usable under a policy or ceiling. */
function available(
  layer: Pick<NativeAgentExecutionPolicy, "capabilityPolicy"> | undefined,
  capability: string,
): boolean {
  const denied = new Set<string>(nativeAgentDeniedCapabilities(layer));
  if (capability === "web.search") {
    return (
      !denied.has("web.search") &&
      (!denied.has("network") || layer?.capabilityPolicy?.allow?.includes("web.search") === true)
    );
  }
  return !denied.has(capability);
}

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(next: () => number, values: readonly T[]): T {
  return values[Math.floor(next() * values.length)]!;
}

function subset<T>(next: () => number, values: readonly T[], probability: number): T[] {
  return values.filter(() => next() < probability);
}

function environments(next: () => number): NativeAgentExecutionPolicy[] {
  const overrides: (NativeAgentExecutionPolicyOverride | undefined)[] = [
    undefined,
    { sandbox: "provider", networkAccess: "restricted" },
    { approvals: "ask", projectResources: true },
    { toolPolicy: { deny: ["Write"], allow: ["Read"] } },
    { sandbox: pick(next, ["provider", "container", "none"] as const) },
  ];
  const policies: NativeAgentExecutionPolicy[] = [];
  for (const environmentType of ["local", "containerized"] as const) {
    for (const networkAccessMode of ["full", "restricted"] as const) {
      for (const origin of ["build-pipeline", "automated-review", "interactive-native"] as const) {
        policies.push(
          resolveNativeAgentExecutionPolicy(
            { environmentType, networkAccessMode },
            origin,
            pick(next, overrides),
          ),
        );
      }
    }
  }
  for (const research of COORDINATOR_WEB_RESEARCH_MODES) {
    policies.push(
      resolveNativeAgentExecutionPolicy(
        { environmentType: "local", networkAccessMode: "restricted" },
        "coordinator",
        undefined,
        research,
      ),
    );
  }
  return policies;
}

function spec(next: () => number): GraphCapabilitySpec {
  const allow = subset(next, VOCABULARY, 0.2);
  const deny = subset(
    next,
    VOCABULARY.filter((capability) => !allow.includes(capability)),
    0.15,
  );
  return {
    profile: pick(next, GRAPH_CAPABILITY_PROFILES),
    ...(allow.length > 0 ? { allow } : {}),
    ...(deny.length > 0 ? { deny } : {}),
  };
}

function ceiling(next: () => number): GraphCapabilityCeiling {
  const deny = subset(
    next,
    VOCABULARY.filter((capability) => capability !== "git.push" && capability !== "github.write"),
    0.1,
  );
  return { deny, ...(next() < 0.5 ? { allow: ["web.search"] } : {}) };
}

describe("graph capability profiles over real environment policies", () => {
  test("a profile never widens the environment's policy or the project's ceiling", () => {
    const next = random(0x106);
    let cases = 0;
    for (let round = 0; round < 60; round += 1) {
      for (const environment of environments(next)) {
        const nodeSpec = spec(next);
        const projectCeiling = ceiling(next);
        const compiled = compileGraphCapabilities({
          spec: nodeSpec,
          environment,
          ceiling: projectCeiling,
        });
        const context = JSON.stringify({ environment, nodeSpec, projectCeiling });
        const { capabilityPolicy: _compiledCapabilities, ...compiledRest } = compiled.policy;
        const { capabilityPolicy: _environmentCapabilities, ...environmentRest } = environment;
        // Sandbox, approvals, project resources, network, tool policy and id
        // are the environment's own.
        expect(compiledRest, context).toEqual(environmentRest);
        for (const capability of VOCABULARY) {
          if (!available(compiled.policy, capability)) continue;
          expect(available(environment, capability), `${capability} ${context}`).toBe(true);
          expect(available({ capabilityPolicy: projectCeiling }, capability), context).toBe(true);
        }
        for (const group of compiled.orkestratorGroups) {
          expect(available(environment, `orkestrator:${group}`), context).toBe(true);
          expect(projectCeiling.deny).not.toContain(`orkestrator:${group}`);
        }
        // D12, whatever the node asked for.
        expect(available(compiled.policy, "git.push"), context).toBe(false);
        expect(available(compiled.policy, "github.write"), context).toBe(false);
        // What a bridge receives is no wider than the compiled policy either.
        for (const platform of AGENT_PLATFORMS) {
          const wire = nativeAgentPolicyForBridge(compiled.policy, platform);
          expect(!wire.projectResources || compiled.policy.projectResources).toBe(true);
          for (const capability of VOCABULARY) {
            if (capability.startsWith("orkestrator:")) continue;
            if (available(wire, capability)) {
              expect(available(compiled.policy, capability), `${platform} ${capability}`).toBe(
                true,
              );
            }
          }
        }
        cases += 1;
      }
    }
    expect(cases).toBeGreaterThan(500);
  });

  test("a read-only profile over a coordinator keeps the coordinator's whole boundary", () => {
    const coordinator = resolveNativeAgentExecutionPolicy(
      { environmentType: "local", networkAccessMode: "restricted" },
      "coordinator",
      undefined,
      "search",
    );
    for (const profile of GRAPH_CAPABILITY_PROFILES) {
      const compiled = compileGraphCapabilities({ spec: { profile }, environment: coordinator });
      expect(compiled.readOnly).toBe(true);
      expect(compiled.policy.id).toBe("coordinator-read-only");
      expect(compiled.policy.toolPolicy).toEqual(coordinator.toolPolicy);
      for (const capability of coordinator.capabilityPolicy!.deny) {
        expect(compiled.denied).toContain(capability);
      }
    }
  });
});
