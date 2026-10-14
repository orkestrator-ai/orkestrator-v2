/**
 * Backend-only per-platform policy for the shared native-agent service.
 *
 * The service asks this registry what a platform needs instead of branching on
 * its name, so platform-specific behaviour has one place to be switched on.
 * Renderer-visible capabilities stay in the protocol's capability table; this
 * holds only decisions the backend makes on a platform's behalf.
 */
import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
import type { IncompleteTurnRecoveryStrategy } from "./native-agent-turn-recovery.js";
import { openCodeIncompleteTurnRecoveryStrategy } from "./opencode-turn-recovery.js";

export interface NativeAgentPlatformPolicy {
  /**
   * Automatic continuation of a turn the runtime ended incomplete. Absent for
   * a platform whose turns never end in a recoverable incomplete shape.
   */
  incompleteTurnRecovery?: IncompleteTurnRecoveryStrategy;
  /**
   * Resolve the composer selection from the session's own evidence and keep
   * it durable.
   *
   * A runtime that reports no live composer selection (OpenCode) otherwise
   * shows the catalogue default for a session that ran on another model. When
   * set, the last assistant model and the runtime's stored session model rank
   * above the catalogue default, and that evidence — never the default — is
   * persisted as the session's inferred selection.
   */
  infersComposerSelection?: boolean;
}

const NO_POLICY: NativeAgentPlatformPolicy = Object.freeze({});

const POLICIES: Readonly<Record<BuildPipelineAgent, NativeAgentPlatformPolicy>> = Object.freeze({
  claude: NO_POLICY,
  codex: NO_POLICY,
  cursor: NO_POLICY,
  grok: NO_POLICY,
  opencode: Object.freeze({
    incompleteTurnRecovery: openCodeIncompleteTurnRecoveryStrategy,
    infersComposerSelection: true,
  }),
  pi: NO_POLICY,
});

export function nativeAgentPlatformPolicy(agent: BuildPipelineAgent): NativeAgentPlatformPolicy {
  return POLICIES[agent] ?? NO_POLICY;
}
