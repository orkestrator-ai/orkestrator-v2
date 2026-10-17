/**
 * Where an adapter is deliberately stricter than the Agent Info summary.
 *
 * Every other combination of platform and shape must match the summary
 * exactly. An entry here names only the axes that differ, each of which the
 * suite checks is stricter than the summary claims (never looser), and the
 * suite fails once the adapter stops doing it, so an entry cannot outlive its
 * reason. A looser adapter is a bug to fix, never an entry.
 */
import type { AdapterEffects } from "./suite.js";
import type { PolicyPlatform, PolicyShapeId } from "./shapes.js";

export interface Narrowing {
  observed: Partial<AdapterEffects> | "refused";
  reason: string;
}

const DENY_REFUSES_EVERY_COMMAND: Narrowing = {
  observed: { restrictsNetwork: true },
  reason:
    "`deny` refuses every command and fetch this adapter would otherwise ask about, so nothing the agent runs reaches the network even though the policy grants full access.",
};

export const EXECUTION_POLICY_NARROWINGS: Record<
  PolicyPlatform,
  Partial<Record<PolicyShapeId, Narrowing>>
> = {
  claude: {},
  codex: {
    "host-ask": {
      observed: { providerSandbox: true },
      reason:
        "Codex `on-request` (the default mode under `ask`) only asks when a command leaves its sandbox, so on an unsandboxed host it narrows full access to `workspace-write` (`codexApprovalConfig`).",
    },
    "host-deny": {
      observed: { providerSandbox: true },
      reason:
        "Codex has no mode that refuses escalation without a sandbox to escalate from, so `deny` runs `read-only` with `approvalPolicy: never`.",
    },
  },
  cursor: {
    "host-deny": {
      observed: "refused",
      reason:
        "The Cursor SDK has no approval callback, so a non-coordinator `deny` session is refused before attach rather than run unenforced.",
    },
    "container-full-provider": {
      observed: { restrictsNetwork: true },
      reason:
        "Cursor always applies its sandbox network rules when its provider sandbox is on, including inside a full-network container.",
    },
    "host-provider-sandbox": {
      observed: { restrictsNetwork: true },
      reason:
        "Cursor's only network control is its sandbox switch, so a sandboxed session gets the sandbox's network rules; the reported note says full access is not guaranteed.",
    },
  },
  opencode: { "host-deny": DENY_REFUSES_EVERY_COMMAND },
  grok: {},
  pi: { "host-deny": DENY_REFUSES_EVERY_COMMAND },
};
