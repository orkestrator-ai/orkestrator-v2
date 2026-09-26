import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import type {
  PublicCompletionSupport,
  PublicProviderCapabilities,
} from "@orkestrator/protocol/public-api";

/**
 * Request-specific completion support per provider.
 *
 * Every native provider shares one backend evidence path: the dispatch
 * journal records which request started a turn (`dispatchedRequestIds`), the
 * backend's own activity sweep observes the turn working and ending, and the
 * turn's outcome is persisted per request (`turnOutcomes`) from provider
 * status reads the backend already makes. `run.get` settles a run only on that
 * evidence (see `run-observer.ts`); a run whose end was never observed — for
 * example across a backend restart — stays `unknown` rather than being
 * inferred from an idle session.
 *
 * A provider is `qualified` when that path has been exercised end to end for
 * it — a live, bounded turn through the packaged CLI, real backend and real
 * bridge, settled on this evidence and checked by a file assertion — in
 * addition to the provider-neutral controlled-provider tests. Unqualified
 * providers keep every other action; their runs report `unsupported` rather
 * than a completion the backend has not proven for them. Qualification
 * evidence is recorded in
 * docs/improvements/cli-commands/plan/10-run-completion-and-waiting.md.
 * Withdraw one provider here (to `unqualified`) if its mapping fails; its run
 * evidence stays readable.
 */
export const PROVIDER_COMPLETION: Readonly<
  Record<AgentPlatform, { support: PublicCompletionSupport; note: string }>
> = Object.freeze({
  claude: {
    support: "qualified",
    note: "Live-qualified: request-correlated completion, provider-error failure, follow-up.",
  },
  codex: {
    support: "qualified",
    note: "Live-qualified; app-server cancelling/recovering report running, never idle.",
  },
  opencode: {
    support: "qualified",
    note: "Live-qualified with a connected model; session.status drives turn activity.",
  },
  pi: {
    support: "unqualified",
    note: "Not yet live-qualified through the public CLI; runs report unsupported instead of completion.",
  },
  cursor: {
    support: "unqualified",
    note: "Not yet live-qualified through the public CLI; runs report unsupported instead of completion.",
  },
  grok: {
    support: "unqualified",
    note: "Not yet live-qualified through the public CLI; runs report unsupported instead of completion.",
  },
});

export function providerCapabilities(agent: AgentPlatform): PublicProviderCapabilities {
  const native = nativeAgentCapabilities(agent);
  const completion = PROVIDER_COMPLETION[agent];
  return {
    completion: completion.support,
    completionNote: completion.note,
    steer: native.actions?.steer === true,
    stop: true,
    resume: native.resume,
    fork: native.fork,
    queue: native.queue,
    interactions: (native.interactions?.kinds.length ?? 0) > 0,
    controls: {
      model: native.composer.model,
      reasoning: native.composer.reasoning,
      speed: native.composer.speed,
      mode: native.composer.mode,
    },
  };
}

export function allProviderCapabilities(): Record<string, PublicProviderCapabilities> {
  return Object.fromEntries(AGENT_PLATFORMS.map((agent) => [agent, providerCapabilities(agent)]));
}
