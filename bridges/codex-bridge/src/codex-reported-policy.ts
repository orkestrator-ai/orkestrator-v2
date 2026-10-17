/**
 * The execution policy a Codex session reports, which Agent Info renders.
 *
 * Codex has no per-thread switch for repository configuration: a project it
 * trusts loads its own `.codex` configuration (MCP servers, hooks) whatever
 * the session's policy says. Only the coordinator pins its checkout untrusted
 * (`codexAppServerConfigOverrides`), so every other session reports the axis
 * as on and says why, rather than claiming a boundary nothing holds.
 */
import {
  appendNativeAgentPolicyNote,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";

export const CODEX_PROJECT_TRUST_NOTE =
  "Codex loads a trusted project's own configuration, including its MCP servers and hooks, whatever this session's policy says.";

export function codexReportedPolicy(
  policy: NativeAgentExecutionPolicy,
): NativeAgentExecutionPolicy {
  if (policy.projectResources || policy.id === "coordinator-read-only") return policy;
  return appendNativeAgentPolicyNote(
    { ...policy, projectResources: true },
    CODEX_PROJECT_TRUST_NOTE,
  );
}
