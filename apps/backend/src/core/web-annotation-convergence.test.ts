/**
 * Step 03 completion: two authenticated clients converge after concurrent
 * changes, disconnects, ring expiry, and a backend restart, using only the
 * public contract (hints as invalidations, `web_annotations_changes`, and
 * snapshots). Also: snapshots racing create/edit/delete, and logs that never
 * carry annotation content.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  WEB_ANNOTATION_LIMITS,
  WEB_ANNOTATIONS_CHANGED_EVENT,
  type WebAnnotationChangeHint,
} from "@orkestrator/protocol/web-annotations";
import { fixtureCaptureInput } from "@orkestrator/protocol/web-annotations-fixtures";
import { recordDirectoryName } from "./web-annotation-storage.js";
import type { WebAnnotationService } from "./web-annotation-service.js";
import {
  ENV_A,
  createAnnotation,
  createHarness,
  makePng,
  type ServiceHarness,
} from "./web-annotation-test-support.js";
import { captureConsole, environmentDir, sendRequest } from "./web-annotation-test-helpers.js";

let harness: ServiceHarness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

interface CachedItem {
  metadataRevision: number;
  contentRevision: number;
  title: string;
  state: string;
}

/** A client that follows the step 03 sync protocol against one environment. */
class SimulatedClient {
  readonly cache = new Map<string, CachedItem>();
  revision = -1;
  generation = "";
  connected = true;
  snapshots = 0;
  resets = 0;
  private buffered: WebAnnotationChangeHint[] = [];

  constructor(private service: () => WebAnnotationService) {}

  /** Transport delivery (subscribed before any fetch). */
  deliver(hint: WebAnnotationChangeHint): void {
    if (this.connected && hint.environmentId === ENV_A) this.buffered.push(hint);
  }

  private async refetch(ids: Iterable<string>): Promise<void> {
    for (const id of ids) {
      try {
        const { annotation } = await this.service().get(ENV_A, id, 1);
        if (annotation.state === "deleted") this.cache.delete(id);
        else this.cache.set(id, project(annotation));
      } catch {
        this.cache.delete(id);
      }
    }
  }

  /** Full snapshot with small pages; a concurrent change restarts it. */
  async snapshot(): Promise<void> {
    this.snapshots++;
    for (let attempt = 0; attempt < 20; attempt++) {
      const items = new Map<string, CachedItem>();
      let cursor: string | undefined;
      let revision = -1;
      let generation = "";
      try {
        do {
          const page = await this.service().list({
            environmentId: ENV_A,
            filter: { state: "all", includeHidden: true },
            limit: 2,
            ...(cursor ? { cursor } : {}),
          });
          if (revision < 0) {
            revision = page.revision;
            generation = page.generation;
          }
          for (const item of page.items) items.set(item.id, project(item));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
      } catch {
        continue; // The list changed during pagination: refresh from the first page.
      }
      this.cache.clear();
      for (const [id, item] of items) this.cache.set(id, item);
      this.revision = revision;
      this.generation = generation;
      return;
    }
    throw new Error("snapshot never stabilized");
  }

  /** Apply buffered hints; gaps and new generations are repaired. */
  async sync(): Promise<void> {
    if (!this.connected) return;
    if (this.revision < 0) await this.snapshot();
    const hints = this.buffered.splice(0).sort((a, b) => a.revision - b.revision);
    for (const hint of hints) {
      if (hint.generation !== this.generation || hint.reset) {
        this.resets++;
        await this.snapshot();
        continue;
      }
      if (hint.revision <= this.revision) continue;
      if (hint.revision !== this.revision + 1) {
        await this.catchUp();
        continue;
      }
      await this.refetch([...hint.annotationIds]);
      this.revision = hint.revision;
    }
    // Periodic reconciliation: recovers a lost final hint.
    await this.catchUp();
  }

  async catchUp(): Promise<void> {
    const changes = await this.service().changes(ENV_A, this.generation, this.revision);
    if (changes.resetRequired) {
      this.resets++;
      await this.snapshot();
      return;
    }
    for (const change of changes.changes) await this.refetch(change.annotationIds);
    this.revision = Math.max(this.revision, changes.revision);
  }

  reconnect(): void {
    this.connected = true;
  }
}

function project(annotation: {
  metadataRevision: number;
  contentRevision: number;
  title: string;
  state: string;
}): CachedItem {
  return {
    metadataRevision: annotation.metadataRevision,
    contentRevision: annotation.contentRevision,
    title: annotation.title,
    state: annotation.state,
  };
}

async function authoritative(service: WebAnnotationService): Promise<Map<string, CachedItem>> {
  const out = new Map<string, CachedItem>();
  let cursor: string | undefined;
  do {
    const page = await service.list({
      environmentId: ENV_A,
      filter: { state: "all", includeHidden: true },
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.items) out.set(item.id, project(item));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return out;
}

async function setup() {
  const clients: SimulatedClient[] = [];
  harness = await createHarness({
    emit: (event, payload) => {
      if (event !== WEB_ANNOTATIONS_CHANGED_EVENT) return;
      for (const client of clients) client.deliver(payload as WebAnnotationChangeHint);
    },
  });
  const current = () => harness!.service;
  const a = new SimulatedClient(current);
  const b = new SimulatedClient(current);
  clients.push(a, b);
  return { a, b, clients };
}

async function append(service: WebAnnotationService, annotationId: string, body: string) {
  const { annotation } = await service.get(ENV_A, annotationId, 1);
  return service.appendEntryCommand({
    environmentId: ENV_A,
    operationId: `op-${body.replace(/[^A-Za-z0-9]/g, "-")}`,
    annotationId,
    expectedContentRevision: annotation.contentRevision,
    body,
  });
}

describe("two clients converge", () => {
  test("after concurrent changes, a disconnect, and a backend restart", async () => {
    const { a, b } = await setup();
    await Promise.all([a.sync(), b.sync()]);
    const first = await createAnnotation(harness!.service, ENV_A, "from A", "op-a1");
    const second = await createAnnotation(harness!.service, ENV_A, "from B", "op-b1");
    await Promise.all([a.sync(), b.sync()]);
    expect(a.cache).toEqual(await authoritative(harness!.service));

    // B loses its connection while both clients keep writing concurrently.
    b.connected = false;
    await Promise.all([
      append(harness!.service, first.annotationId, "A edits"),
      append(harness!.service, second.annotationId, "B edits"),
      createAnnotation(harness!.service, ENV_A, "from A again", "op-a2"),
    ]);
    const { annotation } = await harness!.service.get(ENV_A, second.annotationId, 1);
    await harness!.service.delete({
      environmentId: ENV_A,
      operationId: "op-del",
      annotationId: second.annotationId,
      expectedMetadataRevision: annotation.metadataRevision,
    });
    await a.sync();
    b.reconnect();
    await b.sync(); // No hints were buffered: the revision check repairs it.
    const truth = await authoritative(harness!.service);
    expect(a.cache).toEqual(truth);
    expect(b.cache).toEqual(truth);
    expect(b.cache.has(second.annotationId)).toBe(false);

    // A backend restart is a new generation: both clients reset and converge.
    await harness!.restart();
    await createAnnotation(harness!.service, ENV_A, "after restart", "op-r1");
    await Promise.all([a.sync(), b.sync()]);
    const afterRestart = await authoritative(harness!.service);
    expect(a.cache).toEqual(afterRestart);
    expect(b.cache).toEqual(afterRestart);
    expect(a.generation).toBe(harness!.service.generation);
    expect(a.resets + b.resets).toBeGreaterThanOrEqual(2);
  });

  test("a disconnect longer than the hint ring falls back to a snapshot", async () => {
    const { a, b } = await setup();
    await Promise.all([a.sync(), b.sync()]);
    b.connected = false;
    const receipt = await createAnnotation(harness!.service, ENV_A, "busy note", "op-busy");
    for (let index = 0; index < WEB_ANNOTATION_LIMITS.hintRingEntries + 4; index++) {
      await harness!.service.update({
        environmentId: ENV_A,
        operationId: `op-hide-${index}`,
        annotationId: receipt.annotationId,
        expectedMetadataRevision: 1 + index,
        hidden: index % 2 === 0,
      });
    }
    await a.sync();
    b.reconnect();
    const snapshotsBefore = b.snapshots;
    await b.sync();
    expect(b.snapshots).toBe(snapshotsBefore + 1);
    const truth = await authoritative(harness!.service);
    expect(a.cache).toEqual(truth);
    expect(b.cache).toEqual(truth);
  });
});

describe("snapshot races", () => {
  test("a snapshot racing create, edit, and delete converges to committed state", async () => {
    const { a } = await setup();
    const seeded = [];
    for (let index = 0; index < 5; index++) {
      seeded.push(await createAnnotation(harness!.service, ENV_A, `seed ${index}`, `op-s${index}`));
    }
    const target = seeded[2]!;
    const doomed = seeded[4]!;
    const { annotation } = await harness!.service.get(ENV_A, doomed.annotationId, 1);
    // Subscribed before fetching: hints buffer while the snapshot pages.
    await Promise.all([
      a.snapshot(),
      createAnnotation(harness!.service, ENV_A, "raced create", "op-race"),
      append(harness!.service, target.annotationId, "raced edit"),
      harness!.service.delete({
        environmentId: ENV_A,
        operationId: "op-race-del",
        annotationId: doomed.annotationId,
        expectedMetadataRevision: annotation.metadataRevision,
      }),
    ]);
    await a.sync();
    const truth = await authoritative(harness!.service);
    expect(a.cache).toEqual(truth);
    expect(a.cache.has(doomed.annotationId)).toBe(false);
    expect(a.cache.get(target.annotationId)?.contentRevision).toBe(2);
    // Nothing from another environment leaks into the projection.
    await createAnnotation(harness!.service, "env-b", "other environment", "op-other");
    await a.sync();
    expect(a.cache).toEqual(await authoritative(harness!.service));
  });
});

describe("content-free logs", () => {
  test("no annotation content, paths, or URLs reach any console channel", async () => {
    const secrets = [
      "SECRET-BODY-91c2",
      "SECRET-INSTRUCTION-4e7d",
      "SECRET-DRAFT-0b3f",
      "SECRET-LEGACY-COMMENT-a55e",
      "SECRET-LEGACY-TEXT-77aa",
    ];
    let dataDir = "";
    const output = await captureConsole(async () => {
      harness = await createHarness();
      dataDir = harness.dir;
      const service = harness.service;
      const receipt = await service.create({
        environmentId: ENV_A,
        operationId: "op-secret",
        capture: {
          ...fixtureCaptureInput("element"),
          evidence: {
            text: "SECRET-BODY-91c2 page text",
            attributes: {},
            styles: {},
            hierarchy: [],
            html: "<button>SECRET-BODY-91c2</button>",
          },
        },
        body: "SECRET-BODY-91c2 please fix",
      });
      await service.saveDraft({
        environmentId: ENV_A,
        editorId: "ed-secret",
        expectedRevision: 0,
        text: "SECRET-DRAFT-0b3f",
      });
      harness.dispatch.publishFailures = 1;
      await sendRequest(service, receipt.annotationId, "req-secret", {
        instruction: "SECRET-INSTRUCTION-4e7d",
      });
      await service.reconcileOnce();
      // Rejected payloads and conflicts.
      await service
        .appendEntryCommand({
          environmentId: ENV_A,
          operationId: "op-stale",
          annotationId: receipt.annotationId,
          expectedContentRevision: 99,
          body: "SECRET-BODY-91c2 stale",
        })
        .catch(() => undefined);
      await service
        .stageAsset({
          environmentId: ENV_A,
          operationId: "op-bad",
          mediaType: "image/png",
          data: Buffer.from("SECRET-BODY-91c2").toString("base64"),
        })
        .catch(() => undefined);
      // A migration where one draft fails and one has an unreadable screenshot.
      harness.host.putDraft(`claude:${ENV_A}:${encodeURIComponent(`env-${ENV_A}:tab-1`)}`, ENV_A, {
        text: "SECRET-DRAFT-0b3f",
        annotations: [
          {
            id: "legacy-secret",
            source: "browser",
            text: "SECRET-LEGACY-TEXT-77aa",
            comment: "SECRET-LEGACY-COMMENT-a55e",
            screenshotPath: `${dataDir}/missing/SECRET-LEGACY-TEXT-77aa.png`,
          },
        ],
        attachments: [],
      });
      harness.host.onGetDraft = () => {
        throw new Error("SECRET-LEGACY-COMMENT-a55e while reading");
      };
      await service.migrate(ENV_A).catch(() => undefined);
      harness.host.onGetDraft = null;
      // Damaged records and degraded storage at startup.
      const recordsDir = join(environmentDir(dataDir), "records");
      await writeFile(
        join(recordsDir, recordDirectoryName(receipt.captureId!), "1.json"),
        "{ SECRET-BODY-91c2",
      );
      const restarted = await harness.restart();
      await restarted.get(ENV_A, receipt.annotationId);
      await writeFile(join(environmentDir(dataDir), "manifest.json"), "SECRET-BODY-91c2");
      const degraded = await harness.restart();
      await degraded.capabilities(ENV_A);
      await degraded.collectGarbage(ENV_A).catch(() => undefined);
      await degraded
        .stageAsset({
          environmentId: ENV_A,
          operationId: "op-img",
          mediaType: "image/png",
          data: makePng().toString("base64"),
        })
        .catch(() => undefined);
    });
    expect(output.length).toBeGreaterThan(0); // The scenario did log.
    for (const secret of secrets) expect(output).not.toContain(secret);
    expect(output).not.toContain(dataDir);
    expect(output).not.toContain("localhost");
    expect(output).not.toContain("/settings");
    // Metrics are content-free too.
    const metrics = JSON.stringify(harness!.service.metrics.snapshot());
    for (const secret of secrets) expect(metrics).not.toContain(secret);
    expect(metrics).not.toContain("req-secret");
    expect(metrics).not.toContain("annotation-");
  });
});
