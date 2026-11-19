import type { NativeAgentLiveUpdate } from "@orkestrator/protocol/native-agent";
import {
  PUSH_PROTOCOL_VERSIONS,
  PUSH_LIMITS,
  pushUtf8Bytes,
  type PushSetSubscriptionsArgs,
  type PushSetSubscriptionsResult,
} from "@orkestrator/protocol/push-events";
import {
  PushHub,
  type PushConnectionSink,
  type PushHubOptions,
  type PushMetricsSnapshot,
} from "./push-hub.js";
import {
  NATIVE_SESSION_PUSH_TOPIC,
  NativeSessionPushTopic,
  nativeSessionLiveReadInput,
  type NativeSessionPushTopicMetrics,
} from "./native-session-push-topic.js";

export { PushHub, type PushConnectionSink, type PushTopicProvider } from "./push-hub.js";
export { NativeSessionPushTopic, NATIVE_SESSION_PUSH_TOPIC } from "./native-session-push-topic.js";

export interface PushLayerMetrics extends PushMetricsSnapshot {
  versions: readonly number[];
  topics: { "native-session": NativeSessionPushTopicMetrics };
}

/**
 * What the gateway needs from the push layer: one connection per
 * authoritative event stream, the subscribe command answered for the
 * credential that opened the stream, and the metrics block.
 */
export interface PushGatewayPort {
  readonly versions: readonly number[];
  openConnection(owner: string, sink: PushConnectionSink): string;
  closeConnection(streamId: string): void;
  setSubscriptions(
    owner: string,
    args: Record<string, unknown>,
  ): Promise<PushSetSubscriptionsResult>;
  metrics(): PushLayerMetrics;
}

/** The parts of the native agent service the `native-session` topic reads. */
export interface PushNativeAgents {
  getLiveUpdate(
    input: ReturnType<typeof nativeSessionLiveReadInput>,
  ): Promise<NativeAgentLiveUpdate>;
  observePushSession(environmentId: string, agent: string, logicalSessionKey: string): () => void;
  canWakePushObserverFromBridge?(environmentId: string, agent: string): boolean;
  forgetPushSettled(environmentId: string, agent: string, logicalSessionKey: string): void;
}

export interface BackendPushOptions {
  nativeAgents(): PushNativeAgents | undefined;
  sessionExists(environmentId: string, agent: string, logicalSessionKey: string): Promise<boolean>;
  hub?: PushHubOptions;
}

/** Thrown into the subscribe answer for arguments no client of this protocol sends. */
class PushArgumentError extends Error {}

function parseArgs(args: Record<string, unknown>): PushSetSubscriptionsArgs {
  const { streamId, setRevision, subscriptions } = args;
  if (typeof streamId !== "string" || streamId.length > 128) {
    throw new PushArgumentError("streamId must be a bounded string");
  }
  if (typeof setRevision !== "number" || !Number.isSafeInteger(setRevision) || setRevision < 0) {
    throw new PushArgumentError("setRevision must be a non-negative integer");
  }
  if (!Array.isArray(subscriptions)) throw new PushArgumentError("subscriptions must be a list");
  if (subscriptions.length > PUSH_LIMITS.maxSubscriptions) {
    throw new PushArgumentError("Push subscription set has too many entries");
  }
  return {
    streamId,
    setRevision,
    subscriptions: subscriptions.map((entry) => {
      const record = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      const topic = typeof record.topic === "string" ? record.topic : "";
      const key = typeof record.key === "string" ? record.key : "";
      if (
        topic.length > 64 ||
        key.length > PUSH_LIMITS.maxKeyBytes ||
        pushUtf8Bytes(key) > PUSH_LIMITS.maxKeyBytes
      ) {
        throw new PushArgumentError("Push subscription entry exceeds the string budget");
      }
      return { topic, key };
    }),
  };
}

/**
 * The backend's push layer: the hub plus its topics. Built once by the
 * backend; the gateway reaches it through {@link PushGatewayPort}.
 */
export class BackendPush implements PushGatewayPort {
  readonly versions = PUSH_PROTOCOL_VERSIONS;
  readonly hub: PushHub;
  readonly nativeSessions: NativeSessionPushTopic;

  constructor(options: BackendPushOptions) {
    this.hub = new PushHub(options.hub);
    this.nativeSessions = new NativeSessionPushTopic({
      readLiveUpdate: async (input) => {
        const nativeAgents = options.nativeAgents();
        if (!nativeAgents) throw new Error("Native agent service is unavailable");
        return nativeAgents.getLiveUpdate(nativeSessionLiveReadInput(input));
      },
      sessionExists: (key) =>
        options.sessionExists(key.environmentId, key.agent, key.logicalSessionKey),
      publish: (key, stamp, parts) =>
        this.hub.publish(NATIVE_SESSION_PUSH_TOPIC, key, stamp, parts),
      onWake: (key) =>
        options
          .nativeAgents()
          ?.forgetPushSettled(key.environmentId, key.agent, key.logicalSessionKey),
      canWakeFromBridge: (key) =>
        options.nativeAgents()?.canWakePushObserverFromBridge?.(key.environmentId, key.agent) ===
        true,
      observeSession: (key) =>
        options
          .nativeAgents()
          ?.observePushSession(key.environmentId, key.agent, key.logicalSessionKey) ??
        (() => undefined),
      timers: options.hub?.timers,
    });
    this.hub.registerTopic(this.nativeSessions);
  }

  openConnection(owner: string, sink: PushConnectionSink): string {
    return this.hub.openConnection(owner, sink);
  }

  closeConnection(streamId: string): void {
    this.hub.closeConnection(streamId);
  }

  async setSubscriptions(
    owner: string,
    args: Record<string, unknown>,
  ): Promise<PushSetSubscriptionsResult> {
    return this.hub.setSubscriptions(owner, parseArgs(args));
  }

  /** Every backend event, so topics can wake on the ones that name their keys. */
  observeEvent(event: string, payload: unknown): void {
    this.nativeSessions.observeEvent(event, payload);
  }

  metrics(): PushLayerMetrics {
    return {
      versions: this.versions,
      ...this.hub.metrics(),
      topics: { [NATIVE_SESSION_PUSH_TOPIC]: this.nativeSessions.metrics() },
    };
  }

  dispose(): void {
    this.nativeSessions.dispose();
    this.hub.dispose();
  }
}
