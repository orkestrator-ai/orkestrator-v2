import type {
  BuildPipelineAgent,
  NativeAgentSessionProjection,
  StorageService,
  NativeAgentRuntimeProvider,
  EnsureNativeAgentSessionInput,
  NativeAgentProjectionInput,
} from "./native-agent-service-shared.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { type AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";

/** What the interaction tracker needs from the service that wires it. */
export interface NativeAgentInteractionTrackerHost {
  storage: StorageService;
  now(): number;
  /** Resolve a provider for observation only, never starting a bridge. */
  observeProvider(
    input: EnsureNativeAgentSessionInput,
  ): Promise<NativeAgentRuntimeProvider | undefined>;
  /** The last projection built for a session, if any; purely in-memory. */
  cachedProjectionSnapshot(
    environmentId: string,
    agent: BuildPipelineAgent,
    logicalSessionKey: string,
  ): NativeAgentSessionProjection | null;
}

/**
 * Pending approvals and questions of one native session, read on demand
 * through a short-lived per-session cache. An interaction is answered (or
 * denied on timeout, disconnect or generation death) by its provider, never
 * here.
 */
export class NativeAgentInteractionTracker {
  /** Short-lived cache of on-demand pending-interaction reads, per session. */
  private readonly pendingInteractionReads = new Map<
    string,
    { at: number; environmentId: string; requests: AgentInteractionRequest[] }
  >();
  /** Reads in flight; a stop marks its environment's results inadmissible. */
  private readonly activePendingInteractionReads = new Set<{
    environmentId: string;
    withdrawn: boolean;
  }>();

  private readonly storage: StorageService;

  constructor(private readonly host: NativeAgentInteractionTrackerHost) {
    this.storage = host.storage;
  }

  /**
   * Test-only view of the state this tracker owns. Service tests reach
   * interaction state here, never through the service.
   */
  forTesting() {
    return {
      pendingInteractionReads: this.pendingInteractionReads,
    };
  }

  /** Drop one session's cached read, after an interaction was answered or held. */
  forgetPendingInteractions(key: string): void {
    this.pendingInteractionReads.delete(key);
  }

  /**
   * A committed stop: drop the environment's cached reads, and make reads
   * still in flight answer from the (withdrawn) projection instead of the
   * provider's last list, so a dead request cannot be cached back.
   */
  withdrawEnvironment(environmentId: string): void {
    for (const [key, entry] of Array.from(this.pendingInteractionReads)) {
      if (entry.environmentId === environmentId) this.pendingInteractionReads.delete(key);
    }
    for (const read of this.activePendingInteractionReads) {
      if (read.environmentId === environmentId) read.withdrawn = true;
    }
  }

  /**
   * Pending interactions of one session, for linking to the request whose turn
   * is waiting. Reads the provider's pending-interaction list at most once per
   * ten seconds per session (callers ask only while a turn is `waiting`),
   * falling back to the in-memory projection; `null` when neither is known.
   */
  async sessionPendingInteractions(
    input: NativeAgentProjectionInput,
  ): Promise<AgentInteractionRequest[] | null> {
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const live = (requests: readonly AgentInteractionRequest[]) =>
      requests.filter((request) => request.state === "pending" || request.state === "answering");
    const cached = this.pendingInteractionReads.get(key);
    if (cached && cached.at > this.host.now() - 10_000) return live(cached.requests);
    const fallback = () => {
      const projection = this.host.cachedProjectionSnapshot(
        input.environmentId,
        input.agent,
        input.logicalSessionKey,
      );
      return projection?.interactions ? live(projection.interactions) : null;
    };
    const read = { environmentId: input.environmentId, withdrawn: false };
    this.activePendingInteractionReads.add(read);
    try {
      const session = await this.storage.getNativeAgentSession(key);
      if (!session) return null;
      const provider = await this.host.observeProvider(input);
      if (!provider?.interactions) return fallback();
      const snapshot = await provider.interactions.listPendingInteractions(
        session.providerSessionId,
      );
      if (read.withdrawn) return fallback();
      if (!cached && this.pendingInteractionReads.size >= 128) {
        const oldest = this.pendingInteractionReads.keys().next().value;
        if (oldest !== undefined) this.pendingInteractionReads.delete(oldest);
      }
      this.pendingInteractionReads.set(key, {
        at: this.host.now(),
        environmentId: input.environmentId,
        requests: snapshot.requests,
      });
      return live(snapshot.requests);
    } catch {
      return fallback();
    } finally {
      this.activePendingInteractionReads.delete(read);
    }
  }
}
