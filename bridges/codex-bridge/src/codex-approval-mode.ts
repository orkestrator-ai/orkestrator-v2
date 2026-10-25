/**
 * The composer's Codex approval modes, translated into turn settings.
 *
 * Each id is an `approvalPolicy` value except `auto-review`, which is
 * `on-request` with approvals routed to Codex's reviewer agent instead of the
 * user. The session's execution policy stays the ceiling: a mode never widens
 * what the backend resolved for the session.
 */
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import type { EngineTurnConfig } from "./engine/types.js";

export const CODEX_APPROVAL_MODES = ["untrusted", "on-request", "auto-review", "never"] as const;
export type CodexApprovalMode = (typeof CODEX_APPROVAL_MODES)[number];

export function isCodexApprovalMode(value: unknown): value is CodexApprovalMode {
  return typeof value === "string" && (CODEX_APPROVAL_MODES as readonly string[]).includes(value);
}

/**
 * The approval settings a turn runs with under `mode`, or undefined to keep
 * what the policy alone set.
 *
 * `on-request` and `auto-review` only ever ask when the agent wants to leave
 * its sandbox, and an unsandboxed host session has nothing to leave, so they
 * narrow full access to `workspace-write`. A container keeps its own boundary:
 * the vendor sandbox is off there on purpose.
 */
export function codexApprovalConfig(
  policy: NativeAgentExecutionPolicy | undefined,
  sandbox: EngineTurnConfig["sandbox"],
  mode: CodexApprovalMode | undefined,
): Pick<EngineTurnConfig, "approvalPolicy" | "approvalsReviewer" | "sandbox"> | undefined {
  if (!mode || policy?.approvals === "deny") return undefined;
  if (policy?.approvals === "ask" && mode !== "untrusted" && mode !== "on-request") {
    return undefined;
  }
  const escalates = mode === "on-request" || mode === "auto-review";
  // A container keeps the vendor sandbox off, so `on-request` would have no
  // boundary to ask at and an `ask` policy would never ask. `untrusted` is
  // the Codex mode that asks without one. Under `auto-approve` the pick is
  // the user's own and runs as Codex defines it, which never asks here; the
  // composer says so (`nativeAgentApprovalModes`) rather than this turning
  // it into `untrusted`, which the picker already offers.
  const asksWithoutSandbox =
    mode === "on-request" &&
    policy?.approvals === "ask" &&
    policy.sandbox === "container" &&
    sandbox === "danger-full-access";
  return {
    approvalPolicy: mode === "auto-review" ? "on-request" : asksWithoutSandbox ? "untrusted" : mode,
    approvalsReviewer: mode === "auto-review" ? "auto_review" : "user",
    ...(escalates && sandbox === "danger-full-access" && policy?.sandbox !== "container"
      ? { sandbox: "workspace-write" as const }
      : {}),
  };
}
