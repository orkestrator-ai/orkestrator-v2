import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  WEB_ANNOTATION_CAPACITY,
  WEB_ANNOTATION_DEGRADED,
  WEB_ANNOTATION_LIMITS,
} from "@orkestrator/protocol/web-annotations";
import type { WebAnnotationFaultStage } from "./web-annotation-storage.js";
import { recordDirectoryName } from "./web-annotation-storage.js";
import {
  ENV_A,
  ENV_B,
  createAnnotation,
  createHarness,
  type ServiceHarness,
} from "./web-annotation-test-support.js";

let harness: ServiceHarness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

function faultOnce(stage: WebAnnotationFaultStage) {
  const state = { armed: false, fired: 0 };
  return {
    state,
    hook: (current: WebAnnotationFaultStage) => {
      if (state.armed && current === stage) {
        state.armed = false;
        state.fired++;
        throw new Error(`injected ${stage}`);
      }
    },
  };
}

describe("web annotation storage commit protocol", () => {
  test("crash before record write commits nothing and a retry creates exactly one", async () => {
    const fault = faultOnce("before-record-write");
    harness = await createHarness({ faults: fault.hook });
    fault.state.armed = true;
    await expect(createAnnotation(harness.service, ENV_A, "Note", "op-1")).rejects.toThrow(
      "injected",
    );
    const restarted = await harness.restart({ faults: fault.hook });
    expect((await restarted.list({ environmentId: ENV_A })).total).toBe(0);
    const receipt = await createAnnotation(restarted, ENV_A, "Note", "op-1");
    expect(receipt.environmentRevision).toBe(1);
    expect((await restarted.list({ environmentId: ENV_A })).total).toBe(1);
  });

  test("crash before manifest replacement leaves only uncommitted records, removed after grace", async () => {
    const fault = faultOnce("before-manifest-replace");
    harness = await createHarness({ faults: fault.hook });
    await createAnnotation(harness.service, ENV_A, "First", "op-1");
    fault.state.armed = true;
    await expect(createAnnotation(harness.service, ENV_A, "Second", "op-2")).rejects.toThrow(
      "injected",
    );
    const restarted = await harness.restart({ faults: fault.hook });
    const list = await restarted.list({ environmentId: ENV_A });
    expect(list.items.map((item) => item.title)).toEqual(["First"]);
    expect(await restarted.receipt(ENV_A, "op-2")).toBeNull();

    const recordsDir = join(harness.dir, "web-annotations", ENV_A, "records");
    const before = await readdir(recordsDir);
    expect(before.length).toBe(4); // capture+entry committed, capture+entry orphaned
    // Within the grace period nothing is removed.
    await restarted.collectGarbage(ENV_A);
    expect((await readdir(recordsDir)).length).toBe(4);
    harness.clock.advance(WEB_ANNOTATION_LIMITS.stagingGraceMs + 60_000);
    await restarted.collectGarbage(ENV_A);
    const after = await readdir(recordsDir);
    expect(after.length).toBe(2);
    const annotation = list.items[0]!;
    expect(after).toContain(recordDirectoryName(annotation.currentCaptureId));
    const got = await restarted.get(ENV_A, annotation.id);
    expect(got.capture?.id).toBe(annotation.currentCaptureId);
    expect(got.entries[0]?.body).toBe("First");
  });

  test("crash after commit before response is recovered through the operation receipt", async () => {
    const fault = faultOnce("after-commit");
    harness = await createHarness({ faults: fault.hook });
    fault.state.armed = true;
    await expect(createAnnotation(harness.service, ENV_A, "Note", "op-lost")).rejects.toThrow(
      "injected",
    );
    const restarted = await harness.restart({ faults: fault.hook });
    const receipt = await restarted.receipt(ENV_A, "op-lost");
    expect(receipt?.annotationId).toBeDefined();
    const retried = await createAnnotation(restarted, ENV_A, "Note", "op-lost");
    expect(retried).toEqual(receipt!);
    expect((await restarted.list({ environmentId: ENV_A })).total).toBe(1);
    await expect(createAnnotation(restarted, ENV_A, "Different", "op-lost")).rejects.toThrow(
      "different request body",
    );
  });

  test("a crash during cleanup leaves committed data intact", async () => {
    const fault = faultOnce("during-cleanup");
    harness = await createHarness({ faults: fault.hook });
    const receipt = await createAnnotation(harness.service, ENV_A, "Keep me", "op-1");
    fault.state.armed = true;
    await expect(harness.service.collectGarbage(ENV_A)).rejects.toThrow("injected");
    const restarted = await harness.restart({ faults: fault.hook });
    expect((await restarted.get(ENV_A, receipt.annotationId)).entries[0]?.body).toBe("Keep me");
    await restarted.collectGarbage(ENV_A);
  });

  test("keeps the previous manifest and serves it read-only when the manifest is corrupt", async () => {
    harness = await createHarness();
    await createAnnotation(harness.service, ENV_A, "One", "op-1");
    await createAnnotation(harness.service, ENV_A, "Two", "op-2");
    const envDir = join(harness.dir, "web-annotations", ENV_A);
    expect(JSON.parse(await readFile(join(envDir, "manifest.prev.json"), "utf8")).revision).toBe(1);
    await writeFile(join(envDir, "manifest.json"), "{ not json");
    const restarted = await harness.restart();
    const list = await restarted.list({ environmentId: ENV_A });
    expect(list.items.map((item) => item.title)).toEqual(["One"]);
    expect((await restarted.capabilities(ENV_A)).storage).toBe("degraded");
    await expect(createAnnotation(restarted, ENV_A, "Three", "op-3")).rejects.toThrow(
      WEB_ANNOTATION_DEGRADED,
    );
  });

  test("unreadable storage becomes unavailable, never an empty collection", async () => {
    harness = await createHarness();
    await createAnnotation(harness.service, ENV_A, "One", "op-1");
    await createAnnotation(harness.service, ENV_A, "Two", "op-2");
    const envDir = join(harness.dir, "web-annotations", ENV_A);
    await writeFile(join(envDir, "manifest.json"), "{}");
    await writeFile(join(envDir, "manifest.prev.json"), "garbage");
    const restarted = await harness.restart();
    await expect(restarted.list({ environmentId: ENV_A })).rejects.toThrow(WEB_ANNOTATION_DEGRADED);
    const capabilities = await restarted.capabilities(ENV_A);
    expect(capabilities.storage).toBe("unavailable");
    expect(capabilities.operations.author).toBe(false);
  });

  test("a corrupt referenced record marks only that item unavailable and read-only", async () => {
    harness = await createHarness();
    const broken = await createAnnotation(harness.service, ENV_A, "Broken", "op-1");
    const healthy = await createAnnotation(harness.service, ENV_A, "Healthy", "op-2");
    const recordDir = join(
      harness.dir,
      "web-annotations",
      ENV_A,
      "records",
      recordDirectoryName(broken.captureId!),
    );
    await writeFile(join(recordDir, "1.json"), "{ corrupt");
    const restarted = await harness.restart();
    const got = await restarted.get(ENV_A, broken.annotationId);
    expect(got.capture).toBeNull();
    expect(got.annotation.unavailable).toBeDefined();
    await expect(
      restarted.appendEntryCommand({
        environmentId: ENV_A,
        operationId: "op-3",
        annotationId: broken.annotationId,
        expectedContentRevision: broken.contentRevision,
        body: "more",
      }),
    ).rejects.toThrow("read-only");
    const list = await restarted.list({ environmentId: ENV_A });
    expect(list.total).toBe(2);
    expect(
      (await restarted.get(ENV_A, healthy.annotationId)).annotation.unavailable,
    ).toBeUndefined();
  });

  test("a missing capture record is detected at startup", async () => {
    harness = await createHarness();
    const receipt = await createAnnotation(harness.service, ENV_A, "Note", "op-1");
    await rm(
      join(
        harness.dir,
        "web-annotations",
        ENV_A,
        "records",
        recordDirectoryName(receipt.captureId!),
      ),
      {
        recursive: true,
      },
    );
    const restarted = await harness.restart();
    const list = await restarted.list({ environmentId: ENV_A });
    expect(list.items[0]?.unavailable).toBe("capture record missing");
  });

  test("the write queue is bounded", async () => {
    harness = await createHarness();
    const store = await harness.service.storage.environment(ENV_A);
    const results = await Promise.allSettled(
      Array.from({ length: WEB_ANNOTATION_LIMITS.queuedMutations + 8 }, () =>
        store.mutate((tx) => {
          tx.markDirty();
        }),
      ),
    );
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected.length).toBe(8);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain(
      WEB_ANNOTATION_CAPACITY,
    );
    expect(store.revision).toBe(WEB_ANNOTATION_LIMITS.queuedMutations);
  });

  test("stale staging uploads are removed only after the grace period", async () => {
    harness = await createHarness();
    const store = await harness.service.storage.environment(ENV_A);
    const staged = await store.stageFile(Buffer.from("x"));
    const orphan = join(store.dir, "staging", "orphan.png");
    await writeFile(orphan, "y");
    const old = new Date(Date.now() - WEB_ANNOTATION_LIMITS.stagingGraceMs - 60_000);
    await utimes(orphan, old, old);
    await utimes(staged, old, old);
    await store.cleanup();
    const remaining = await readdir(join(store.dir, "staging"));
    // The active operation's upload survives; the abandoned one is removed.
    expect(remaining).toEqual([staged.split(/[\\/]/).at(-1)!]);
    await store.releaseStaged(staged);
  });

  test("files are private to the user", async () => {
    harness = await createHarness();
    await createAnnotation(harness.service, ENV_A, "Note", "op-1");
    const { stat } = await import("node:fs/promises");
    const envDir = join(harness.dir, "web-annotations", ENV_A);
    expect((await stat(join(envDir, "manifest.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(envDir)).mode & 0o777).toBe(0o700);
  });
});

describe("web annotation storage startup", () => {
  test("removes stores whose environment no longer exists instead of loading them", async () => {
    harness = await createHarness();
    await createAnnotation(harness.service, ENV_A);
    await createAnnotation(harness.service, ENV_B);
    harness.host.environments.delete(ENV_B);

    await harness.restart();
    expect(await readdir(join(harness.dir, "web-annotations"))).toEqual([ENV_A]);
    expect(harness.service.storage.loadedEnvironmentIds()).toEqual([ENV_A]);
  });

  test("keeps every store when the environment lookup fails", async () => {
    harness = await createHarness();
    await createAnnotation(harness.service, ENV_B);
    harness.host.getEnvironment = async () => {
      throw new Error("environment store unreadable");
    };

    await harness.restart();
    expect(await readdir(join(harness.dir, "web-annotations"))).toEqual([ENV_B]);
  });
});
