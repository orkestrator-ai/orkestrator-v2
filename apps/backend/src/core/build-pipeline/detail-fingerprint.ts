import { createHash } from "node:crypto";
import { extractBuildPipelineDetail } from "@orkestrator/protocol/build-pipeline-detail";

/**
 * The fingerprint of a control record's detail (the heavy, slow-changing
 * fields listed in `@orkestrator/protocol/build-pipeline-detail`), or `null`
 * when the snapshot's detail cannot be split exactly and so is never omitted.
 *
 * The value is opaque to clients: they echo it back as `knownDetailFingerprint`.
 * It covers the detail fields' values and which session each belongs to, so
 * any change to one of them yields a different fingerprint.
 */
export function buildPipelineDetailFingerprint(snapshot: unknown): string | null {
  const detail = extractBuildPipelineDetail(snapshot);
  if (!detail) return null;
  const digest = createHash("sha256").update(JSON.stringify(detail), "utf8").digest("base64url");
  return `d1-${digest.slice(0, 32)}`;
}
