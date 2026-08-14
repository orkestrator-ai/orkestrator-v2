import type { AgentInteractionRequest } from "./agent-interactions.js";
import { isAgentPlatform, type AgentPlatform } from "./agent-platforms.js";

/** Provider-neutral identity for one native-agent tab. */
export interface NativeAgentTabData {
  /** Locked on first dispatch. Undefined is the durable, unassigned state. */
  platform?: AgentPlatform;
  environmentId: string;
  containerId?: string;
  hostPort?: number;
  sessionId?: string;
  isLocal?: boolean;
}

export function isNativeAgentTabData(value: unknown): value is NativeAgentTabData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  const optionalString = (field: string) =>
    data[field] === undefined || typeof data[field] === "string";
  return (data.platform === undefined || isAgentPlatform(data.platform))
    && typeof data.environmentId === "string"
    && data.environmentId.length > 0
    && optionalString("containerId")
    && optionalString("sessionId")
    && (data.hostPort === undefined
      || (Number.isSafeInteger(data.hostPort) && (data.hostPort as number) > 0))
    && (data.isLocal === undefined || typeof data.isLocal === "boolean");
}

export interface AgentReasoningOption {
  id: string;
  label: string;
  description?: string;
  annotation?: string;
}

/** Provider-neutral model catalog entry consumed by renderer presentation. */
export interface AgentModel {
  platform: AgentPlatform;
  id: string;
  label: string;
  /** Provider label shown beneath the model name; defaults to the platform. */
  providerLabel?: string;
  description?: string;
  reasoning?: AgentReasoningOption[];
  defaultReasoningId?: string;
  supportsSpeed?: boolean;
  supportsMode?: boolean;
}

export interface AgentModelRef {
  platform: AgentPlatform;
  modelId: string;
}

export type AgentConversationMode = "build" | "plan";

export type NativeAgentConnectionState = "connecting" | "connected" | "error";

/**
 * A dispatch may have reached the provider even when its HTTP response was
 * lost. Callers must reconcile `unknown`; they must never retry it blindly.
 */
export type NativeAgentDispatchOutcome =
  | { outcome: "accepted"; requestId: string }
  | { outcome: "rejected"; error: string }
  | { outcome: "unknown"; requestId: string; error?: string };

export type NativeAgentTurnPhase =
  | "idle"
  | "running"
  | "cancelling"
  | "recovering"
  | "error";

export interface NativeAgentTurnState {
  phase: NativeAgentTurnPhase;
  startedAt?: number;
  error?: string;
}

export interface NativeAgentSelectOption {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface NativeAgentSelectControl {
  kind: "select" | "segmented";
  id: string;
  label: string;
  value?: string;
  options: NativeAgentSelectOption[];
  disabled?: boolean;
}

export interface NativeAgentToggleControl {
  kind: "toggle";
  id: string;
  label: string;
  value: boolean;
  description?: string;
  disabled?: boolean;
}

export type NativeAgentComposerControl =
  | NativeAgentSelectControl
  | NativeAgentToggleControl;

export interface NativeAgentCapabilities {
  attachments: {
    files: boolean;
    images: boolean;
  };
  queue: boolean;
  resume: boolean;
  fork: boolean;
  slashCommands: boolean;
  backgroundTasks: boolean;
  composer: {
    provider: boolean;
    model: boolean;
    reasoning: boolean;
    speed: boolean;
    mode: boolean;
  };
}

/**
 * Provider-neutral state consumed by native-agent presentation components.
 * Provider wire payloads and credentials must never be attached to this shape.
 */
export interface NativeAgentSessionProjection<TMessage = unknown> {
  platform: AgentPlatform;
  environmentId: string;
  sessionId?: string;
  title?: string;
  connection: NativeAgentConnectionState;
  turn: NativeAgentTurnState;
  messages: TMessage[];
  interactions: AgentInteractionRequest[];
  composerControls: NativeAgentComposerControl[];
  capabilities: NativeAgentCapabilities;
  revision?: number;
  generation?: string | number;
  cursor?: string;
}
