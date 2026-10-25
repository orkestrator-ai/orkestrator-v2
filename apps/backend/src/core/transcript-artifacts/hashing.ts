/**
 * Domain-separated SHA-256 identities for transcript artifacts.
 *
 * Every identity hashes a versioned label, a NUL separator and a canonical
 * encoding, so a source hash can never collide with a manifest, receipt or
 * snapshot hash of the same bytes. HTML and Mermaid strings are hashed as
 * their exact UTF-8 inside canonical JSON (string escaping is fixed by
 * `JSON.stringify`). Clients never nominate these values.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@orkestrator/protocol/canonical-json";
import type {
  ArtifactAssetRecord,
  ArtifactDiagnostic,
  ArtifactKind,
  ArtifactPayload,
  ArtifactProbeV1,
  ArtifactVerificationIdentity,
} from "@orkestrator/protocol/transcript-artifacts";
import type { WorkflowSnapshotV1 } from "@orkestrator/protocol/workflow-snapshot";

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function domainHash(domain: string, ...parts: string[]): string {
  const hash = createHash("sha256");
  hash.update(domain);
  for (const part of parts) {
    hash.update("\0");
    hash.update(part, "utf8");
  }
  return hash.digest("hex");
}

/** `SHA256("artifact-source:v1\0" + kind + "\0" + canonicalJSON(payload))`. */
export function artifactSourceHash(kind: ArtifactKind, payload: ArtifactPayload): string {
  return domainHash("artifact-source:v1", kind, canonicalJson(payload));
}

/** Manifest identity over (name, sha256, mimeType, byteLength), ordered by name. */
export function assetManifestHash(assets: readonly ArtifactAssetRecord[]): string {
  const entries = [...assets]
    .map((asset) => ({
      name: asset.name,
      sha256: asset.sha256,
      mimeType: asset.mimeType,
      byteLength: asset.byteLength,
    }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return domainHash("artifact-assets:v1", canonicalJson(entries));
}

/** `inputHash = SHA256("artifact-verification:v1\0" + canonicalJSON(identity))`. */
export function verificationInputHash(identity: ArtifactVerificationIdentity): string {
  return sha256Hex(`artifact-verification:v1\0${canonicalJson(identity)}`);
}

export function diagnosticsHash(diagnostics: readonly ArtifactDiagnostic[]): string {
  return domainHash("artifact-diagnostics:v1", canonicalJson(diagnostics));
}

export function snapshotHash(snapshot: WorkflowSnapshotV1): string {
  return domainHash("workflow-snapshot:v1", canonicalJson(snapshot));
}

export function probesHash(probes: readonly ArtifactProbeV1[]): string {
  return domainHash("artifact-probes:v1", canonicalJson(probes));
}

/**
 * Identity of the theme tokens a renderer resolves for a theme. The tokens are
 * application-owned and versioned with the renderer, so the version label and
 * the token table together identify them.
 */
export function themeTokensHash(renderer: string, tokens: unknown): string {
  return domainHash("artifact-theme-tokens:v1", renderer, canonicalJson(tokens));
}

/** Digest of canonical semantic request arguments (credentials excluded by the caller). */
export function requestDigest(operationKind: string, args: unknown): string {
  return domainHash("artifact-request:v1", operationKind, canonicalJson(args));
}

/** Stable, non-reversible key for an idempotency row. */
export function idempotencyKey(
  conversationKey: string,
  operationKind: string,
  requestKey: string,
): string {
  return domainHash("artifact-idempotency:v1", conversationKey, operationKind, requestKey);
}

export function shortDigest(...parts: string[]): string {
  return domainHash("artifact-key:v1", ...parts).slice(0, 32);
}
