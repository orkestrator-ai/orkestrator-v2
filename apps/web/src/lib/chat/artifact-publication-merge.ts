/**
 * Place published transcript artifacts into the loaded transcript.
 *
 * The backend publication ledger is authoritative: every publication is read
 * from it by conversation, including ones committed while this client was
 * disconnected, and no text, JSON or tool output can create one. Placement:
 *
 *  - Anchored by the backend: a publication whose ledger entry names the
 *    tool call that published it (`anchor.toolCallId`) is appended to the
 *    row holding the tool part with that `toolUseId`. This wins over
 *    argument matching.
 *  - Anchored by arguments: a successful `publish_artifact` tool call whose arguments name
 *    the publication's artifact and revision gets the artifact part appended
 *    to the end of that same row (one model response step). Matching uses the
 *    call's arguments and the ledger, never the tool output, so a provider
 *    that trims or flattens the result still shows the artifact. Appending at
 *    the end keeps earlier parts' positional identities stable.
 *  - Unanchored: a publication with no matching call among the loaded rows is
 *    shown as a backend-attributed row (`ARTIFACT_PUBLICATION_MESSAGE_PREFIX`
 *    + publication id) placed by publication time — but only when that time
 *    falls inside the loaded range, so an artifact whose call sits in
 *    unloaded history appears once that page loads, not at the bottom.
 *    Unanchored rows keep `conversationSequence` order among themselves.
 *  - Bounded ledger: when the ledger read omitted older publications or
 *    stopped at its page bound, an explicit notice row says so instead of
 *    dropping them silently.
 *
 * Each publication appears at most once. Historical rows always name their
 * own immutable revision; a later publication never retargets them.
 *
 * The backend projection places the same publications itself (beside their
 * calls, never as rows), so a row usually arrives already carrying its
 * artifact part. Any part present — at the top level or inside a tool, agent
 * or task group — counts as placed, so this merge never adds a second copy
 * and only fills in what the loaded rows do not already carry (a ledger read
 * that ran ahead of the transcript read, or an unanchored publication).
 */
import {
  ARTIFACT_PUBLICATION_MESSAGE_PREFIX,
  ARTIFACT_TOOL_NAMES,
  artifactPartContent,
  orkestratorToolName,
} from "@orkestrator/protocol/transcript-artifacts";
import type { ArtifactPublicationView } from "@orkestrator/protocol/transcript-artifact-commands";
import type {
  NativeArtifactPart,
  NativeMessage,
  NativeMessagePart,
} from "@/lib/chat/native-message-types";

/** Notice row id prefix for an omitted-publications notice. */
export const ARTIFACT_LEDGER_NOTICE_PREFIX = "orkestrator-artifact-notice:";

/**
 * A ledger as read for one conversation. `omittedOlder` counts older
 * publications beyond the retained bound; `incomplete` means the read stopped
 * at its page bound with more publications remaining.
 */
export type ArtifactPublicationLedger = readonly ArtifactPublicationView[] & {
  readonly omittedOlder?: number;
  readonly incomplete?: boolean;
};

export function withLedgerOmission(
  publications: ArtifactPublicationView[],
  omission: { omittedOlder: number; incomplete: boolean },
): ArtifactPublicationLedger {
  if (omission.omittedOlder <= 0 && !omission.incomplete) return publications;
  return Object.assign(publications, {
    omittedOlder: Math.max(0, omission.omittedOlder),
    incomplete: omission.incomplete,
  });
}

/** The tool call the backend recorded as publishing this artifact, if any. */
function anchorToolCallId(publication: ArtifactPublicationView): string | null {
  const id: unknown = publication.anchor?.toolCallId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** All nested parts, bounded independently of provider nesting. */
function visitParts(
  parts: readonly NativeMessagePart[],
  visit: (part: NativeMessagePart) => void,
  depth = 0,
) {
  if (depth > 8) return;
  for (const part of parts) {
    visit(part);
    if (part.type === "tool-group" || part.type === "agent-group")
      visitParts(part.parts, visit, depth + 1);
    else if (part.type === "task-group")
      visitParts([part.task, ...part.childTools], visit, depth + 1);
  }
}
function collectToolUseIds(parts: readonly NativeMessagePart[], into: Set<string>) {
  visitParts(parts, (part) => {
    if (part.toolUseId) into.add(part.toolUseId);
  });
}
function collectArtifactParts(
  parts: readonly NativeMessagePart[],
  visit: (part: NativeArtifactPart) => void,
) {
  visitParts(parts, (part) => {
    if (part.type === "artifact") visit(part);
  });
}

export function artifactPartFromPublication(
  publication: ArtifactPublicationView,
): NativeArtifactPart {
  return {
    type: "artifact",
    content: artifactPartContent(publication.ref),
    artifact: publication.ref,
    publishedAt: publication.publishedAt,
    conversationSequence: publication.conversationSequence,
    sourcePartId: `artifact:${publication.ref.publicationId}`,
  };
}

function publicationKey(artifactId: string, revision: number): string {
  return `${artifactId}\u0000${revision}`;
}

function publishCallTarget(part: NativeMessagePart): string | null {
  if (part.type !== "tool-invocation" || part.toolState !== "success") return null;
  const tool = orkestratorToolName(part.toolName, ARTIFACT_TOOL_NAMES, {
    toolTitle: "toolTitle" in part ? (part as { toolTitle?: string }).toolTitle : undefined,
    mcpServerName:
      "mcpServerName" in part ? (part as { mcpServerName?: string }).mcpServerName : undefined,
  });
  if (tool !== "publish_artifact") return null;
  const args = part.toolArgs;
  const artifactId = args?.artifactId;
  const revision = args?.expectedRevision;
  if (typeof artifactId !== "string" || typeof revision !== "number") return null;
  return publicationKey(artifactId, revision);
}

function timeOf(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

export interface MergeArtifactOptions {
  /** True when older history exists that is not loaded. */
  canLoadEarlier: boolean;
}

export function mergeArtifactPublications<T extends NativeMessage>(
  messages: readonly T[],
  publications: ArtifactPublicationLedger,
  options: MergeArtifactOptions,
): T[] {
  const notice = ledgerNoticeRow(messages, publications);
  if (publications.length === 0) return notice ? [notice as T, ...messages] : (messages as T[]);
  const byTarget = new Map<string, ArtifactPublicationView>();
  const byToolCall = new Map<string, ArtifactPublicationView>();
  for (const publication of publications) {
    byTarget.set(publicationKey(publication.ref.artifactId, publication.ref.revision), publication);
    const toolCallId = anchorToolCallId(publication);
    if (toolCallId) byToolCall.set(toolCallId, publication);
  }
  const placed = new Set<string>();
  // Parts already present (the backend projection's) count as placed.
  for (const message of messages) {
    collectArtifactParts(message.parts, (part) => placed.add(part.artifact.publicationId));
  }

  const additions = new Map<number, NativeArtifactPart[]>();
  const add = (index: number, publication: ArtifactPublicationView) => {
    placed.add(publication.ref.publicationId);
    const list = additions.get(index) ?? [];
    list.push(artifactPartFromPublication(publication));
    additions.set(index, list);
  };
  // Pass 1: the backend's recorded tool call wins.
  if (byToolCall.size > 0) {
    messages.forEach((message, index) => {
      const ids = new Set<string>();
      collectToolUseIds(message.parts, ids);
      for (const id of ids) {
        const publication = byToolCall.get(id);
        if (publication && !placed.has(publication.ref.publicationId)) add(index, publication);
      }
    });
  }
  // Pass 2: fall back to the publish call's arguments.
  messages.forEach((message, index) => {
    visitParts(message.parts, (part) => {
      const target = publishCallTarget(part);
      if (!target) return;
      const publication = byTarget.get(target);
      if (!publication || placed.has(publication.ref.publicationId)) return;
      add(index, publication);
    });
  });

  const result: T[] =
    additions.size === 0
      ? (messages as T[])
      : messages.map((message, index) => {
          const extra = additions.get(index);
          if (!extra) return message;
          extra.sort((a, b) => a.conversationSequence - b.conversationSequence);
          return { ...message, parts: [...message.parts, ...extra] };
        });

  const firstTime = messages.length > 0 ? timeOf(messages[0]!.createdAt) : Number.NaN;
  const unanchored = publications
    .filter((publication) => !placed.has(publication.ref.publicationId))
    .filter((publication) => {
      if (!options.canLoadEarlier) return true;
      const published = timeOf(publication.publishedAt);
      return Number.isFinite(firstTime) && Number.isFinite(published) && published >= firstTime;
    })
    // Sequence order among themselves; each waits for its predecessors, so a
    // clock skew between publications never reorders the ledger.
    .sort((a, b) => a.conversationSequence - b.conversationSequence);
  if (unanchored.length === 0) {
    if (notice) return [notice as T, ...result];
    return result;
  }

  const merged: T[] = notice ? [notice as T] : [];
  let next = 0;
  for (const message of result) {
    const messageTime = timeOf(message.createdAt);
    while (
      next < unanchored.length &&
      Number.isFinite(messageTime) &&
      timeOf(unanchored[next]!.publishedAt) < messageTime
    ) {
      merged.push(publicationRow(unanchored[next++]!) as T);
    }
    merged.push(message);
  }
  while (next < unanchored.length) merged.push(publicationRow(unanchored[next++]!) as T);
  return merged;
}

/** An explicit notice when the ledger read left publications out. */
function ledgerNoticeRow(
  messages: readonly NativeMessage[],
  publications: ArtifactPublicationLedger,
): NativeMessage | null {
  const omitted = publications.omittedOlder ?? 0;
  if (omitted <= 0 && !publications.incomplete) return null;
  const sentences: string[] = [];
  if (omitted > 0) {
    sentences.push(
      `${omitted.toLocaleString("en-US")} older artifact${omitted === 1 ? "" : "s"} not loaded: this conversation has more published artifacts than the transcript loads (newest ${publications.length.toLocaleString("en-US")} shown).`,
    );
  }
  if (publications.incomplete) {
    sentences.push(
      "The artifact list stopped at its read limit; artifacts published after that point are not shown.",
    );
  }
  const content = sentences.join(" ");
  return {
    id: `${ARTIFACT_LEDGER_NOTICE_PREFIX}omitted`,
    role: "system",
    content,
    parts: [{ type: "status", content, severity: "info" }],
    createdAt: messages[0]?.createdAt ?? publications[0]?.publishedAt ?? new Date(0).toISOString(),
  };
}

function publicationRow(publication: ArtifactPublicationView): NativeMessage {
  const part = artifactPartFromPublication(publication);
  return {
    id: `${ARTIFACT_PUBLICATION_MESSAGE_PREFIX}${publication.ref.publicationId}`,
    role: "assistant",
    content: part.content,
    parts: [part],
    createdAt: publication.publishedAt,
  };
}

/** Publish calls in loaded rows whose publication is not yet known. */
export function unresolvedPublishCalls(
  messages: readonly NativeMessage[],
  publications: readonly ArtifactPublicationView[],
): number {
  const known = new Set(
    publications.map((publication) =>
      publicationKey(publication.ref.artifactId, publication.ref.revision),
    ),
  );
  const anchored = new Set<string>();
  for (const publication of publications) {
    const id = anchorToolCallId(publication);
    if (id) anchored.add(id);
  }
  // A publication the backend already placed is known even when this
  // client's ledger read has not caught up with it.
  for (const message of messages) {
    collectArtifactParts(message.parts, (part) =>
      known.add(publicationKey(part.artifact.artifactId, part.artifact.revision)),
    );
  }
  let unresolved = 0;
  for (const message of messages) {
    visitParts(message.parts, (part) => {
      const target = publishCallTarget(part);
      if (!target || known.has(target)) return;
      if (part.toolUseId && anchored.has(part.toolUseId)) return;
      unresolved++;
    });
  }
  return unresolved;
}

/**
 * Preserve first-paint placement within one mounted conversation. A ledger
 * can precede its call row: once its standalone card is visible, a later
 * provider overlay must not move it into a different React parent. Bounded
 * by the same retained-publication limit as the ledger, and discarded with
 * the conversation scope. Only identifiers are retained here.
 */
export class ArtifactPublicationPlacements {
  constructor(readonly scope: unknown = null) {}
  private readonly rows = new Map<string, boolean>();
  stabilize<T extends NativeMessage>(messages: readonly T[]): T[] {
    const held = new Map<string, NativeArtifactPart>();
    for (const message of messages) {
      collectArtifactParts(message.parts, (part) => {
        const id = part.artifact.publicationId;
        if (!this.rows.has(id))
          this.rows.set(id, message.id.startsWith(ARTIFACT_PUBLICATION_MESSAGE_PREFIX));
        if (this.rows.get(id)) held.set(id, part);
      });
    }
    while (this.rows.size > 2000) this.rows.delete(this.rows.keys().next().value!);
    if (held.size === 0) return messages as T[];
    const strip = <P extends NativeMessagePart>(parts: readonly P[], depth = 0): P[] => {
      if (depth > 8) return parts as P[];
      return parts.flatMap((part): NativeMessagePart[] => {
        if (part.type === "artifact" && held.has(part.artifact.publicationId)) return [];
        if (part.type === "tool-group") return [{ ...part, parts: strip(part.parts, depth + 1) }];
        if (part.type === "agent-group") return [{ ...part, parts: strip(part.parts, depth + 1) }];
        if (part.type === "task-group")
          return [{ ...part, childTools: strip(part.childTools, depth + 1) }];
        return [part];
      }) as P[];
    };
    const result = messages.flatMap((message): T[] => {
      if (message.id.startsWith(ARTIFACT_PUBLICATION_MESSAGE_PREFIX)) return [];
      let changed = false;
      collectArtifactParts(message.parts, (part) => {
        if (held.has(part.artifact.publicationId)) changed = true;
      });
      return [changed ? { ...message, parts: strip(message.parts) } : message];
    });
    for (const [id, part] of held) {
      const row = {
        id: `${ARTIFACT_PUBLICATION_MESSAGE_PREFIX}${id}`,
        role: "assistant",
        content: part.content,
        parts: [part],
        createdAt: part.publishedAt,
      } as T;
      const index = result.findIndex(
        (message) => timeOf(message.createdAt) > timeOf(row.createdAt),
      );
      if (index < 0) result.push(row);
      else result.splice(index, 0, row);
    }
    return result;
  }
}
