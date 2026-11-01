/** Shared provider factory used by interactive native-agent sessions. */
import { isAgentAccountPlatform } from "@orkestrator/protocol/agent-accounts";
import {
  ProviderSessionFailedError,
  type BridgeConnection,
  type NativeAgentRuntimeProvider,
} from "./agent-provider-contract.js";
import { HttpBridgeProvider } from "./http-bridge-provider.js";
import type { HttpBridgeProviderDependencies } from "./http-bridge-transport.js";
import type { AppConfig } from "./models.js";
import type { OpenCodeCoordinatorResearch } from "./opencode-coordinator-research.js";
import type { NativeAgentReadiness } from "@orkestrator/protocol/native-agent";
import { OpenCodeProvider, type OpenCodeProviderDependencies } from "./opencode-provider.js";
import { openCodeEnvironmentDependencies } from "./opencode-provider-environment.js";
import { resolveCodexBridgeDefaultModel } from "./session-held-model.js";
import type { UsageLimitStops } from "./native-agent-usage-limit-resend.js";
import type { WorkflowResultReader } from "./workflow-result-service.js";

export * from "./agent-provider-contract.js";

/**
 * What the shared native-agent service knows about the environment a provider
 * serves, in platform-neutral terms. `createNativeAgentProvider` derives each
 * platform's environment-scoped dependencies from it, so the service never
 * assembles them itself.
 */
export interface NativeAgentProviderEnvironment {
  environmentId: string;
  /**
   * Backend data directory. Absent for storage doubles without one, which then
   * get no on-disk provider state rather than git runs in fixture directories.
   */
  dataDir?: string;
  /**
   * Reads the persisted configuration. Called per use rather than once:
   * providers are cached for the life of a bridge connection, so a settings
   * edit would otherwise not reach them until the environment restarted.
   */
  loadConfig?: () => Promise<Pick<AppConfig, "global">>;
  /**
   * What the tab should say when this agent's login lapses, in place of the
   * bridge's own sign-in message; undefined keeps it. Read only when a
   * snapshot reports a sign-in problem.
   */
  signInGuidance?: (agent: string) => Promise<string | undefined>;
  /**
   * The backend's OpenCode coordinator research registrations
   * (`runtime.localServers.openCodeAgentTools.research`). Absent without a
   * backend, which then grants a coordinator no research tools.
   */
  openCodeCoordinatorResearch?: Pick<
    OpenCodeCoordinatorResearch,
    "ensure" | "invalidate" | "toolIds"
  >;
}

/**
 * Replace the message of a confirmed sign-out (readiness
 * `authentication-required`) with the environment's guidance: a container's
 * imported login cannot be renewed inside it. The bridge's sign-in route is
 * kept. Turn-time auth notices are left as the bridge wrote them.
 */
async function withSignInGuidance<T extends { readiness?: NativeAgentReadiness }>(
  snapshot: T,
  guidance: () => Promise<string | undefined>,
): Promise<T> {
  const readiness = snapshot.readiness;
  if (readiness?.state !== "authentication-required") return snapshot;
  const message = await guidance().catch(() => undefined);
  return message ? { ...snapshot, readiness: { ...readiness, message } } : snapshot;
}

function applySignInGuidance(
  provider: NativeAgentRuntimeProvider,
  guidance: () => Promise<string | undefined>,
): void {
  const interactive = provider.interactiveSnapshot?.bind(provider);
  if (interactive) {
    provider.interactiveSnapshot = async (sessionId) =>
      withSignInGuidance(await interactive(sessionId), guidance);
  }
  const state = provider.sessionStateSnapshot?.bind(provider);
  if (state) {
    provider.sessionStateSnapshot = async (sessionId) =>
      withSignInGuidance(await state(sessionId), guidance);
  }
}

export type ProviderDependencies = HttpBridgeProviderDependencies &
  OpenCodeProviderDependencies & {
    workflowResults?: WorkflowResultReader;
    /** Stable bridge identity shared by all workflow owners, even after URL replacement. */
    bridgeEnvironmentId?: string;
    /** Resolve the bridge before a new workflow turn; local startup preserves busy bridges. */
    refreshConnection?: () => Promise<BridgeConnection>;
    /** Platform-specific dependencies are derived from this; explicit ones win. */
    environment?: NativeAgentProviderEnvironment;
    /** Automatic account switching, which turns a workflow's weekly-limit stop into a resend. */
    usageLimitStops?: Pick<UsageLimitStops, "handleLimitStop">;
  };

/** A workflow polls its turns every few seconds; one not looked at for this long is not counted. */
const RUNNING_TURN_SEEN_MS = 2 * 60_000;

/**
 * Which turns on this provider's bridge its workflow last saw running. Reviewers
 * of one harness share a provider and a bridge, and replacing that bridge to move
 * one of them onto a new account would kill the others. Native activity
 * observation does not see these turns, so they are read from the workflow's own
 * polls. A turn that stopped reads as not running on the poll that reports it, so
 * two stopped turns never wait on each other.
 */
export function trackRunningTurns(provider: NativeAgentRuntimeProvider): () => boolean {
  const seen = new Map<string, number>();
  const note = (sessionId: string, status: string) => {
    if (status === "running" || status === "blocked") seen.set(sessionId, Date.now());
    else seen.delete(sessionId);
  };
  // A bridge reports a failed turn by throwing rather than answering "error", and
  // that poll is the one that says the turn is over.
  const reading = async <T>(sessionId: string, read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      if (error instanceof ProviderSessionFailedError) seen.delete(sessionId);
      throw error;
    }
  };
  const send = provider.send?.bind(provider);
  provider.send = async (sessionId, ...args) => {
    note(sessionId, "running");
    return send?.(sessionId, ...args);
  };
  const status = provider.status.bind(provider);
  provider.status = async (sessionId) => {
    const current = await reading(sessionId, () => status(sessionId));
    note(sessionId, current);
    return current;
  };
  const observeSession = provider.observeSession?.bind(provider);
  if (observeSession) {
    provider.observeSession = async (sessionId) => {
      const observation = await reading(sessionId, () => observeSession(sessionId));
      note(sessionId, observation.status);
      return observation;
    };
  }
  return () => {
    const horizon = Date.now() - RUNNING_TURN_SEEN_MS;
    for (const [sessionId, at] of seen) {
      if (at >= horizon) return true;
      seen.delete(sessionId);
    }
    return false;
  };
}

const workflowBridges = new Map<
  string,
  {
    observers: Set<() => boolean>;
    connection: BridgeConnection;
    refreshing?: Promise<void>;
  }
>();

export function workflowBridgeRunning(environmentId: string, agent: string): boolean {
  return [...(workflowBridges.get(`${agent}:${environmentId}`)?.observers ?? [])].some((running) =>
    running(),
  );
}

export function createNativeAgentProvider(
  connection: BridgeConnection,
  dependencies: ProviderDependencies = {},
): NativeAgentRuntimeProvider {
  const provider: NativeAgentRuntimeProvider =
    connection.agent === "opencode"
      ? new OpenCodeProvider(connection, {
          ...openCodeEnvironmentDependencies(dependencies.environment),
          ...dependencies,
        })
      : new HttpBridgeProvider(
          connection,
          dependencies.fetch ?? fetch,
          dependencies.stageImages,
          dependencies.onObservationHint,
          dependencies.planUsage,
        );
  const platform = connection.agent;
  const tracksTurns =
    isAgentAccountPlatform(platform) &&
    (dependencies.usageLimitStops || dependencies.refreshConnection);
  const siblingTurnRunning = tracksTurns ? trackRunningTurns(provider) : () => false;
  const bridgeKey = `${connection.agent}:${dependencies.bridgeEnvironmentId ?? dependencies.environment?.environmentId ?? connection.baseUrl}`;
  const shared = workflowBridges.get(bridgeKey) ?? {
    observers: new Set<() => boolean>(),
    connection: { ...connection },
  };
  const observers = shared.observers;
  const bridgeRunning = () => [...observers].some((running) => running());
  const adoptConnection = () => {
    // Share transport identity, preserving each owner's model and execution defaults.
    connection.baseUrl = shared.connection.baseUrl;
    connection.authToken = shared.connection.authToken;
    connection.accountId = shared.connection.accountId;
  };
  if (tracksTurns) {
    workflowBridges.set(bridgeKey, shared);
    adoptConnection();
    observers.add(siblingTurnRunning);
    const dispose = provider.dispose?.bind(provider);
    provider.dispose = () => {
      observers.delete(siblingTurnRunning);
      if (!observers.size) workflowBridges.delete(bridgeKey);
      dispose?.();
    };
    if (dependencies.refreshConnection) {
      const refresh = async () => {
        if (shared.refreshing) await shared.refreshing;
        if (!bridgeRunning()) {
          shared.refreshing = (async () => {
            shared.connection = await dependencies.refreshConnection!();
          })();
          try {
            await shared.refreshing;
          } finally {
            shared.refreshing = undefined;
          }
        }
        adoptConnection();
      };
      const create = provider.createSession.bind(provider);
      provider.createSession = async (...args) => {
        await refresh();
        return create(...args);
      };
      const prepare = provider.prepareDispatch?.bind(provider);
      provider.prepareDispatch = async (...args) => {
        await refresh();
        await prepare?.(...args);
      };
    }
  }
  if (dependencies.usageLimitStops && isAgentAccountPlatform(platform)) {
    provider.usageLimitStop = (input) =>
      dependencies.usageLimitStops!.handleLimitStop({
        ...input,
        platform,
        siblingTurnRunning: bridgeRunning,
      });
  }
  // Codex runs the model its session was created with; the other bridges carry
  // the model on each prompt and keep the configured one.
  if (connection.agent === "codex") {
    provider.resolveDefaultModel = (modelId) =>
      resolveCodexBridgeDefaultModel(connection, dependencies.fetch ?? fetch, modelId);
  }
  const signInGuidance = dependencies.environment?.signInGuidance;
  if (signInGuidance && (connection.agent === "codex" || connection.agent === "grok")) {
    applySignInGuidance(provider, () => signInGuidance(connection.agent));
  }
  if (dependencies.workflowResults) {
    const providerStructured = provider.structured.bind(provider);
    provider.structured = async <T>(sessionId: string, requestId: string) => {
      try {
        const lookup = dependencies.workflowResults!.lookup
          ? await dependencies.workflowResults!.lookup<T>(requestId)
          : {
              result: await dependencies.workflowResults!.structured<T>(requestId),
              registered: await dependencies.workflowResults!.registered(requestId),
            };
        if (lookup.result || lookup.registered) return lookup.result;
      } catch (error) {
        console.warn(
          "[native-agent] Workflow result store unavailable; using provider result:",
          error,
        );
      }
      return providerStructured<T>(sessionId, requestId);
    };
  }
  return provider;
}
