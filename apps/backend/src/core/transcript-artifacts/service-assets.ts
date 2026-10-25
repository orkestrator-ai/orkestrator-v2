/**
 * Staged uploads for artifact assets: the narrow, authenticated way bytes a
 * person attaches in the UI become usable as `draft.assets[].assetRef`.
 *
 * `transcript_artifact_stage_asset` takes bounded base64 bytes from the
 * renderer for one conversation (`environmentId` + `logicalSessionKey`),
 * checks the declared MIME type against the bytes' magic numbers, stores them
 * content-addressed in that environment's artifact asset store (quota
 * accounted, nothing evicted) and records a staged reference owned by that
 * conversation. The returned `assetRef` (`stg-<32 hex>`) resolves only for the
 * same owner; any other caller gets the same "unknown asset reference" as a
 * reference that never existed. Nothing here reads a filesystem path, fetches
 * a URL or interprets a provider filename.
 *
 * Staged references expire with unpublished drafts (seven days); revisions
 * that used one keep their own reference to the content-addressed bytes.
 */
import { randomBytes } from "node:crypto";
import {
  ARTIFACT_RETENTION_POLICY,
  INTERACTIVE_HTML_POLICY,
} from "@orkestrator/protocol/rich-content-policy";
import type {
  ArtifactStageAssetRequest,
  ArtifactStageAssetResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import {
  ARTIFACT_ASSET_NAME_PATTERN,
  ArtifactFailure,
  artifactError,
  type ArtifactOwner,
} from "@orkestrator/protocol/transcript-artifacts";
import { notFound, ownsRecord } from "./owner.js";
import { assertConversationLive, type ArtifactServiceContext } from "./service-context.js";
import type { StoredStagedAsset } from "./store-records.js";

export const STAGED_ASSET_ID = /^stg-[0-9a-f]{32}$/;
export const MAX_STAGED_ASSETS_PER_CONVERSATION = 64;
export const STAGED_ASSET_TTL_MS = ARTIFACT_RETENTION_POLICY.unpublishedDraftMs;
/** Largest base64 text accepted for one staged asset (the decoded bound, encoded). */
export const MAX_STAGED_BASE64_LENGTH =
  Math.ceil(INTERACTIVE_HTML_POLICY.maxAssetBytesTotal / 3) * 4;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, index) => bytes[offset + index] === byte);
const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

function utf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Binary formats recognised by magic number. */
const BINARY_SIGNATURES: Record<string, (bytes: Uint8Array) => boolean> = {
  "image/png": (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  "image/gif": (b) => startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a")),
  "image/webp": (b) => startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8),
  "font/woff2": (b) => startsWith(b, ascii("wOF2")),
};

/** The MIME types an artifact may embed (kept equal to the authoring allowlist). */
export const STAGEABLE_MIME_TYPES: readonly string[] = Object.freeze([
  ...Object.keys(BINARY_SIGNATURES),
  "image/svg+xml",
  "application/json",
  "text/csv",
  "text/plain",
]);

/**
 * True when the bytes are what `mimeType` claims. Binary types need their
 * magic number; text types must be valid UTF-8 without NUL bytes and must not
 * carry a binary signature (an image renamed `.txt` is refused).
 */
export function sniffMatches(mimeType: string, bytes: Uint8Array): boolean {
  const binary = BINARY_SIGNATURES[mimeType];
  if (binary) return binary(bytes);
  if (Object.values(BINARY_SIGNATURES).some((matches) => matches(bytes))) return false;
  const text = utf8(bytes);
  if (text === null || text.includes("\u0000")) return false;
  switch (mimeType) {
    case "image/svg+xml":
      return /<svg[\s>]/i.test(text.slice(0, 4096));
    case "application/json":
      try {
        JSON.parse(text);
        return true;
      } catch {
        return false;
      }
    case "text/csv":
    case "text/plain":
      return true;
    default:
      return false;
  }
}

function invalid(path: string, code: string, message: string): ArtifactFailure {
  return new ArtifactFailure(
    artifactError(code === "mime_mismatch" ? "policy_denied" : "invalid_input", message, {
      fieldErrors: [{ path, code, message }],
    }),
  );
}

export class ArtifactAssetStaging {
  constructor(
    private readonly ctx: ArtifactServiceContext,
    private readonly environmentProject: (environmentId: string) => Promise<string | null>,
  ) {}

  async stage(request: ArtifactStageAssetRequest): Promise<ArtifactStageAssetResponse> {
    if (typeof request.environmentId !== "string" || typeof request.logicalSessionKey !== "string")
      throw notFound("Conversation");
    if (typeof request.name !== "string" || !ARTIFACT_ASSET_NAME_PATTERN.test(request.name))
      throw invalid("name", "pattern", "Asset names use letters, digits, '.', '_' and '-' only");
    if (typeof request.mimeType !== "string" || !STAGEABLE_MIME_TYPES.includes(request.mimeType))
      throw invalid("mimeType", "mime_type", "This asset type is not permitted");
    const data = request.dataBase64;
    if (typeof data !== "string" || data.length === 0)
      throw invalid("dataBase64", "type", "Expected non-empty base64 data");
    if (data.length > MAX_STAGED_BASE64_LENGTH) {
      throw new ArtifactFailure(
        artifactError(
          "package_size_exceeded",
          `Assets are limited to ${INTERACTIVE_HTML_POLICY.maxAssetBytesTotal} bytes`,
          { resource: "asset-bytes" },
        ),
      );
    }
    if (data.length % 4 !== 0 || !BASE64.test(data))
      throw invalid("dataBase64", "encoding", "Expected standard padded base64");
    const bytes = new Uint8Array(Buffer.from(data, "base64"));
    if (bytes.byteLength === 0 || bytes.byteLength > INTERACTIVE_HTML_POLICY.maxAssetBytesTotal)
      throw invalid("dataBase64", "size", "The asset is empty or too large");
    if (!sniffMatches(request.mimeType, bytes))
      throw invalid("mimeType", "mime_mismatch", "The bytes do not match the declared type");
    const projectId = await this.environmentProject(request.environmentId).catch(() => null);
    if (!projectId) throw notFound("Conversation");
    if (this.ctx.store.isDeleted(request.environmentId)) throw notFound("Conversation");
    const owner: ArtifactOwner = {
      backendId: this.ctx.backendId(),
      environmentId: request.environmentId,
      projectId,
      conversationKey: request.logicalSessionKey,
    };
    const written = await this.ctx.store.writeAsset(owner.environmentId, bytes);
    try {
      return this.ctx.store.transact(owner.environmentId, (records) => {
        assertConversationLive(records, owner.conversationKey);
        const nowMs = this.ctx.now();
        const live = records
          .list("staged", { owner: owner.conversationKey })
          .filter((row) => nowMs - Date.parse(row.createdAt) < STAGED_ASSET_TTL_MS);
        if (live.length >= MAX_STAGED_ASSETS_PER_CONVERSATION) {
          throw new ArtifactFailure(
            artifactError("capacity_exceeded", "This conversation has too many staged assets", {
              resource: "staged-assets",
              retryClass: "never",
              suggestion: "Use the assets already staged, or let unused ones expire.",
            }),
          );
        }
        const now = new Date(nowMs).toISOString();
        this.ctx.store.registerAssetsInTransaction(
          records,
          [{ sha256: written.sha256, byteLength: written.byteLength, mimeType: request.mimeType }],
          now,
        );
        const row: StoredStagedAsset = {
          schemaVersion: 1,
          stagedId: `stg-${randomBytes(16).toString("hex")}`,
          owner,
          name: request.name,
          mimeType: request.mimeType,
          sha256: written.sha256,
          byteLength: written.byteLength,
          createdAt: now,
        };
        records.put("staged", row.stagedId, row, owner.conversationKey);
        return {
          assetRef: row.stagedId,
          sha256: row.sha256,
          byteLength: row.byteLength,
          mimeType: row.mimeType,
          expiresAt: new Date(nowMs + STAGED_ASSET_TTL_MS).toISOString(),
        };
      });
    } finally {
      written.release();
    }
  }

  /**
   * The `ArtifactAssetResolver` for staged references: bytes (re-hashed on
   * read) of a staged id the same owner created, or null for anything else.
   */
  async resolve(
    owner: ArtifactOwner,
    assetRef: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    if (typeof assetRef !== "string" || !STAGED_ASSET_ID.test(assetRef)) return null;
    let row: StoredStagedAsset | null;
    try {
      row = this.ctx.store.records(owner.environmentId).get("staged", assetRef);
    } catch {
      return null;
    }
    if (!row || !ownsRecord(owner, row)) return null;
    if (this.ctx.now() - Date.parse(row.createdAt) >= STAGED_ASSET_TTL_MS) return null;
    const bytes = await this.ctx.store.readAsset(owner.environmentId, row.sha256, row.byteLength);
    return { bytes: new Uint8Array(bytes), mimeType: row.mimeType };
  }
}
