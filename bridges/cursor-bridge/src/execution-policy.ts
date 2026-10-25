/**
 * The execution policy a Cursor session runs under, as the SDK is handed it
 * and as the status routes report it. Kept apart from `agent-session.ts` so
 * the public projections can describe a session without loading the SDK path.
 */
import {
  coordinatorCapabilityPolicy,
  coordinatorWebResearchFromEnv,
} from "@orkestrator/protocol/coordinator-web-research";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import type { SessionState } from "./state.js";

export function resolveCursorExecutionPolicy(
  policy?: NativeAgentExecutionPolicy,
): NativeAgentExecutionPolicy {
  const resolved: NativeAgentExecutionPolicy =
    policy ??
    ({
      id: "interactive-host",
      sandbox: "provider",
      approvals: "ask",
      projectResources: false,
      networkAccess: "full",
    } as const);
  // Process authority first, so a request body cannot widen what a
  // coordinator bridge runs under.
  if (process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY === "coordinator-read-only") {
    return {
      id: "coordinator-read-only",
      // Keep the outer boundary when the bridge itself runs in a container.
      // Cursor's nested provider sandbox cannot start there, and the closed
      // read-only allowlist still protects the bind-mounted checkout.
      sandbox: policy?.sandbox === "container" ? "container" : "provider",
      approvals: "deny",
      projectResources: false,
      // Follows the launcher's research setting: hosted search may be allowed,
      // never fetch. Research MCP servers are hosted in-process at attach.
      capabilityPolicy: coordinatorCapabilityPolicy(coordinatorWebResearchFromEnv(process.env)),
      networkAccess: "restricted",
      note: "Cursor applies these restrictions, but its SDK exposes no approval callback to verify them.",
    };
  }
  const notes = resolved.note ? [resolved.note] : [];
  // Its public network control is the provider sandbox switch rather than an
  // independent network policy. Restricted requests therefore force that
  // sandbox on instead of claiming a restriction with an unsandboxed agent.
  const sandbox =
    resolved.networkAccess === "restricted" && resolved.sandbox === "none"
      ? "provider"
      : resolved.sandbox;
  // Cursor's public SDK has no callback surface for interactive approvals.
  // Report ask as the auto-approved mode it actually runs, while deny keeps
  // autoReview disabled so any operation requiring escalation fails closed.
  // Auto-review exists only inside the provider sandbox (`attach`).
  const approvals = resolved.approvals === "ask" ? "auto-approve" : resolved.approvals;
  if (resolved.approvals === "ask") {
    notes.push(
      sandbox === "provider"
        ? "Cursor SDK cannot surface interactive approvals; provider auto-review is used."
        : "Cursor SDK cannot surface interactive approvals, so this session runs without asking.",
    );
  }
  if (resolved.networkAccess === "restricted" && sandbox === "provider") {
    notes.push("Cursor enforces restricted network access through its provider sandbox.");
  } else if (resolved.networkAccess === "restricted" && sandbox === "container") {
    notes.push("Restricted network access is enforced by the outer container boundary.");
  } else if (sandbox === "provider") {
    notes.push("Cursor SDK cannot independently guarantee full network inside its sandbox.");
  }
  return {
    ...resolved,
    sandbox,
    approvals,
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  };
}

/**
 * The policy a session's agent is built under: the read-only coordinator
 * policy while `readOnly` is set, the session's own otherwise. Shared by
 * `attach` and the status routes, so Agent Info describes what runs.
 */
export function cursorAppliedPolicy(
  state: Pick<SessionState, "policy" | "readOnly">,
): NativeAgentExecutionPolicy {
  const sessionPolicy = state.policy;
  return resolveCursorExecutionPolicy(
    state.readOnly
      ? {
          id: "coordinator-read-only",
          // A container is already the process boundary. Reusing it avoids a
          // nested Cursor sandbox that Docker cannot start; the SDK allowlist
          // in `attach` independently protects its bind-mounted worktree.
          sandbox: sessionPolicy?.sandbox === "container" ? "container" : "provider",
          approvals: "deny",
          projectResources: false,
          capabilityPolicy: { deny: ["file.write", "file.patch", "shell.mutate", "network"] },
          networkAccess: "restricted",
        }
      : state.policy,
  );
}
