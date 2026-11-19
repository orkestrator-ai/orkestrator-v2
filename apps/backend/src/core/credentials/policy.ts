import { CredentialError, type CredentialUse } from "@orkestrator/protocol/agent-credentials";
import { nativeAgentDeniedCapabilities } from "@orkestrator/protocol/native-agent";
import type { CredentialRuntimeInfo, CredentialSessionInfo } from "./context.js";

export function assertCredentialPolicy(
  use: CredentialUse,
  session: CredentialSessionInfo | null,
  runtime: CredentialRuntimeInfo,
  exactCommand?: string,
): void {
  const policy = session?.policy ?? undefined;
  const denied = nativeAgentDeniedCapabilities(policy);
  const readOnly = runtime.runtime.kind === "coordinator" || policy?.id === "coordinator-read-only";
  if (use === "command") {
    if (
      readOnly ||
      policy?.sandbox === "provider" ||
      (policy?.sandbox === "container" && runtime.runtime.kind !== "container")
    ) {
      throw new CredentialError(
        "UNSUPPORTED_RUNTIME",
        "The credential runner cannot run commands in this session's sandbox.",
      );
    }
    const shellDenied =
      denied.includes("shell") ||
      denied.includes("shell.mutate") ||
      policy?.toolPolicy?.deny?.some((tool) => /^(shell|bash)(?:\(|$)/iu.test(tool.trim()));
    if (policy?.approvals === "deny" || shellDenied) {
      throw new CredentialError(
        "POLICY_DENIED",
        "This session's execution policy does not allow running commands.",
      );
    }
    if (policy?.approvals === "ask" && !exactCommand) {
      throw new CredentialError(
        "POLICY_DENIED",
        "This session asks before running commands, so an exact command must be approved.",
      );
    }
  }
  if (
    readOnly ||
    denied.includes("network") ||
    (use === "command" &&
      runtime.networkAccess === "full" &&
      policy?.networkAccess === "restricted") ||
    ((use === "http" || runtime.runtime.kind !== "container") &&
      (policy?.networkAccess === "restricted" ||
        runtime.networkAccess === "restricted" ||
        policy?.containerNetworkAccess === "restricted"))
  ) {
    throw new CredentialError(
      "POLICY_DENIED",
      "This operation cannot enforce the session's network restrictions.",
    );
  }
}
