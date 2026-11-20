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
  type PushNodeSubscriptions,
  type PushMetricsSnapshot,
} from "./push-hub.js";
import {
  NATIVE_SESSION_PUSH_TOPIC,
  NativeSessionPushTopic,
  nativeSessionLiveReadInput,
  type NativeSessionPushTopicMetrics,
} from "./native-session-push-topic.js";
import {
  TOOL_OUTPUT_PUSH_TOPIC,
  ToolOutputPushTopic,
  type ToolOutputPushTopicMetrics,
  type ToolOutputSourceAnswer,
} from "./tool-output-push-topic.js";
import {
  ENVIRONMENT_PUSH_TOPIC,
  EnvironmentPushTopic,
  type EnvironmentPushTopicMetrics,
  type EnvironmentPushTopicOptions,
} from "./environment-push-topic.js";
import {
  REVIEW_TRANSCRIPT_PUSH_TOPIC,
  ReviewTranscriptPushTopic,
  type ReviewTranscriptPushTopicMetrics,
  type ReviewTranscriptPushTopicOptions,
} from "./review-transcript-push-topic.js";
import {
  WORKFLOW_PUSH_TOPIC,
  WorkflowPushTopic,
  type WorkflowPushTopicMetrics,
  type WorkflowPushTopicOptions,
} from "./workflow-push-topic.js";

export {
  PushHub,
  type PushConnectionSink,
  type PushNodeSubscriptions,
  type PushTopicProvider,
} from "./push-hub.js";
export { NativeSessionPushTopic, NATIVE_SESSION_PUSH_TOPIC } from "./native-session-push-topic.js";
export { ToolOutputPushTopic, TOOL_OUTPUT_PUSH_TOPIC } from "./tool-output-push-topic.js";
export { EnvironmentPushTopic, ENVIRONMENT_PUSH_TOPIC } from "./environment-push-topic.js";
export { WorkflowPushTopic, WORKFLOW_PUSH_TOPIC } from "./workflow-push-topic.js";
export { createWorkflowSummaryReader } from "./workflow-push-summary.js";
export {
  ReviewTranscriptPushTopic,
  REVIEW_TRANSCRIPT_PUSH_TOPIC,
  type ReviewTranscriptTarget,
} from "./review-transcript-push-topic.js";

export interface PushLayerMetrics extends PushMetricsSnapshot {
  versions: readonly number[];
  /** The relayed-node subscription controller's counters (design D10), when attached. */
  relayedNodes?: Record<string, number>;
  topics: {
    "native-session": NativeSessionPushTopicMetrics;
    environment?: EnvironmentPushTopicMetrics;
    workflow?: WorkflowPushTopicMetrics;
    "tool-output"?: ToolOutputPushTopicMetrics;
    "review-transcript"?: ReviewTranscriptPushTopicMetrics;
  };
}

/**
 * What the gateway needs from the push layer: one connection per
 * authoritative event stream, the subscribe command answered for the
 * credential that opened the stream, and the metrics block.
 */
export interface PushGatewayPort {
  readonly versions: readonly number[];
  /** `nodeId` sets are accepted (design D10); the offer says `nodes: true`. */
  readonly acceptsNodeSets?: boolean;
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
  canWakePushObserverFromBridge?(
    environmentId: string,
    agent: string,
  ): "revisions" | "hints" | "none" | boolean;
  forgetPushSettled(environmentId: string, agent: string, logicalSessionKey: string): void;
  /** A bridge hint woke the session's observer (see `NativeSessionPushTopicOptions.onBridgeWake`). */
  notePushHint?(environmentId: string, agent: string, logicalSessionKey: string): void;
  /** The `tool-output` topic's in-memory lookup of a call; without it that topic is not offered. */
  toolOutputSource?(
    environmentId: string,
    agent: string,
    logicalSessionKey: string,
    toolUseId: string,
    messageId?: string,
  ): ToolOutputSourceAnswer;
}

export interface BackendPushOptions {
  nativeAgents(): PushNativeAgents | undefined;
  sessionExists(environmentId: string, agent: string, logicalSessionKey: string): Promise<boolean>;
  /**
   * The reads the `environment` topic compares: the environment record and
   * its agent registry. Without them the topic is not offered, and a client
   * subscribing to it is answered `unknown-topic` and keeps polling.
   */
  environments?: Pick<EnvironmentPushTopicOptions, "readEnvironment" | "readRegistry">;
  /**
   * The run summaries the `workflow` topic compares (build pipelines, Multi
   * Reviews, graph runs). Without it the topic is not offered.
   */
  workflows?: Pick<WorkflowPushTopicOptions, "readSummary">;
  /**
   * The Multi Review reads the `review-transcript` topic compares and probes.
   * Without them the topic is not offered.
   */
  reviewTranscripts?: Pick<
    ReviewTranscriptPushTopicOptions,
    "readTarget" | "bridgeAnnounces" | "probeTranscript"
  >;
  hub?: PushHubOptions;
}

/** Thrown into the subscribe answer for arguments no client of this protocol sends. */
class PushArgumentError extends Error {}

function parseArgs(args: Record<string, unknown>): PushSetSubscriptionsArgs {
  const { streamId, setRevision, subscriptions, nodeId } = args;
  if (nodeId !== undefined && (typeof nodeId !== "string" || nodeId.length > 200)) {
    throw new PushArgumentError("nodeId must be a bounded string");
  }
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
    ...(nodeId === undefined ? {} : { nodeId }),
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
  readonly toolOutputs: ToolOutputPushTopic;
  readonly environments: EnvironmentPushTopic | null;
  readonly workflows: WorkflowPushTopic | null;
  readonly reviewTranscripts: ReviewTranscriptPushTopic | null;

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
      onBridgeWake: (key) =>
        options.nativeAgents()?.notePushHint?.(key.environmentId, key.agent, key.logicalSessionKey),
      canWakeFromBridge: (key) => {
        const mode = options
          .nativeAgents()
          ?.canWakePushObserverFromBridge?.(key.environmentId, key.agent);
        return mode === true ? "hints" : mode === "revisions" || mode === "hints" ? mode : "none";
      },
      observeSession: (key) =>
        options
          .nativeAgents()
          ?.observePushSession(key.environmentId, key.agent, key.logicalSessionKey) ??
        (() => undefined),
      timers: options.hub?.timers,
      now: options.hub?.now,
    });
    this.hub.registerTopic(this.nativeSessions);
    this.toolOutputs = new ToolOutputPushTopic({
      holdSession: (key, listener) => this.nativeSessions.hold(key, listener),
      source: (key) =>
        options
          .nativeAgents()
          ?.toolOutputSource?.(
            key.environmentId,
            key.agent,
            key.logicalSessionKey,
            key.toolUseId,
            key.messageId,
          ) ?? null,
      sessionExists: (key) =>
        options.sessionExists(key.environmentId, key.agent, key.logicalSessionKey),
      publish: (key, stamp, parts) => this.hub.publish(TOOL_OUTPUT_PUSH_TOPIC, key, stamp, parts),
    });
    this.hub.registerTopic(this.toolOutputs);
    const environmentReads = options.environments;
    this.environments = environmentReads
      ? new EnvironmentPushTopic({
          readEnvironment: (environmentId) => environmentReads.readEnvironment(environmentId),
          readRegistry: (environmentId) => environmentReads.readRegistry(environmentId),
          publish: (key, stamp, parts) =>
            this.hub.publish(ENVIRONMENT_PUSH_TOPIC, key, stamp, parts),
          timers: options.hub?.timers,
          now: options.hub?.now,
        })
      : null;
    if (this.environments) this.hub.registerTopic(this.environments);
    const workflowReads = options.workflows;
    this.workflows = workflowReads
      ? new WorkflowPushTopic({
          readSummary: (key) => workflowReads.readSummary(key),
          publish: (key, stamp, parts) => this.hub.publish(WORKFLOW_PUSH_TOPIC, key, stamp, parts),
          timers: options.hub?.timers,
        })
      : null;
    if (this.workflows) this.hub.registerTopic(this.workflows);
    const reviewReads = options.reviewTranscripts;
    this.reviewTranscripts = reviewReads
      ? new ReviewTranscriptPushTopic({
          readTarget: (key) => reviewReads.readTarget(key),
          bridgeAnnounces: (target) => reviewReads.bridgeAnnounces(target),
          probeTranscript: (key, token) => reviewReads.probeTranscript(key, token),
          publish: (key, stamp, parts) =>
            this.hub.publish(REVIEW_TRANSCRIPT_PUSH_TOPIC, key, stamp, parts),
          timers: options.hub?.timers,
          now: options.hub?.now,
        })
      : null;
    if (this.reviewTranscripts) this.hub.registerTopic(this.reviewTranscripts);
  }

  /** Whether a node subscription controller is attached (design D10). */
  get acceptsNodeSets(): boolean {
    return this.hub.acceptsNodeSets;
  }

  /**
   * The command node's controller for the nodes it relays (design D10).
   * Attached once both exist; `null` detaches it (a stopping backend).
   */
  attachNodeSubscriptions(nodes: PushNodeSubscriptions | null): void {
    this.hub.attachNodeSubscriptions(nodes);
    this.nodeSubscriptions = nodes;
  }

  private nodeSubscriptions: PushNodeSubscriptions | null = null;

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
    this.environments?.observeEvent(event, payload);
    this.workflows?.observeEvent(event, payload);
    this.reviewTranscripts?.observeEvent(event, payload);
  }

  metrics(): PushLayerMetrics {
    const relayedNodes = this.nodeSubscriptions?.metrics?.();
    return {
      versions: this.versions,
      ...this.hub.metrics(),
      ...(relayedNodes ? { relayedNodes } : {}),
      topics: {
        [NATIVE_SESSION_PUSH_TOPIC]: this.nativeSessions.metrics(),
        [TOOL_OUTPUT_PUSH_TOPIC]: this.toolOutputs.metrics(),
        ...(this.environments ? { [ENVIRONMENT_PUSH_TOPIC]: this.environments.metrics() } : {}),
        ...(this.workflows ? { [WORKFLOW_PUSH_TOPIC]: this.workflows.metrics() } : {}),
        ...(this.reviewTranscripts
          ? { [REVIEW_TRANSCRIPT_PUSH_TOPIC]: this.reviewTranscripts.metrics() }
          : {}),
      },
    };
  }

  dispose(): void {
    // Closing connections must not send relayed nodes smaller unions.
    this.hub.attachNodeSubscriptions(null);
    this.toolOutputs.dispose();
    this.nativeSessions.dispose();
    this.environments?.dispose();
    this.workflows?.dispose();
    this.reviewTranscripts?.dispose();
    this.hub.dispose();
  }
}
