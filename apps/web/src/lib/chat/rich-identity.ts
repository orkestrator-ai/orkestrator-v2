/**
 * Identity for rich transcript content.
 *
 * Three identities are deliberately distinct:
 *  - block view identity  (backend, environment, session, message, part, block)
 *    keys React state and user view choices; a new streaming token must not
 *    change it;
 *  - artifact occurrence identity adds (publication, artifact, revision);
 *  - cache identity additionally adds the verified content hash, renderer
 *    version, theme/font generation and display parameters.
 *
 * All of them are encoded by `encodeRichKey`, a tuple encoder that cannot
 * collide across component boundaries the way string concatenation can.
 */
import { createContext, useContext } from "react";

export type RichKeyPart = string | number | boolean | null;

export function encodeRichKey(parts: readonly RichKeyPart[]): string {
  return JSON.stringify(parts);
}

/**
 * The conversation a transcript renders. `backendId` comes from the
 * authenticated connection binding (the capabilities read), never from
 * artifact text or a model-supplied reference. `generation` changes when the
 * transport/session is replaced so late responses from a discarded session
 * cannot populate the new one.
 */
export interface RichTranscriptScope {
  backendId: string | null;
  environmentId: string;
  logicalSessionKey: string;
  generation: string;
}

export const RichTranscriptScopeContext = createContext<RichTranscriptScope | null>(null);

export function useRichTranscriptScope(): RichTranscriptScope | null {
  return useContext(RichTranscriptScopeContext);
}

export interface RichMessageIdentity {
  messageId: string;
  role: "user" | "assistant" | "system";
}

export const RichMessageContext = createContext<RichMessageIdentity | null>(null);

export function useRichMessageIdentity(): RichMessageIdentity | null {
  return useContext(RichMessageContext);
}

/** Fallback scope for transcripts rendered outside a native agent tab (previews, tests). */
const DETACHED_SCOPE: RichTranscriptScope = {
  backendId: null,
  environmentId: "detached",
  logicalSessionKey: "detached",
  generation: "0",
};

export function richScopeKey(scope: RichTranscriptScope | null): RichKeyPart[] {
  const value = scope ?? DETACHED_SCOPE;
  return [value.backendId, value.environmentId, value.logicalSessionKey];
}

/** Block view identity: stable across streaming tokens, theme changes and remounts. */
export function richBlockViewKey(
  scope: RichTranscriptScope | null,
  messageId: string,
  sourcePartId: string,
  stableBlockId: string,
): string {
  return encodeRichKey(["block", ...richScopeKey(scope), messageId, sourcePartId, stableBlockId]);
}

export function useRichBlockViewKey(sourcePartId: string, stableBlockId: string): string {
  const scope = useRichTranscriptScope();
  const message = useRichMessageIdentity();
  return richBlockViewKey(
    scope,
    message?.messageId ?? "unknown-message",
    sourcePartId,
    stableBlockId,
  );
}

/** Artifact occurrence identity. */
export function richArtifactOccurrenceKey(
  scope: RichTranscriptScope | null,
  messageId: string,
  publicationId: string,
  artifactId: string,
  revision: number,
): string {
  return encodeRichKey([
    "artifact",
    ...richScopeKey(scope),
    messageId,
    publicationId,
    artifactId,
    revision,
  ]);
}

/** Cache identity for derived render output. */
export function richCacheKey(input: {
  kind: string;
  contentHash: string;
  rendererVersion: string;
  theme: string;
  display?: RichKeyPart[];
  scope?: RichTranscriptScope | null;
}): string {
  return encodeRichKey([
    "cache",
    input.kind,
    ...(input.scope === undefined ? [] : richScopeKey(input.scope)),
    input.contentHash,
    input.rendererVersion,
    input.theme,
    ...(input.display ?? []),
  ]);
}

/** Prefix that every key of one conversation starts with, for scoped cleanup. */
export function richScopePrefixes(
  scope: Pick<RichTranscriptScope, "backendId" | "environmentId" | "logicalSessionKey">,
): string[] {
  const parts = JSON.stringify([
    scope.backendId,
    scope.environmentId,
    scope.logicalSessionKey,
  ]).slice(1, -1);
  return [`["block",${parts},`, `["artifact",${parts},`];
}

/**
 * A small, fast, non-cryptographic content fingerprint (FNV-1a 64 as hex).
 * Used only for client cache identity of inline Markdown content; published
 * artifacts use the backend's verified SHA-256 instead.
 */
export function contentFingerprint(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x5bd1e995) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}:${text.length}`;
}
