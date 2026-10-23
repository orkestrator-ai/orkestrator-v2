/**
 * The shared execution-policy conformance suite (`tests/conformance/execution-policy`)
 * over the Pi bridge.
 *
 * Pi has no sandbox and no network option; what it receives is its resource
 * loader's discovered extension registrations (`createPiSessionServices`,
 * the same SDK construction used on attach) and its approval gate, the
 * `tool_call` hook every tool call goes through. The gate is observed by
 * handing it a shell command and seeing whether it parks, refuses or allows
 * it. The reported policy is `publicSession`'s, which Agent Info renders.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { SettingsManager } from "./pi-sdk.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runExecutionPolicyConformance,
  type AdapterEffects,
} from "../../../tests/conformance/execution-policy/suite.js";

const ENV_KEYS = [
  "PI_BRIDGE_LIBRARY_ONLY",
  "PI_BRIDGE_STATE_DIR",
  "ORKESTRATOR_BRIDGE_EXECUTION_POLICY",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const stateDir = mkdtempSync(join(tmpdir(), "pi-policy-conformance-"));
const project = join(stateDir, "project");
const agentDir = join(stateDir, "agent");
mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
mkdirSync(agentDir);
writeFileSync(
  join(project, ".pi", "extensions", "policy-probe.ts"),
  `export default function(pi) {
  pi.registerCommand("project-policy-probe", { description: "Conformance fixture", handler: async () => {} });
}`,
);
for (const key of ENV_KEYS) delete process.env[key];
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
process.env.PI_BRIDGE_STATE_DIR = stateDir;

// `config.ts` reads its environment once, at import.
const { createSession, createPiSessionServices } = await import("./agent-session.js");
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
      // Load a repository extension through the same SDK construction used on attach.
      const services = await createPiSessionServices(state, {
        cwd: project,
        agentDir,
        settingsManager: SettingsManager.inMemory(),
      });
      const extensions = services.resourceLoader.getExtensions();
      if (extensions.errors.length) throw new Error("Conformance extension failed to load");
      const projectResources = extensions.extensions.some((extension) =>
        extension.commands.has("project-policy-probe"),
      );
      return {
        reported: publicSession(state).policy as never,
        observed: {
          // No option exists for one.
          providerSandbox: false,
          approvals,
          projectResources,
          // Nothing but the gate stands between a command and the network.
          restrictsNetwork: approvals === "deny",
        },
      };
    } finally {
      sessions.delete(state.id);
    }
  },
});
