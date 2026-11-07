import type { TranscriptArtifactRef } from "@orkestrator/protocol/transcript-artifacts";
import { sha256Bytes } from "@orkestrator/protocol/graphs/sha256";
import { STATIC_PRESENTATION_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { STATIC_HTML_PRESENTATION_RUNTIME_VERSION } from "@orkestrator/protocol/static-html-presentation";
import {
  StaleArtifactScopeError,
  artifactScopeKeyParts,
  isCurrentArtifactScopeGeneration,
  readWholeRepresentation,
  useScopedArtifactRead,
  type ArtifactReadScope,
  type ArtifactReader,
  type ArtifactRequestState,
} from "./artifact-requests";
import { useScopeBackend } from "@/hooks/useScopeBackend";
import { encodeRichKey } from "./rich-identity";

/**
 * Reads the complete effective HTML of one published `html-static` revision
 * and proves it is the document the receipt verified, before anything shows
 * it. `readWholeRepresentation` can return a partial result, so a settled read
 * does not establish that the document is whole: the checks below do. The
 * stored bytes are never rewritten from a browser's reserialized DOM.
 */

export type StaticDocumentFailure =
  "static_identity" | "static_incomplete" | "static_integrity" | "static_over_budget";

export class StaticDocumentError extends Error {
  constructor(
    readonly code: StaticDocumentFailure,
    message: string,
  ) {
    super(message);
    this.name = "StaticDocumentError";
  }
}

export interface VerifiedStaticDocument {
  html: string;
  sha256: string;
  byteLength: number;
}

function hex(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
  return text;
}

/**
 * Lower-case hex SHA-256. Web Crypto exists only in a secure context, and a
 * gateway on a plain-HTTP tailnet address is not one, so the pure helper is
 * the fallback rather than a reason to skip the check.
 */
export async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return hex(sha256Bytes(bytes));
  const copy = new Uint8Array(bytes);
  return hex(new Uint8Array(await subtle.digest("SHA-256", copy.buffer)));
}

export async function readVerifiedEffectiveHtml(
  reader: ArtifactReader,
  scope: ArtifactReadScope,
  artifactRef: Pick<TranscriptArtifactRef, "artifactId" | "revision" | "publicationId">,
  expectedSha256: string,
): Promise<VerifiedStaticDocument> {
  const budget = STATIC_PRESENTATION_POLICY.maxDocumentBytes;
  const result = await readWholeRepresentation(
    reader,
    scope,
    artifactRef.publicationId,
    "effective-html",
    undefined,
    { maxBytes: budget },
  );
  if (!isCurrentArtifactScopeGeneration(scope)) throw new StaleArtifactScopeError();
  if (
    result.artifactId !== artifactRef.artifactId ||
    result.revision !== artifactRef.revision ||
    result.representation !== "effective-html"
  ) {
    throw new StaticDocumentError(
      "static_identity",
      "The stored document names a different revision than this publication",
    );
  }
  if (result.encoding !== "utf8") {
    throw new StaticDocumentError("static_incomplete", "The stored document is not UTF-8 text");
  }
  // Before parsing, and before hashing bytes that could not be displayed.
  if (result.totalBytes > budget) {
    throw new StaticDocumentError(
      "static_over_budget",
      "The stored document exceeds the inline display budget",
    );
  }
  const bytes = new TextEncoder().encode(result.data);
  if (
    result.nextOffsetBytes !== null ||
    result.byteLength !== result.totalBytes ||
    bytes.byteLength !== result.totalBytes
  ) {
    throw new StaticDocumentError("static_incomplete", "The stored document was read only in part");
  }
  if (!expectedSha256 || result.sha256 !== expectedSha256) {
    throw new StaticDocumentError(
      "static_integrity",
      "The stored document does not match its verification receipt",
    );
  }
  const actual = await sha256HexOfBytes(bytes);
  if (!isCurrentArtifactScopeGeneration(scope)) throw new StaleArtifactScopeError();
  if (actual !== expectedSha256) {
    throw new StaticDocumentError(
      "static_integrity",
      "The received document does not match its verification receipt",
    );
  }
  return { html: result.data, sha256: actual, byteLength: bytes.byteLength };
}

/**
 * Scoped and cached under the usual artifact read identity, so the protected
 * content registry clears it with the conversation. Theme and width are
 * presentation state and are not part of the key.
 */
export function useVerifiedEffectiveHtml(
  scope: ArtifactReadScope | null,
  artifactRef: Pick<TranscriptArtifactRef, "artifactId" | "revision" | "publicationId">,
  expectedSha256: string,
  enabled: boolean,
): ArtifactRequestState<VerifiedStaticDocument> & { retry: () => void } {
  const nodeBackend = useScopeBackend();
  const key =
    enabled && scope
      ? encodeRichKey([
          "static-document",
          ...artifactScopeKeyParts(scope),
          artifactRef.publicationId,
          artifactRef.revision,
          expectedSha256,
          STATIC_HTML_PRESENTATION_RUNTIME_VERSION,
        ])
      : null;
  return useScopedArtifactRead(
    key,
    scope,
    () => readVerifiedEffectiveHtml(nodeBackend, scope!, artifactRef, expectedSha256),
    (value) => value.byteLength,
  );
}
