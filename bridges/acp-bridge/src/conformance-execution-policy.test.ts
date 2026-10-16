/**
 * The shared execution-policy conformance suite (`tests/conformance/execution-policy`)
 * over the ACP bridge running Grok.
 *
 * What Grok receives is its command line (`providerArgv` over Grok's built-in
 * configuration, from the turn's policy as `AcpProcess` builds it) and the bridge's answers to
 * its permission requests. The answers are observed by attaching a fake child
 * and handing the bridge's real `onPermission` handler a shell command. The
 * reported policy is `publicSession`'s, which Agent Info renders.
 */
import "./testing/unit-test-env.js";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";
import {
  runExecutionPolicyConformance,
  type AdapterEffects,
} from "../../../tests/conformance/execution-policy/suite.js";
import { sessions } from "./acp-context.js";
import { effectiveExecutionPolicy, effectiveTurnExecutionPolicy } from "./acp-policy.js";
import { loadAcpProviderConfig, providerArgv } from "./acp-provider-config.js";
import { publicSession } from "./acp-public.js";
import { attachChild, clearApprovals } from "./acp-session.js";

// The process-wide provider is the unit-test fixture; Grok's command line is
// built from its own built-in configuration, as its launcher's would be.
const grok = loadAcpProviderConfig({ ACP_PROVIDER: "grok", ACP_AGENT_PATH: "/opt/grok/bin/grok" });
type AcpSession = Parameters<typeof publicSession>[0];

/** Hand the bridge a shell command Grok asks permission for. */
function permissionAnswer(state: AcpSession) {
  const responses: unknown[] = [];
  const child = {
    respond: (_id: number, result: unknown) => responses.push(result),
  } as unknown as Parameters<typeof attachChild>[1];
  attachChild(state, child);
  child.onPermission(1, {
    sessionId: state.acpSessionId,
    toolCall: { toolCallId: "conformance", kind: "execute", title: "curl https://example.com" },
    options: [
      { optionId: "allow", kind: "allow_once", name: "Allow" },
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ],
  });
  if (state.approvals.size > 0) {
    clearApprovals(state);
    return "ask" as const;
  }
  const outcome = (responses[0] as { outcome: { outcome: string; optionId?: string } }).outcome;
  return outcome.outcome === "selected" && outcome.optionId === "allow"
    ? ("auto-approve" as const)
    : ("deny" as const);
}

runExecutionPolicyConformance({
  platform: "grok",
  async apply(shape) {
    const state = {
      id: `conformance-${shape.id}`,
      acpSessionId: "vendor-session",
      status: "running",
      // What the create route stores.
      policy: effectiveExecutionPolicy(shape.policy),
      messages: [],
      approvals: new Map(),
      interactions: new Map(),
      revision: 0,
      sessionConfig: { composer: {} },
      health: new RuntimeHealthRecorder(),
    } as unknown as AcpSession;
    sessions.set(state.id, state);
    try {
      const argv = providerArgv(grok, {
        approvals: effectiveTurnExecutionPolicy(state)?.approvals,
      });
      // With `--always-approve` Grok runs its tools without asking at all;
      // otherwise each request reaches the bridge, which answers it.
      const approvals: AdapterEffects["approvals"] = argv.includes("--always-approve")
        ? "auto-approve"
        : permissionAnswer(state);
      return {
        reported: publicSession(state).policy as never,
        observed: {
          // Grok is given no sandbox, network or project-configuration option:
          // it loads project MCP servers by its own folder trust.
          providerSandbox: false,
          approvals,
          projectResources: true,
          // A tool that does not ask is never stopped, so even `deny` holds
          // nothing off the network.
          restrictsNetwork: false,
        },
      };
    } finally {
      sessions.delete(state.id);
    }
  },
});
