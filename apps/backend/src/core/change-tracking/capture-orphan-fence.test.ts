/**
 * ST-3: a warm capture neither renews a fence that is still young nor stats an
 * object twice, and retention still never deletes what a capture relies on.
 *
 * The objects a capture adopts here belong to no ledger row, which is the state
 * between "reused" and "ledger commit": only the fence protects them, and every
 * sweep below sees them as unreachable.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureWorktree,
  HostCaptureExecutor,
  type CaptureExecutor,
  type CaptureLimits,
  type CaptureResult,
  type StatCacheEntry,
} from "./capture.js";
import { ObjectStore } from "./object-store.js";
import { createHarness, type Harness } from "./service-test-support.js";

/** Long enough that a slow git spawn cannot move an object across a boundary. */
const GRACE_MS = 10 * 60_000;
/** How far past now a sweep may run while the half-grace margin still holds. */
const SWEEP_AHEAD_MS = GRACE_MS * 0.49;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function harness(): Harness {
  const h = createHarness({ policy: { orphanGraceMs: GRACE_MS } });
  cleanups.push(() => h.cleanup());
  writeFileSync(join(h.repo, "b.txt"), "b\n");
  writeFileSync(join(h.repo, "c.txt"), "c\n");
  writeFileSync(join(h.repo, "d.txt"), "d\n");
  return h;
}

function captured(result: CaptureResult) {
  if (result.kind !== "captured") throw new Error(`capture failed: ${result.reason}`);
  return result;
}

function objectFile(store: ObjectStore, id: string): string {
  return join(store.root, "objects", id.slice(0, 2), id.slice(2));
}

function setAge(store: ObjectStore, id: string, ageMs: number): void {
  const at = new Date(Date.now() - ageMs);
  utimesSync(objectFile(store, id), at, at);
}

const mtime = (store: ObjectStore, id: string) => lstatSync(objectFile(store, id)).mtimeMs;

/** An unreachable object past any grace: a sweep that really runs removes it. */
async function plantControl(store: ObjectStore): Promise<string> {
  const { id } = await store.put("blob", new TextEncoder().encode(randomUUID()));
  setAge(store, id, GRACE_MS * 2);
  return id;
}

type RacePoint = "before-reuse" | "during-reuse" | "after-reuse" | "before-commit";

/** Runs `race` at one exact point of a real capture pass. */
class RacingExecutor implements CaptureExecutor {
  readonly kind = "host-worker" as const;
  readonly label: string;
  private inventories = 0;
  private described = 0;

  constructor(
    private readonly inner: HostCaptureExecutor,
    private readonly raceAt: RacePoint,
    private readonly race: () => Promise<unknown>,
  ) {
    this.label = inner.label;
  }

  async inventory(limits: CaptureLimits, signal: AbortSignal) {
    this.inventories += 1;
    if (this.inventories === 1 && this.raceAt === "before-reuse") await this.race();
    // The second inventory is the recheck: every reuse has already happened.
    if (this.inventories === 2 && this.raceAt === "after-reuse") await this.race();
    return this.inner.inventory(limits, signal);
  }

  async describe(
    pathIds: readonly string[],
    limits: CaptureLimits,
    signal: AbortSignal,
    statCache?: ReadonlyMap<string, StatCacheEntry>,
  ) {
    this.described += 1;
    if (this.described === 3 && this.raceAt === "during-reuse") await this.race();
    return this.inner.describe(pathIds, limits, signal, statCache);
  }

  fetch(pathIds: readonly string[], limits: CaptureLimits, signal: AbortSignal) {
    return this.inner.fetch(pathIds, limits, signal);
  }
}

/** A first capture, whose objects then sit in the store at `ageMs`. */
async function agedBaseline(h: Harness, ageMs: number) {
  const store = h.service.objects;
  const inner = new HostCaptureExecutor(h.repo, 0);
  const first = captured(await captureWorktree({ executor: inner, store }));
  for (const entry of first.manifest.entries) setAge(store, entry.o, ageMs);
  return { store, inner, first };
}

async function expectAllReadable(store: ObjectStore, result: ReturnType<typeof captured>) {
  expect(result.manifest.entries.length).toBeGreaterThanOrEqual(4);
  for (const entry of result.manifest.entries) expect(await store.get(entry.o)).not.toBeNull();
  expect(await store.get(result.manifestId)).not.toBeNull();
}

describe("the orphan fence on reuse (ST-3)", () => {
  test("an object inside the first half of the grace is reused without touching its fence", async () => {
    const h = harness();
    const store = h.service.objects;
    const { id } = await store.put("blob", new TextEncoder().encode("young\n"));
    setAge(store, id, GRACE_MS * 0.25);
    const before = mtime(store, id);
    expect(await store.reuse(id)).toBe(true);
    expect(mtime(store, id)).toBe(before);
  });

  test("an object past half the grace is renewed", async () => {
    const h = harness();
    const store = h.service.objects;
    const { id } = await store.put("blob", new TextEncoder().encode("older\n"));
    setAge(store, id, GRACE_MS * 0.75);
    const before = mtime(store, id);
    const started = Date.now();
    expect(await store.reuse(id)).toBe(true);
    expect(mtime(store, id)).toBeGreaterThan(before);
    expect(mtime(store, id)).toBeGreaterThanOrEqual(started - 1_000);
  });

  test("a store that was not told its grace renews on every reuse", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ork-fence-store-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const store = new ObjectStore({ root: directory, durable: false });
    const { id } = await store.put("blob", new TextEncoder().encode("unknown grace\n"));
    setAge(store, id, 5_000);
    const before = mtime(store, id);
    expect(await store.reuse(id)).toBe(true);
    expect(mtime(store, id)).toBeGreaterThan(before);
  });

  test("an absent object or a bad id is not reusable", async () => {
    const h = harness();
    const store = h.service.objects;
    const { id } = await store.put("blob", new TextEncoder().encode("gone\n"));
    unlinkSync(objectFile(store, id));
    expect(await store.reuse(id)).toBe(false);
    expect(await store.reuse("not-an-object-id")).toBe(false);
  });

  test("a warm capture over young objects leaves every fence alone and repeats no stat", async () => {
    const h = harness();
    const { store, inner, first } = await agedBaseline(h, GRACE_MS * 0.25);
    const fences = first.manifest.entries.map((entry) => mtime(store, entry.o));
    const has = spyOn(store, "has");
    const next = captured(
      await captureWorktree({
        executor: inner,
        store,
        previous: first.manifest,
        statCache: first.statCache,
      }),
    );
    // One call: the manifest's own write. No closure look at any blob.
    expect(has).toHaveBeenCalledTimes(1);
    has.mockRestore();
    expect(next.manifestId).toBe(first.manifestId);
    expect(next.manifest.entries.map((entry) => mtime(store, entry.o))).toEqual(fences);
  });

  test("an object deleted behind the store's back is read and written again", async () => {
    const h = harness();
    const { store, inner, first } = await agedBaseline(h, GRACE_MS * 0.25);
    const victim = first.manifest.entries[0]!.o;
    unlinkSync(objectFile(store, victim));
    const next = captured(
      await captureWorktree({
        executor: inner,
        store,
        previous: first.manifest,
        statCache: first.statCache,
      }),
    );
    expect(next.manifestId).toBe(first.manifestId);
    expect(next.newObjectIds).toEqual([victim]);
    await expectAllReadable(store, next);
  });

  test("a sweep that removes an object mid-pass still fails the closure check", async () => {
    const h = harness();
    const { store, inner, first } = await agedBaseline(h, GRACE_MS * 0.25);
    const executor = new RacingExecutor(inner, "after-reuse", () =>
      store.sweep(new Set(), 0, Date.now() + GRACE_MS),
    );
    const next = await captureWorktree({
      executor,
      store,
      previous: first.manifest,
      statCache: first.statCache,
    });
    expect(next).toMatchObject({ kind: "unavailable", reason: "closure-incomplete" });
  });
});

describe("retention racing a capture", () => {
  // Inside the window nothing is renewed, so these prove the half-grace margin
  // is what protects the object. Past it they prove the renewal does: a sweep
  // at this age plus SWEEP_AHEAD_MS is past the full grace without one.
  const ages = [
    ["inside the skip window", GRACE_MS * 0.49],
    ["past the skip window", GRACE_MS * 0.75],
    ["past the whole grace", GRACE_MS * 1.5],
  ] as const;
  const points: RacePoint[] = ["before-reuse", "during-reuse", "after-reuse", "before-commit"];

  for (const [label, ageMs] of ages) {
    for (const point of points) {
      test(`objects ${label}, sweep ${point}: everything the capture adopted survives`, async () => {
        const h = harness();
        const { store, inner, first } = await agedBaseline(h, ageMs);
        const control = await plantControl(store);
        const sweep = () => h.service.retention.run(Date.now() + SWEEP_AHEAD_MS);
        const reports: Array<Awaited<ReturnType<typeof sweep>>> = [];
        const race = async () => reports.push(await sweep());
        const next = captured(
          await captureWorktree({
            executor: new RacingExecutor(inner, point, race),
            store,
            previous: first.manifest,
            statCache: first.statCache,
          }),
        );
        // No ledger row names this capture yet: the state a commit would close.
        if (point === "before-commit") await race();
        expect(reports).toHaveLength(1);
        // The sweep really ran, against the same reachable set the objects missed.
        expect(reports[0]!.removedObjects).toBeGreaterThanOrEqual(1);
        expect(await store.has(control)).toBe(false);
        expect(next.manifestId).toBe(first.manifestId);
        await expectAllReadable(store, next);
      });
    }
  }

  test("objects inside the skip window are never removed by any sweep the margin allows", async () => {
    const h = harness();
    const { store, inner, first } = await agedBaseline(h, GRACE_MS * 0.49);
    const control = await plantControl(store);
    const removedBefore = store.removedObjects;
    const readsBefore = inner.reads.contentRead;
    const next = captured(
      await captureWorktree({
        executor: new RacingExecutor(inner, "after-reuse", () =>
          h.service.retention.run(Date.now() + SWEEP_AHEAD_MS),
        ),
        store,
        previous: first.manifest,
        statCache: first.statCache,
      }),
    );
    expect(store.removedObjects - removedBefore).toBe(1);
    expect(await store.has(control)).toBe(false);
    // Nothing had to be read back: the sweep left every adopted object in place.
    expect(next.newObjectIds).toEqual([]);
    expect(inner.reads.contentRead - readsBefore).toBe(0);
    await expectAllReadable(store, next);
  });

  for (const [label, ageMs] of ages) {
    test(`objects ${label}: sweeps running concurrently through a whole pass lose nothing`, async () => {
      const h = harness();
      const { store, inner, first } = await agedBaseline(h, ageMs);
      await plantControl(store);
      let finished = false;
      let sweeps = 0;
      const racing = (async () => {
        while (!finished) {
          await h.service.retention.run(Date.now() + SWEEP_AHEAD_MS);
          sweeps += 1;
          await Bun.sleep(0);
        }
      })();
      try {
        const next = captured(
          await captureWorktree({
            executor: inner,
            store,
            previous: first.manifest,
            statCache: first.statCache,
          }),
        );
        await expectAllReadable(store, next);
      } finally {
        finished = true;
        await racing;
      }
      expect(sweeps).toBeGreaterThan(0);
    });
  }
});
