import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  isProviderEvidenceFrame,
  workspaceObservationReportIssues,
  type ChangeEvidenceEntry,
} from "@orkestrator/protocol/change-evidence";
import {
  collectBodyIds,
  DEFAULT_EVIDENCE_SPOOL_LIMITS as limits,
  evidenceBodyId,
} from "@orkestrator/protocol/node/change-tracking/evidence-spool";

function readBounded(path: string, limit: number): Buffer {
  if (statSync(path).size > limit) throw new Error("Evidence migration exceeds storage capacity");
  const bytes = readFileSync(path);
  if (bytes.length > limit) throw new Error("Evidence migration exceeds storage capacity");
  return bytes;
}

function publishFile(path: string, contents: string | Buffer): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Startup-only import, before either spool can append. Publish bodies first,
 * then atomically publish the entry union, then retire the legacy entry file.
 * A crash at any boundary can repeat the import using stable frame/report ids.
 * Refuse conflicts or capacity overflow rather than lose unacknowledged data.
 */
export function migrateCodexChangeEvidence(legacy: string, shared: string): void {
  if (resolve(legacy) === resolve(shared)) return;
  const legacyFile = join(legacy, "entries.jsonl");
  if (!existsSync(legacyFile)) return;
  const entries = new Map<string, ChangeEvidenceEntry>();
  const bodyIds = new Set<string>();
  for (const directory of [shared, legacy]) {
    const file = join(directory, "entries.jsonl");
    if (!existsSync(file)) continue;
    for (const line of readBounded(file, limits.maxQueuedBytes).toString("utf8").split("\n")) {
      if (!line) continue;
      const entry = (JSON.parse(line) as { entry?: ChangeEvidenceEntry }).entry;
      let identity: string;
      if (entry?.type === "frame" && isProviderEvidenceFrame(entry.frame)) {
        identity = `frame:${entry.frame.frameId}`;
        for (const id of collectBodyIds(entry.frame)) bodyIds.add(id);
      } else if (
        entry?.type === "observation" &&
        workspaceObservationReportIssues(entry.report).length === 0
      ) {
        identity = `observation:${entry.report.reportId}`;
      } else {
        throw new Error("Evidence migration encountered an invalid entry");
      }
      const normalized = { ...entry, seq: 0 };
      const existing = entries.get(identity);
      if (existing && !isDeepStrictEqual(existing, normalized)) {
        throw new Error("Evidence migration encountered conflicting identities");
      }
      entries.set(identity, normalized);
    }
  }
  const lines = [...entries.values()].map((entry, index) => {
    const serialized = JSON.stringify({ ...entry, seq: index + 1 });
    if (serialized.length > limits.maxEntryBytes) {
      throw new Error("Evidence migration exceeds entry capacity");
    }
    return JSON.stringify({ entry: { ...entry, seq: index + 1 } });
  });
  const contents = lines.length ? `${lines.join("\n")}\n` : "";
  if (entries.size >= limits.maxEntries || Buffer.byteLength(contents) > limits.maxQueuedBytes) {
    throw new Error("Evidence migration exceeds queue capacity");
  }
  mkdirSync(join(shared, "bodies"), { recursive: true, mode: 0o700 });
  let bodyBytes = 0;
  for (const id of bodyIds) {
    const name = id.replace(/[^A-Za-z0-9]/g, "_");
    const target = join(shared, "bodies", name);
    const bytes = readBounded(
      existsSync(target) ? target : join(legacy, "bodies", name),
      limits.maxSingleBodyBytes,
    );
    if (evidenceBodyId(bytes) !== id) throw new Error("Evidence migration body integrity failed");
    bodyBytes += bytes.length;
    if (bodyBytes > limits.maxBodyBytes)
      throw new Error("Evidence migration exceeds body capacity");
    if (!existsSync(target)) publishFile(target, bytes);
  }
  // Restoration loads bodies before entries. Remove crash leftovers that
  // neither spool references so they cannot consume the import's body budget.
  const retainedNames = new Set([...bodyIds].map((id) => id.replace(/[^A-Za-z0-9]/g, "_")));
  for (const name of readdirSync(join(shared, "bodies"))) {
    if (/^sha256_[a-f0-9]{64}$/.test(name) && !retainedNames.has(name)) {
      rmSync(join(shared, "bodies", name));
    }
  }
  publishFile(join(shared, "entries.jsonl"), contents);
  rmSync(legacyFile);
}
