import {
  ARTIFACT_PUBLICATION_MESSAGE_PREFIX,
  orkestratorToolName,
} from "@orkestrator/protocol/transcript-artifacts";
import type { NativeMessage, NativeMessagePart } from "./native-message-types";

/**
 * One visible occurrence per artifact publication.
 *
 * The backend projects a publication either beside the tool call that
 * published it or, when no reliable provider anchor exists, as a standalone
 * backend-attributed row whose id starts with
 * `ARTIFACT_PUBLICATION_MESSAGE_PREFIX`. A provider can echo it again later.
 * Keep exactly one occurrence per `publicationId` across the loaded list:
 * an occurrence beside a `publish_artifact` call wins, then any provider row,
 * then the standalone row. Standalone rows left with nothing are dropped.
 *
 * Returns the input array unchanged (same identity) when nothing is dropped,
 * and reuses rewritten message objects across calls so row identity is stable.
 */

const PUBLISH_TOOL = ["publish_artifact"] as const;

function publicationIdOf(part: NativeMessagePart): string | null {
  if (part.type !== "artifact") return null;
  const id = (part.artifact as { publicationId?: unknown } | undefined)?.publicationId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function containsPublishCall(parts: readonly NativeMessagePart[], depth = 0): boolean {
  if (depth > 4) return false;
  for (const part of parts) {
    if (
      part.type === "tool-invocation" &&
      orkestratorToolName(part.toolName, PUBLISH_TOOL, {
        toolTitle: part.toolTitle,
        mcpServerName: part.mcpServerName,
      })
    ) {
      return true;
    }
    if (
      (part.type === "tool-group" || part.type === "agent-group") &&
      containsPublishCall(part.parts, depth + 1)
    ) {
      return true;
    }
    if (
      part.type === "task-group" &&
      containsPublishCall([part.task, ...part.childTools], depth + 1)
    ) {
      return true;
    }
  }
  return false;
}

export function isArtifactPublicationMessageId(id: string): boolean {
  return id.startsWith(ARTIFACT_PUBLICATION_MESSAGE_PREFIX);
}

const rewriteCache = new WeakMap<NativeMessage, Map<string, NativeMessage>>();

function withoutParts<T extends NativeMessage>(message: T, dropped: ReadonlySet<number>): T {
  const key = Array.from(dropped)
    .sort((a, b) => a - b)
    .join(",");
  let cached = rewriteCache.get(message);
  const hit = cached?.get(key);
  if (hit) return hit as T;
  const next = { ...message, parts: message.parts.filter((_, index) => !dropped.has(index)) };
  if (!cached) {
    cached = new Map();
    rewriteCache.set(message, cached);
  }
  if (cached.size > 8) cached.clear();
  cached.set(key, next);
  return next;
}

export function dedupeArtifactPublications<T extends NativeMessage>(messages: readonly T[]): T[] {
  interface Occurrence {
    messageIndex: number;
    partIndex: number;
    rank: number;
  }
  const winners = new Map<string, Occurrence>();
  const occurrences: Array<Occurrence & { publicationId: string }> = [];
  messages.forEach((message, messageIndex) => {
    let anchored: boolean | null = null;
    const standalone = isArtifactPublicationMessageId(message.id);
    message.parts.forEach((part, partIndex) => {
      const publicationId = publicationIdOf(part);
      if (!publicationId) return;
      if (anchored === null) anchored = !standalone && containsPublishCall(message.parts);
      const rank = standalone ? 0 : anchored ? 2 : 1;
      const occurrence = { messageIndex, partIndex, rank, publicationId };
      occurrences.push(occurrence);
      const current = winners.get(publicationId);
      if (!current || rank > current.rank) winners.set(publicationId, occurrence);
    });
  });
  if (occurrences.length === winners.size) return messages as T[];

  const droppedByMessage = new Map<number, Set<number>>();
  for (const occurrence of occurrences) {
    if (winners.get(occurrence.publicationId) === occurrence) continue;
    const winner = winners.get(occurrence.publicationId)!;
    if (
      winner.messageIndex === occurrence.messageIndex &&
      winner.partIndex === occurrence.partIndex
    )
      continue;
    let set = droppedByMessage.get(occurrence.messageIndex);
    if (!set) {
      set = new Set();
      droppedByMessage.set(occurrence.messageIndex, set);
    }
    set.add(occurrence.partIndex);
  }
  if (droppedByMessage.size === 0) return messages as T[];

  const result: T[] = [];
  messages.forEach((message, index) => {
    const dropped = droppedByMessage.get(index);
    if (!dropped) {
      result.push(message);
      return;
    }
    if (isArtifactPublicationMessageId(message.id) && dropped.size >= message.parts.length) return;
    result.push(withoutParts(message, dropped));
  });
  return result;
}
