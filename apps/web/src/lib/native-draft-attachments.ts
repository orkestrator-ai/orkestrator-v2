/**
 * Which persisted draft attachments may be restored into a native composer.
 *
 * Two questions, answered in this order and never merged:
 *
 * 1. **Structure.** Is the stored record an attachment at all? Malformed
 *    entries are dropped whatever the platform accepts.
 * 2. **Type eligibility.** Does the namespace's platform accept that attachment
 *    type? This is read from the shared capability table
 *    (`nativeAgentCapabilities(platform).attachments`) — the same source the
 *    composer uses when attaching and the send path uses when dispatching — so
 *    restoration cannot disagree with them. A private copy of that rule is what
 *    once dropped every Cursor and Grok image on reload.
 *
 * Model-specific vision support is deliberately not consulted. The catalogue
 * may still be loading or a model change may be pending; the composer surfaces
 * that incompatibility at send time, where the user can act on it, instead of
 * restoration silently destroying the image.
 */
import { isAgentPlatform, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import {
  retainSupportedAttachments,
  type AttachmentTypeCapabilities,
} from "@/lib/chat/attachment-capabilities";

/**
 * Storage namespaces a native composer draft can live under: one per assigned
 * native platform, the provider-neutral `agent-native` record of a tab that has
 * not been assigned yet, and the legacy Claude terminal composer.
 */
export type NativeDraftNamespace = AgentPlatform | "agent-native" | "claude-tmux";

/** The persisted attachment shape every native composer store holds. */
export interface PersistedDraftAttachment {
  id: string;
  type: "file" | "image";
  name: string;
  path: string;
  previewUrl?: string;
  annotationId?: string;
}

/**
 * The legacy Claude tmux composer's own contract, outside the native table.
 *
 * Terminal delivery hands the agent paths inside the typed prompt rather than a
 * bridge payload, so it has never been type-restricted. It is spelled out here
 * rather than borrowed from Claude's native row so a change to the native
 * bridge cannot silently change what the terminal composer restores.
 */
const CLAUDE_TMUX_DRAFT_ATTACHMENTS: AttachmentTypeCapabilities = Object.freeze({
  files: true,
  images: true,
});

export type DraftAttachmentPolicy =
  /** An assigned platform, or `agent-native` metadata naming a known one. */
  | { kind: "platform"; platform: AgentPlatform; attachments: AttachmentTypeCapabilities }
  /** The legacy Claude tmux composer. */
  | { kind: "legacy-terminal"; attachments: AttachmentTypeCapabilities }
  /**
   * No platform has been chosen yet (or its stored metadata is unreadable).
   * Structurally valid content is kept provisionally; the composer reconciles
   * it against the platform it resolves to, exactly as it does for a manual
   * platform change.
   */
  | { kind: "undecided" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural validation only: no platform or model policy. */
export function isPersistedDraftAttachment(value: unknown): value is PersistedDraftAttachment {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.path === "string" &&
    (value.type === "file" || value.type === "image") &&
    (value.previewUrl === undefined || typeof value.previewUrl === "string") &&
    (value.annotationId === undefined || typeof value.annotationId === "string")
  );
}

/**
 * Resolve whose attachment rules a stored draft must satisfy.
 *
 * An assigned namespace answers for itself. The shared `agent-native` record
 * belongs to a tab with no assigned agent, so its namespace says nothing; the
 * platform saved in its metadata does, validated through the same guard as an
 * assigned namespace so a known saved platform gets identical eligibility.
 */
export function draftAttachmentPolicy(
  namespace: NativeDraftNamespace,
  metadata: unknown,
): DraftAttachmentPolicy {
  if (namespace === "claude-tmux") {
    return { kind: "legacy-terminal", attachments: CLAUDE_TMUX_DRAFT_ATTACHMENTS };
  }
  const platform =
    namespace === "agent-native" ? (isRecord(metadata) ? metadata.platform : undefined) : namespace;
  if (!isAgentPlatform(platform)) return { kind: "undecided" };
  return {
    kind: "platform",
    platform,
    attachments: nativeAgentCapabilities(platform).attachments,
  };
}

/**
 * The stored attachments to restore, in their original order and with their
 * original records (ids, paths, preview and annotation references untouched).
 */
export function restorableDraftAttachments(
  namespace: NativeDraftNamespace,
  metadata: unknown,
  stored: readonly unknown[],
): PersistedDraftAttachment[] {
  const structural = stored.filter(isPersistedDraftAttachment);
  const policy = draftAttachmentPolicy(namespace, metadata);
  return policy.kind === "undecided"
    ? structural
    : retainSupportedAttachments(structural, policy.attachments);
}
