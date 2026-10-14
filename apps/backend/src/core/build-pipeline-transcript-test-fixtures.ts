import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  BUILD_PIPELINE_TRANSCRIPT_NAMESPACE,
  transcriptPipelineTag,
  transcriptSessionKey,
} from "./build-pipeline-transcript-store.js";
import {
  KEYED_RECORD_FORMAT,
  encodeRecordFile,
  recordFileStem,
  sha256Hex,
} from "./keyed-record-format.js";
import { transcriptFingerprint } from "./build-pipeline-service-helpers.js";

/**
 * Test fixture: writes one session transcript in the pre-database file format
 * (`manifests/<stem>.rec` or `.prev`, an `_meta/index.json`, and two chunk
 * files), exactly as the keyed-record transcript store left it on disk.
 * Returns the session's manifest row key.
 */
export async function writeLegacyTranscriptSession(
  directory: string,
  pipelineId: string,
  sessionKey: string,
  body: unknown[],
  options: { revision?: number; generation?: ".rec" | ".prev"; sdkSessionId?: string } = {},
): Promise<string> {
  const key = transcriptSessionKey(pipelineId, sessionKey);
  const stem = recordFileStem(BUILD_PIPELINE_TRANSCRIPT_NAMESPACE, key);
  await fs.mkdir(path.join(directory, "chunks"), { recursive: true });
  await fs.mkdir(path.join(directory, "manifests", "_meta"), { recursive: true });
  const halves = [
    body.slice(0, Math.ceil(body.length / 2)),
    body.slice(Math.ceil(body.length / 2)),
  ].filter((half) => half.length > 0);
  const chunks = [];
  for (const half of halves) {
    const bytes = Buffer.from(`[${half.map((entry) => JSON.stringify(entry)).join(",")}]`);
    const checksum = sha256Hex(bytes);
    const name = `${stem}-${checksum}.chunk`;
    await fs.writeFile(path.join(directory, "chunks", name), bytes);
    chunks.push({ name, length: bytes.length, checksum });
  }
  const serialized = body.map((entry) => JSON.stringify(entry));
  const digest = (() => {
    const hash = createHash("sha256");
    hash.update(String(serialized.length));
    for (const item of serialized) {
      hash.update("\0");
      hash.update(item);
    }
    return hash.digest("hex");
  })();
  const revision = options.revision ?? 1;
  const manifest = {
    format: "ork-record-manifest-v1",
    chunks,
    totalBytes: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    meta: {
      v: 1,
      sdkSessionId: options.sdkSessionId ?? `sdk-${sessionKey}`,
      revision,
      fingerprint: transcriptFingerprint(body),
      contentDigest: digest,
      messageCount: body.length,
      counts: halves.map((half) => half.length),
      bytes: serialized.reduce((sum, item) => sum + Buffer.byteLength(item) + 1, 0),
      omittedMessages: 0,
      committedAt: "2026-09-01T00:00:00.000Z",
    },
  };
  const payload = Buffer.from(JSON.stringify(manifest));
  const header = {
    format: KEYED_RECORD_FORMAT as typeof KEYED_RECORD_FORMAT,
    schema: "build-pipeline-transcript-v1+manifest",
    key,
    owner: { pipeline: transcriptPipelineTag(pipelineId) },
    revision,
    byteLength: payload.length,
    checksum: sha256Hex(payload),
    retentionClass: "durable" as const,
    updatedAt: Date.now(),
    accountedBytes: manifest.totalBytes + payload.length,
  };
  await fs.writeFile(
    path.join(directory, "manifests", `${stem}${options.generation ?? ".rec"}`),
    encodeRecordFile(header, payload),
  );
  await fs.writeFile(path.join(directory, "manifests", "_meta", "index.json"), "{}");
  return key;
}
