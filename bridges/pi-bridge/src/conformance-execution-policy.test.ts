/**
 * The shared execution-policy conformance suite (`tests/conformance/execution-policy`)
 * over the Pi bridge.
 *
 * Pi has no sandbox and no network option; what it receives is its resource
 * loader's discovery options and project trust (`piResourceLoaderPolicy`,
 * which `createPiAgentSession` passes to the SDK) and its approval gate, the
 * `tool_call` hook every tool call goes through. The gate is observed by
 * handing it a shell command and seeing whether it parks, refuses or allows
 * it. The reported policy is `publicSession`'s, which Agent Info renders.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runExecutionPolicyConformance,
  type AdapterEffects,
} from "../../../tests/conformance/execution-policy/suite.js";

const ENV_KEYS = [
  "PI_BRIDGE_LIBRARY_ONLY",
  "PI_BRIDGE_STATE_DIR",
  "PI_BRIDGE_REQUIRE_APPROVAL",
  "PI_BRIDGE_PROJECT_RESOURCES",
  "ORKESTRATOR_BRIDGE_EXECUTION_POLICY",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const stateDir = mkdtempSync(join(tmpdir(), "pi-policy-conformance-"));
for (const key of ENV_KEYS) delete process.env[key];
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
process.env.PI_BRIDGE_STATE_DIR = stateDir;

// `config.ts` reads its environment once, at import.
const { createSession, piResourceLoaderPolicy } = await import("./agent-session.js");
const { requestToolApproval, resolveApproval } = await import("./interactions.js");
const { publicSession } = await import("./public.js");
const { clientSessionKeys, sessions } = await import("./state.js");

afterAll(() => {
  sessions.clear();
  clientSessionKeys.clear();
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(stateDir, { recursive: true, force: true });
});

type PiSession = Awaited<ReturnType<typeof createSession>>;

/** Hand the gate a shell command; parking is synchronous, so no waiting. */
async function gateDecision(state: PiSession): Promise<AdapterEffects["approvals"]> {
  const decision = requestToolApproval(state, "conformance", "bash", {
    command: "curl https://example.com",
  });
  const [parked] = state.approvals.keys();
  if (parked) {
    resolveApproval(state, parked, "deny");
    await decision;
    return "ask";
  }
  return (await decision).block ? "deny" : "auto-approve";
}

runExecutionPolicyConformance({
  platform: "pi",
  async apply(shape) {
    const state = await createSession(undefined, undefined, shape.policy);
    try {
      const approvals = await gateDecision(state);
      const loader = piResourceLoaderPolicy(state);
      return {
        reported: publicSession(state).policy as never,
        observed: {
          // No option exists for one.
          providerSandbox: false,
          approvals,
          projectResources: !loader.discovery.noExtensions && loader.projectTrusted,
          // Nothing but the gate stands between a command and the network.
          restrictsNetwork: approvals === "deny",
        },
      };
    } finally {
      sessions.delete(state.id);
    }
  },
});
