/**
 * Extra helpers for the storage, quota, archive, sync, rollout, and
 * migration-compatibility suites. Builds on `web-annotation-test-support.ts`.
 */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  parseWebAnnotationError,
  type WebAnnotationErrorDetail,
  type WebAnnotationRequestOperation,
} from "@orkestrator/protocol/web-annotations";
import { fixtureDestination } from "@orkestrator/protocol/testing/web-annotations-fixtures";
import type { StorageDatabase } from "./storage-database.js";
import { openBackendDatabase } from "./storage-stores.js";
import type { WebAnnotationService } from "./web-annotation-service.js";
import { webAnnotationStoreName } from "./web-annotation-store-layout.js";
import {
  WEB_ANNOTATION_DRAFTS_FORMAT,
  WEB_ANNOTATION_DRAFTS_VERSION,
  persistManifest,
  recordDirectoryName,
  requestTextRecordId,
  type RequestTextRef,
  type WebAnnotationManifest,
} from "./web-annotation-storage-format.js";
import { ENV_A } from "./web-annotation-test-support.js";

export async function sendRequest(
  service: WebAnnotationService,
  annotationId: string,
  requestId: string,
  options: {
    environmentId?: string;
    operation?: WebAnnotationRequestOperation;
    instruction?: string;
  } = {},
) {
  const environmentId = options.environmentId ?? ENV_A;
  const { annotation } = await service.get(environmentId, annotationId);
  const preparation = await service.prepare({
    environmentId,
    operation: options.operation ?? "implement",
    destination: fixtureDestination,
    annotations: [
      {
        annotationId,
        expectedContentRevision: annotation.contentRevision,
        expectedCaptureId: annotation.currentCaptureId,
      },
    ],
    instruction: options.instruction ?? "",
  });
  return service.send({
    environmentId,
    preparationId: preparation.preparationId,
    requestId,
    bodyHash: preparation.bodyHash,
  });
}

/** The typed detail of a rejected promise (fails the test if it resolves). */
export async function rejectionDetail(
  promise: Promise<unknown>,
): Promise<{ detail: WebAnnotationErrorDetail | null; message: string }> {
  try {
    await promise;
  } catch (error) {
    return parseWebAnnotationError(error);
  }
  throw new Error("expected the operation to be rejected");
}

export function environmentDir(dataDir: string, environmentId = ENV_A): string {
  return join(dataDir, "web-annotations", environmentId);
}

export async function readJsonFile(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
}

/** Capture every console channel while `work` runs. */
export async function captureConsole(work: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((method) => console[method]);
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      lines.push(
        args
          .map((arg) =>
            typeof arg === "string"
              ? arg
              : arg instanceof Error
                ? `${arg.name}: ${arg.message}`
                : JSON.stringify(arg),
          )
          .join(" "),
      );
    };
  }
  try {
    await work();
  } finally {
    methods.forEach((method, index) => {
      console[method] = originals[index]!;
    });
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Database inspection. Each call opens its own connection, like another
// backend process sharing the data directory.

export function withDatabase<T>(dataDir: string, run: (database: StorageDatabase) => T): T {
  const database = openBackendDatabase(dataDir);
  try {
    return run(database);
  } finally {
    database.close();
  }
}

/**
 * The environment's committed store assembled as one value:
 * `{ meta: { state, migration }, annotations, requests, drafts, records, ... }`.
 */
export function readStoredEnvironment(
  dataDir: string,
  environmentId = ENV_A,
): Record<string, any> | undefined {
  return withDatabase(
    dataDir,
    (database) =>
      database.readStore(webAnnotationStoreName(environmentId))?.value as
        Record<string, any> | undefined,
  );
}

/** Overwrite one row with raw text (bit rot; never produced by the engine). */
export function damageStoredRow(
  dataDir: string,
  collection: string,
  key: string,
  raw: string,
  environmentId = ENV_A,
): void {
  withDatabase(dataDir, (database) =>
    database.transaction(() => {
      const rows = database.rows(webAnnotationStoreName(environmentId));
      if (!rows.has(key, collection)) throw new Error(`no ${collection} row ${key}`);
      rows.put(key, raw, { collection });
    }),
  );
}

export function legacyRecordPath(
  dataDir: string,
  id: string,
  revision = 1,
  environmentId = ENV_A,
): string {
  return join(
    environmentDir(dataDir, environmentId),
    "records",
    recordDirectoryName(id),
    `${revision}.json`,
  );
}

/**
 * Write what the file-based engine (format 2) persisted for the state a
 * service built: `manifest.json`, `drafts.json`, `records/` (with request
 * text as `request-text` records) and the asset files, into `targetDir`, a
 * data directory without a database. Opening it exercises the real import.
 */
export async function exportLegacyEnvironment(
  service: WebAnnotationService,
  targetDir: string,
  options: { environmentId?: string; previous?: boolean } = {},
): Promise<void> {
  const environmentId = options.environmentId ?? ENV_A;
  const store = await service.storage.environment(environmentId);
  const manifest = structuredClone(store.manifest) as WebAnnotationManifest;
  const rows = service.storage
    .database()
    .rows(webAnnotationStoreName(environmentId))
    .list({ collection: "records" })
    .map((row) => ({ key: row.key, value: row.value! }));
  const dir = environmentDir(targetDir, environmentId);
  const writeRecord = async (kind: string, id: string, revision: number, value: unknown) => {
    const json = JSON.stringify({ kind, id, revision, value });
    const path = legacyRecordPath(targetDir, id, revision, environmentId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, json);
    return Buffer.byteLength(json);
  };
  let recordBytes = 0;
  let draftRecordBytes = 0;
  for (const row of rows) {
    const slash = row.key.lastIndexOf("/");
    const parsed = JSON.parse(row.value) as { kind: string; value: unknown };
    const bytes = await writeRecord(
      parsed.kind,
      row.key.slice(0, slash),
      Number(row.key.slice(slash + 1)),
      parsed.value,
    );
    if (parsed.kind === "draft") draftRecordBytes += bytes;
    else recordBytes += bytes;
  }
  const textRefs = new Map<string, RequestTextRef | null>();
  for (const request of Object.values(manifest.requests)) {
    const bytes = await writeRecord("request-text", requestTextRecordId(request.id), 1, {
      instruction: request.instruction,
      response: request.response,
    });
    recordBytes += bytes;
    textRefs.set(request.id, { revision: 1, bytes });
  }
  manifest.usage = { recordBytes };
  const persisted = JSON.stringify(persistManifest(manifest, textRefs));
  const drafts = JSON.stringify({
    format: WEB_ANNOTATION_DRAFTS_FORMAT,
    version: WEB_ANNOTATION_DRAFTS_VERSION,
    environmentId,
    sequence: 1,
    drafts: manifest.drafts,
    recordBytes: draftRecordBytes,
  });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "manifest.json"), persisted);
  await writeFile(join(dir, "drafts.json"), drafts);
  if (options.previous) {
    await writeFile(join(dir, "manifest.prev.json"), persisted);
    await writeFile(join(dir, "drafts.prev.json"), drafts);
  }
  await cp(join(service.storage.root, environmentId, "assets"), join(dir, "assets"), {
    recursive: true,
  }).catch(() => undefined);
}
