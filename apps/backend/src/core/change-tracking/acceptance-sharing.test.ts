/**
 * Acceptance cases for shared physical work, overlap and races (guide §16):
 * H08, V03, V06, V09, V10 and V14.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ChangeProjection } from "@orkestrator/protocol/change-resources";
import { environmentChangeResourceKey } from "@orkestrator/protocol/change-resources";
import { ChangeEvidenceRecorder } from "@orkestrator/protocol/node/change-tracking/evidence-builders";
import { ChangeEvidenceSpool } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import type { DiffScanEvent, DiffStatsTarget } from "../diff-stats-service.js";
import { DiffStatsTracking } from "../diff-stats-tracking.js";
import { WorkAdmissionPool, type AdmissionRequest } from "../work-admission.js";
import { encodePath } from "./capture.js";
import { operationIdFor } from "./identities.js";
import { createHarness, git, spoolSource, type Harness } from "./service-test-support.js";
import { PhysicalKeyResolver } from "./shared-physical-work.js";
import { turnIdFor } from "./turn-boundaries.js";
import {
  RemoteSlots,
  WorktreeRegistry,
  type CaptureOutcome,
  type WorktreeTarget,
} from "./worktree-owner.js";

const harnesses: Harness[] = [];
const directories: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const harness of harnesses.splice(0)) harness.cleanup();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function harness(options: Parameters<typeof createHarness>[0] = {}): Harness {
  const created = createHarness(options);
  harnesses.push(created);
  return created;
}

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function tempRepo(): string {
  const repo = tempDir("ork-ct-share-");
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  return repo;
}

/** Route extra environment ids of the harness to their own targets. */
function routeEnvironments(h: Harness, targets: Record<string, WorktreeTarget>): void {
  const options = (
    h.service as unknown as {
      options: { environmentTarget: (id: string) => Promise<WorktreeTarget | null> };
    }
  ).options;
  const fallback = options.environmentTarget;
  options.environmentTarget = async (id) => targets[id] ?? fallback(id);
}

const snapshotCount = (h: Harness, worktreeId: string): number =>
  (
    h
      .database()
      .db.query("SELECT COUNT(*) AS n FROM change_snapshots WHERE worktree_id = ?")
      .get(worktreeId) as { n: number }
  ).n;

const identityCount = (h: Harness): number =>
  (h.database().db.query("SELECT COUNT(*) AS n FROM change_diff_identities").get() as { n: number })
    .n;

async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Admission stand-in that records every granted capture and can hold them,
 * optionally in front of a real pool.
 */
class GatedAdmission {
  readonly started: string[] = [];
  active = 0;
  maxActive = 0;
  maxPoolWaiting = 0;
  private held = true;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly pool?: WorkAdmissionPool) {}

  run<T>(request: AdmissionRequest, work: () => Promise<T>): Promise<T> {
    const body = async () => {
      this.started.push(request.target);
      this.active++;
      this.maxActive = Math.max(this.maxActive, this.active);
      try {
        if (this.held) await new Promise<void>((resolve) => this.waiting.push(resolve));
        return await work();
      } finally {
        this.active--;
      }
    };
    if (!this.pool) return body();
    const result = this.pool.run(request, body);
    this.maxPoolWaiting = Math.max(this.maxPoolWaiting, this.pool.status().waiting);
    return result;
  }

  release(): void {
    this.held = false;
    for (const wake of this.waiting.splice(0)) wake();
  }
}

function registryWith(h: Harness, admission: GatedAdmission): WorktreeRegistry {
  return new WorktreeRegistry({
    ledger: h.service.ledger,
    store: h.service.objects,
    admission: admission as unknown as WorkAdmissionPool,
  });
}

const CAPABILITIES = {
  resolution: "resolved",
  beforeTurn: "controlled-dispatch",
  afterTurn: "terminal-observed",
  beforeTool: "awaited",
  afterTool: "awaited",
  historicalCallIdentity: "stable",
  fileEvidence: { resolution: "confirmed", kinds: ["replacement"] },
  turnDiff: "absent",
  captureExecutor: "host-worker",
  captureAvailability: "ready",
  backgroundCompletion: "launch-only",
} as const;

function provider(name: string) {
  const spool = new ChangeEvidenceSpool();
  const recorder = new ChangeEvidenceRecorder({
    spool,
    provider: name,
    capabilities: CAPABILITIES,
  });
  return { recorder, source: spoolSource(spool, name) };
}

function toolView(h: Harness, providerName: string, conversationId: string, callId: string) {
  const result = h.service.getToolPresentations({
    environmentId: "env-1",
    provider: providerName,
    conversationId,
    callIds: [callId],
  });
  const value = result.presentations[callId];
  const projection = (role: string): ChangeProjection | undefined => {
    const change = value?.changes.find((c) => c.role === role);
    const view = change ? h.service.getView({ resourceKey: change.resourceKey }) : null;
    return view?.kind === "projection" ? view.projection : undefined;
  };
  const measurement = (role: string) => {
    const change = value?.changes.find((c) => c.role === role);
    return change ? h.service.projections.selectedMeasurement(change.resourceKey) : null;
  };
  return { value, projection, measurement };
}

function scanned(target: DiffStatsTarget, changes: unknown[], baseOid: string): DiffScanEvent {
  const at = new Date().toISOString();
  return {
    kind: "scanned",
    target,
    result: {
      stats: { additions: 0, deletions: 0, filesChanged: changes.length, truncated: false },
      changes,
      baseOid,
    },
    changed: true,
    at,
    startedAt: at,
  };
}

const modified = (path: string, additions: number, deletions: number) => ({
  path,
  filename: path,
  directory: "",
  additions,
  deletions,
  status: "M",
});

function liveSetup(options: Parameters<typeof createHarness>[0] = {}) {
  const h = harness(options);
  const target: DiffStatsTarget = {
    environmentId: "env-1",
    comparisonRef: "main",
    kind: "local",
    worktreePath: h.repo,
  };
  const key = environmentChangeResourceKey("env-1");
  const publish = async (baseOid: string, additions = 1, deletions = 1) => {
    h.service.onDiffScanEvent(scanned(target, [modified("a.txt", additions, deletions)], baseOid));
    await h.service.environments.idle();
    const view = h.service.getView({ resourceKey: key });
    if (view.kind !== "projection") throw new Error("projection expected");
    return view.projection;
  };
  const owner = async () => {
    const identity = await h.service.registry.resolve({ kind: "local", worktreePath: h.repo });
    if (!identity) throw new Error("identity expected");
    return { identity, owner: h.service.registry.owner(identity) };
  };
  const body = async (diffIdentityId: string) => {
    const result = await h.service.diffBodies.getDiff({ diffIdentityId });
    if (result.kind !== "body") throw new Error(`body expected, got ${JSON.stringify(result)}`);
    return result.files[0]!.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text));
  };
  return { h, target, key, publish, owner, body };
}

// ---------------------------------------------------------------------------
// H08
// ---------------------------------------------------------------------------

describe("H08: overlapping windows across providers and a managed terminal", () => {
  test("H08: shared owner marks every intersecting window; closing one never clears another", async () => {
    const h = harness();
    const claude = provider("claude");
    const codex = provider("codex");
    const winOf = (providerName: string, conversationId: string, callId: string) =>
      `win_${operationIdFor({ environmentId: "env-1", provider: providerName, conversationId, callId })}`;
    const claudeWindow = winOf("claude", "s1", "c1");
    const codexWindow = winOf("codex", "t1", "x1");

    // Claude's shell starts alone.
    claude.recorder.tool(
      { conversationId: "s1", callId: "c1" },
      { toolKind: "shell", phase: "running", executionOccurrence: "started" },
    );
    await h.service.pullEvidence(claude.source);
    expect(h.service.ledger.window(claudeWindow)).toMatchObject({
      lifecycle: "open",
      overlap: "none-observed",
    });

    // A managed terminal opens a window on the same physical owner.
    const identity = await h.service.registry.resolve({ kind: "local", worktreePath: h.repo });
    const owner = h.service.registry.owner(identity!);
    const terminal = owner.openWindow({
      windowId: "term-1",
      operationId: "terminal:term-1",
      turnId: null,
      beforeQuality: "prior-observation",
      beforeSnapshotId: null,
      openedSeq: h.service.ledger.nextSequence(),
    });
    expect(terminal.overlap).toBe("known-overlap");
    expect(h.service.ledger.window(claudeWindow)!.overlap).toBe("known-overlap");

    // A second provider's shell joins while both are open.
    codex.recorder.tool(
      { conversationId: "t1", callId: "x1" },
      { toolKind: "shell", phase: "running", executionOccurrence: "started" },
    );
    await h.service.pullEvidence(codex.source);
    expect(h.service.ledger.window(codexWindow)).toMatchObject({
      lifecycle: "open",
      overlap: "known-overlap",
    });

    // Closing the terminal keeps both agents' overlap.
    owner.closeWindow({
      windowId: "term-1",
      afterQuality: "after-terminal",
      afterSnapshotId: null,
      closedSeq: h.service.ledger.nextSequence(),
    });
    expect(h.service.ledger.window("term-1")).toMatchObject({
      lifecycle: "closed",
      overlap: "known-overlap",
    });
    expect(h.service.ledger.window(claudeWindow)!.overlap).toBe("known-overlap");
    expect(h.service.ledger.window(codexWindow)!.overlap).toBe("known-overlap");

    // Claude finishes with a fresh-endpoint observation whose bridge saw no
    // overlap: the backend's owner still records it.
    claude.recorder.tool(
      { conversationId: "s1", callId: "c1" },
      { toolKind: "shell", phase: "succeeded", executionOccurrence: "started" },
    );
    claude.recorder.observation(
      { conversationId: "s1", callId: "c1" },
      {
        boundary: { before: "fresh-before", after: "after-terminal" },
        overlap: "none-observed",
        change: {
          additions: 2,
          deletions: 0,
          files: [{ path: "claude.txt", status: "A", additions: 2, deletions: 0 }],
        },
      },
    );
    await h.service.pullEvidence(claude.source);
    expect(h.service.ledger.window(claudeWindow)).toMatchObject({
      lifecycle: "closed",
      overlap: "known-overlap",
    });
    // Closing Claude's window leaves Codex's (still open) overlap intact.
    expect(h.service.ledger.window(codexWindow)).toMatchObject({
      lifecycle: "open",
      overlap: "known-overlap",
    });

    const claudeView = toolView(h, "claude", "s1", "c1");
    const claudeEffect = claudeView.measurement("effect")!;
    expect(claudeEffect.attribution).toEqual({
      basis: "workspace-observation",
      writerIsolation: "shared",
      overlap: "known-overlap",
    });
    expect(claudeView.projection("effect")!.reasonKeys).toContain("changes.reason.known-overlap");
    expect(claudeView.projection("effect")!.filePage!.rows.map((r) => r.newPathDisplay)).toEqual([
      "claude.txt",
    ]);

    // Codex only observed after its start: an observation window, never a
    // tool effect, and only its own reported paths.
    codex.recorder.tool(
      { conversationId: "t1", callId: "x1" },
      { toolKind: "shell", phase: "succeeded", executionOccurrence: "started" },
    );
    codex.recorder.observation(
      { conversationId: "t1", callId: "x1" },
      {
        boundary: { before: "prior-observation", after: "after-terminal" },
        overlap: "none-observed",
        change: {
          additions: 1,
          deletions: 0,
          files: [{ path: "codex.txt", status: "A", additions: 1, deletions: 0 }],
        },
      },
    );
    await h.service.pullEvidence(codex.source);
    expect(h.service.ledger.window(codexWindow)).toMatchObject({
      lifecycle: "closed",
      overlap: "known-overlap",
    });
    const codexView = toolView(h, "codex", "t1", "x1");
    expect(codexView.value!.changes.map((c) => c.role)).toEqual(["observation"]);
    const codexObservation = codexView.measurement("observation")!;
    expect(codexObservation.scope).toBe("observation-window");
    expect(codexObservation.attribution.overlap).toBe("known-overlap");
    expect(codexObservation.attribution.basis).toBe("workspace-observation");
    expect(
      codexView.projection("observation")!.filePage!.rows.map((r) => r.newPathDisplay),
    ).toEqual(["codex.txt"]);
    // Neither effect leaked into the other tool.
    expect(claudeView.projection("effect")!.counters.additions.value).toBe(2);
    expect(codexView.projection("observation")!.counters.additions.value).toBe(1);

    // A later, non-intersecting window is not tainted by the closed ones.
    claude.recorder.tool(
      { conversationId: "s1", callId: "c2" },
      { toolKind: "shell", phase: "running", executionOccurrence: "started" },
    );
    await h.service.pullEvidence(claude.source);
    expect(h.service.ledger.window(winOf("claude", "s1", "c2"))!.overlap).toBe("none-observed");
  });
});

// ---------------------------------------------------------------------------
// V09
// ---------------------------------------------------------------------------

describe("V09: aliases of one checkout share physical work", () => {
  test("V09: symlink and relative aliases resolve to one identity and owner; a linked worktree stays separate", async () => {
    const h = harness();
    const links = tempDir("ork-ct-alias-");
    const symlink = join(links, "link");
    symlinkSync(h.repo, symlink);
    const linked = join(links, "linked");
    git(h.repo, "worktree", "add", "-q", "-b", "side", linked);

    const registry = h.service.registry;
    const real = await registry.resolve({ kind: "local", worktreePath: h.repo });
    const viaLink = await registry.resolve({ kind: "local", worktreePath: symlink });
    const viaRelative = await registry.resolve({
      kind: "local",
      worktreePath: relative(process.cwd(), h.repo),
    });
    const other = await registry.resolve({ kind: "local", worktreePath: linked });
    expect(viaLink!.worktreeId).toBe(real!.worktreeId);
    expect(viaRelative!.worktreeId).toBe(real!.worktreeId);
    expect(registry.owner(viaLink!)).toBe(registry.owner(real!));
    expect(registry.owner(viaRelative!)).toBe(registry.owner(real!));

    // Linked worktrees share objects and refs but not files, index or HEAD.
    expect(other!.worktreeId).not.toBe(real!.worktreeId);
    expect(other!.commonDir).toBe(real!.commonDir);
    expect(other!.gitDir).not.toBe(real!.gitDir);
    expect(registry.owner(other!)).not.toBe(registry.owner(real!));

    const keys = new PhysicalKeyResolver();
    const key = (worktreePath: string) => keys.key({ kind: "local", worktreePath });
    expect(key(symlink)).toBe(key(h.repo));
    expect(key(relative(process.cwd(), h.repo))).toBe(key(h.repo));
    expect(key(linked)).not.toBe(key(h.repo));
  });

  test("V09: ten capture requests through aliases cost the same captures as one client", async () => {
    const h = harness();
    const links = tempDir("ork-ct-alias-");
    symlinkSync(h.repo, join(links, "link"));
    const admission = new GatedAdmission();
    const registry = registryWith(h, admission);
    const aliases = [h.repo, join(links, "link"), relative(process.cwd(), h.repo)];
    const owners = await Promise.all(
      aliases.map(async (worktreePath) =>
        registry.owner((await registry.resolve({ kind: "local", worktreePath }))!),
      ),
    );
    const requests = Array.from({ length: 10 }, (_, i) =>
      owners[i % owners.length]!.capture({ purpose: "turn-start", deadlineMs: 30_000 }),
    );
    await until(() => admission.started.length === 1);
    admission.release();
    const outcomes = await Promise.all(requests);
    // One pass already running plus one shared fresh pass.
    expect(admission.started).toHaveLength(2);
    expect(
      new Set(outcomes.map((o) => (o.kind === "published" ? o.snapshotId : o.reason))).size,
    ).toBe(2);
    expect(snapshotCount(h, owners[0]!.identity.worktreeId)).toBe(2);
  });

  test("V09: environments aliasing one checkout share one watcher and scan; a linked worktree does not", async () => {
    const repo = tempRepo();
    const links = tempDir("ork-ct-alias-");
    symlinkSync(repo, join(links, "link"));
    const linked = join(links, "linked");
    git(repo, "worktree", "add", "-q", "-b", "side", linked);
    const scannedIds = new Set<string>();
    const tracking = new DiffStatsTracking({
      emit: () => undefined,
      onScanEvent: (event) => {
        if (event.kind === "scanned") scannedIds.add(event.target.environmentId);
      },
    });
    cleanups.push(() => tracking.shutdown());
    const targets: DiffStatsTarget[] = [
      { environmentId: "env-a", kind: "local", worktreePath: repo, comparisonRef: "main" },
      {
        environmentId: "env-b",
        kind: "local",
        worktreePath: join(links, "link"),
        comparisonRef: "main",
      },
      {
        environmentId: "env-c",
        kind: "local",
        worktreePath: relative(process.cwd(), repo),
        comparisonRef: "main",
      },
    ];
    for (const target of targets) tracking.service.track(target);
    await until(() => scannedIds.size === 3, 15_000);
    // Three logical views, one physical watcher; their scans joined.
    expect(tracking.sharedWatchers.activeWatchers()).toBe(1);
    const shared = tracking.sharedScans.stats();
    expect(shared.executed).toBeLessThanOrEqual(2);
    expect(shared.executed + shared.joined).toBe(3);

    tracking.service.track({
      environmentId: "env-d",
      kind: "local",
      worktreePath: linked,
      comparisonRef: "main",
    });
    await until(() => scannedIds.has("env-d"), 15_000);
    expect(tracking.sharedWatchers.activeWatchers()).toBe(2);
    expect(tracking.sharedScans.stats().executed).toBe(shared.executed + 1);
  });

  test("V09: running turns with distinct baselines on aliased environments reuse one provisional capture", async () => {
    const h = harness();
    const links = tempDir("ork-ct-alias-");
    symlinkSync(h.repo, join(links, "link"));
    routeEnvironments(h, {
      "env-a": { kind: "local", worktreePath: h.repo },
      "env-b": { kind: "local", worktreePath: join(links, "link") },
    });
    const start = async (environmentId: string) => {
      const result = await h.service.prepareTurnStart({
        environmentId,
        logicalSessionKey: `${environmentId}:tab`,
        requestId: "r1",
        provider: "claude",
      });
      expect(result.kind).toBe("ready");
      h.service.markTurnDispatched(environmentId, `${environmentId}:tab`, "r1", "accepted");
      return turnIdFor(environmentId, `${environmentId}:tab`, "r1");
    };
    const turnA = await start("env-a");
    writeFileSync(join(h.repo, "a.txt"), "one\ntwo\nthree\n");
    const turnB = await start("env-b");
    writeFileSync(join(h.repo, "a.txt"), "one\ntwo\nthree\nfour\n");

    const identity = await h.service.registry.resolve({ kind: "local", worktreePath: h.repo });
    const owner = h.service.registry.owner(identity!);
    const before = snapshotCount(h, identity!.worktreeId);
    // A watcher hint for one alias serves every running view of the checkout.
    await h.service.turns.provisional("env-a", owner);
    expect(snapshotCount(h, identity!.worktreeId)).toBe(before + 1);

    const a = h.service.ledger.latestMeasurement("turn", turnA, "turn-net");
    const b = h.service.ledger.latestMeasurement("turn", turnB, "turn-net");
    expect(a?.finality).toBe("provisional");
    expect(b?.finality).toBe("provisional");
    // Same captured input, separate comparisons.
    expect(a!.afterSnapshotId).toBe(b!.afterSnapshotId);
    expect(a!.beforeSnapshotId).not.toBe(b!.beforeSnapshotId);
    expect(a!.totals.additions.value).toBe(2);
    expect(b!.totals.additions.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// V10
// ---------------------------------------------------------------------------

describe("V10: bounded, fair capture scheduling", () => {
  test("V10: a flood of hints during a running capture schedules exactly one trailing capture", async () => {
    const h = harness();
    const admission = new GatedAdmission();
    const registry = registryWith(h, admission);
    const owner = registry.owner(
      (await registry.resolve({ kind: "local", worktreePath: h.repo }))!,
    );
    const first = owner.capture({ purpose: "provisional", deadlineMs: 30_000 });
    await until(() => admission.started.length === 1);
    // Provisional hints queue first, then an urgent boundary arrives: it joins
    // (and upgrades) the one queued pass instead of starting another.
    const flood: Promise<CaptureOutcome>[] = [];
    for (let i = 0; i < 200; i++)
      flood.push(owner.capture({ purpose: "provisional", deadlineMs: 30_000 }));
    flood.push(owner.capture({ purpose: "turn-start", deadlineMs: 30_000 }));
    for (let i = 0; i < 200; i++)
      flood.push(owner.capture({ purpose: "tool-before", deadlineMs: 30_000 }));
    admission.release();
    const firstOutcome = await first;
    const trailing = await Promise.all(flood);
    expect(admission.started).toHaveLength(2);
    expect(admission.maxActive).toBe(1);
    const ids = new Set(trailing.map((o) => (o.kind === "published" ? o.snapshotId : o.reason)));
    expect(ids.size).toBe(1);
    expect(firstOutcome.kind).toBe("published");
    expect(ids.has(firstOutcome.kind === "published" ? firstOutcome.snapshotId : "")).toBe(false);
    // The queue drained: a later hint starts a new pass.
    await owner.capture({ purpose: "provisional", deadlineMs: 30_000 });
    expect(admission.started).toHaveLength(3);
  });

  test("V10: a noisy worktree cannot starve another worktree in shared admission", async () => {
    const h = harness();
    const quiet = tempRepo();
    const pool = new WorkAdmissionPool({
      name: "git-docker-scan",
      limits: { maxConcurrent: 1 },
      diagnostics: null,
    });
    const admission = new GatedAdmission(pool);
    const registry = registryWith(h, admission);
    const noisy = registry.owner(
      (await registry.resolve({ kind: "local", worktreePath: h.repo }))!,
    );
    const calm = registry.owner((await registry.resolve({ kind: "local", worktreePath: quiet }))!);
    const noisyTarget = `change:${noisy.identity.worktreeId}`;
    const calmTarget = `change:${calm.identity.worktreeId}`;

    const pending: Promise<CaptureOutcome>[] = [
      noisy.capture({ purpose: "provisional", deadlineMs: 30_000 }),
    ];
    await until(() => admission.started.length === 1);
    pending.push(
      ...Array.from({ length: 50 }, () =>
        noisy.capture({ purpose: "provisional", deadlineMs: 30_000 }),
      ),
    );
    const calmDone = calm.capture({ purpose: "provisional", deadlineMs: 30_000 });
    admission.release();
    // Keep the noisy worktree hot while the quiet one waits.
    let flooding = true;
    const flooder = (async () => {
      while (flooding) {
        pending.push(noisy.capture({ purpose: "provisional", deadlineMs: 30_000 }));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();
    expect((await calmDone).kind).toBe("published");
    flooding = false;
    await flooder;
    await Promise.all(pending);
    // The quiet worktree ran right after the pass that was already running.
    expect(admission.started.indexOf(calmTarget)).toBe(1);
    expect(admission.started[0]).toBe(noisyTarget);
    // Each owner contributes at most one waiter: the pool queue stays bounded.
    expect(admission.maxPoolWaiting).toBeLessThanOrEqual(2);
    expect(admission.maxActive).toBe(1);
  });

  test("V10: a released remote slot goes to the oldest waiter; newcomers cannot barge or exceed the cap", async () => {
    const slots = new RemoteSlots(1);
    const signal = new AbortController().signal;
    const releaseA = await slots.acquire(signal);
    const order: string[] = [];
    const b = slots.acquire(signal).then((release) => {
      order.push("b");
      return release;
    });
    releaseA();
    // A newcomer arriving right after the release must queue behind b.
    const c = slots.acquire(signal).then((release) => {
      order.push("c");
      return release;
    });
    const releaseB = await b;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["b"]);
    releaseB();
    const releaseC = await c;
    expect(order).toEqual(["b", "c"]);

    // An abandoned waiter leaves the queue and is never granted.
    const abort = new AbortController();
    const abandoned = slots.acquire(abort.signal);
    abort.abort();
    await expect(abandoned).rejects.toThrow("capture-timeout");
    releaseC();
    const releaseD = await slots.acquire(signal);
    releaseD();
  });
});

// ---------------------------------------------------------------------------
// V14
// ---------------------------------------------------------------------------

describe("V14: equal path strings on different runtimes", () => {
  const containers: Record<string, { id: string; created: string }> = {
    alpha: { id: "a".repeat(64), created: "2026-10-20T10:00:00Z" },
    beta: { id: "b".repeat(64), created: "2026-10-20T11:00:00Z" },
  };

  function containerRegistry(h: Harness) {
    return new WorktreeRegistry({
      ledger: h.service.ledger,
      store: h.service.objects,
      inspectContainer: async (name) => containers[name] ?? null,
    });
  }

  test("V14: two containers both at /workspace are distinct identities with their own executors", async () => {
    const h = harness();
    const registry = containerRegistry(h);
    const alpha = await registry.resolve({ kind: "container", containerId: "alpha" });
    const beta = await registry.resolve({ kind: "container", containerId: "beta" });
    expect(alpha!.canonicalRoot).toBe("/workspace");
    expect(beta!.canonicalRoot).toBe("/workspace");
    expect(alpha!.worktreeId).not.toBe(beta!.worktreeId);
    expect(alpha!.identityKey).not.toBe(beta!.identityKey);
    expect(alpha!.incarnation).not.toBe(beta!.incarnation);
    expect(registry.owner(alpha!).executor.label).toBe(`container:${containers.alpha!.id}`);
    expect(registry.owner(beta!).executor.label).toBe(`container:${containers.beta!.id}`);
    const keys = new PhysicalKeyResolver();
    expect(keys.key({ kind: "container", containerId: "alpha" })).not.toBe(
      keys.key({ kind: "container", containerId: "beta" }),
    );
  });

  test("V14: a host directory and a container root with the same path string never share endpoints", async () => {
    const h = harness();
    const registry = new WorktreeRegistry({
      ledger: h.service.ledger,
      store: h.service.objects,
      inspectContainer: async (name) => containers[name] ?? null,
    });
    const host = await registry.resolve({ kind: "local", worktreePath: h.repo });
    const container = await registry.resolve({
      kind: "container",
      containerId: "alpha",
      root: host!.canonicalRoot,
    });
    expect(container!.canonicalRoot).toBe(host!.canonicalRoot);
    expect(container!.worktreeId).not.toBe(host!.worktreeId);
    expect(container!.runtimeKind).toBe("container");
    expect(registry.owner(host!).executor.kind).toBe("host-worker");
    expect(registry.owner(container!).executor.kind).toBe("container-worker");
    const outcome = await registry
      .owner(host!)
      .capture({ purpose: "turn-start", deadlineMs: 30_000 });
    expect(outcome.kind).toBe("published");
    // The host capture is not an endpoint of the container's worktree.
    expect(h.service.ledger.latestSnapshot(container!.worktreeId)).toBeNull();
    expect(h.service.ledger.latestSnapshot(host!.worktreeId)?.incarnation).toBe(host!.incarnation);
  });

  test("V14: one container resolved at two roots concurrently, or recreated, never collides", async () => {
    const h = harness();
    const registry = containerRegistry(h);
    const [workspace, other] = await Promise.all([
      registry.resolve({ kind: "container", containerId: "alpha", root: "/workspace" }),
      registry.resolve({ kind: "container", containerId: "alpha", root: "/srv/app" }),
    ]);
    expect(workspace!.canonicalRoot).toBe("/workspace");
    expect(other!.canonicalRoot).toBe("/srv/app");
    expect(other!.worktreeId).not.toBe(workspace!.worktreeId);

    // The same container name now names a replacement container.
    containers.alpha = { id: "c".repeat(64), created: "2026-10-20T12:00:00Z" };
    try {
      const recreated = await registry.resolve({ kind: "container", containerId: "alpha" });
      expect(recreated!.worktreeId).not.toBe(workspace!.worktreeId);
      expect(recreated!.incarnation).not.toBe(workspace!.incarnation);
      expect(registry.owner(recreated!)).not.toBe(registry.owner(workspace!));
    } finally {
      containers.alpha = { id: "a".repeat(64), created: "2026-10-20T10:00:00Z" };
    }
  });
});

// ---------------------------------------------------------------------------
// V06
// ---------------------------------------------------------------------------

describe("V06: body fetch races", () => {
  type Fetch = (...args: unknown[]) => Promise<unknown>;
  function interceptFetch(executor: object, during: () => unknown): () => void {
    const target = executor as { fetch: Fetch };
    const original = target.fetch.bind(executor);
    target.fetch = async (...args: unknown[]) => {
      await during();
      return original(...args);
    };
    return () => {
      target.fetch = original;
    };
  }

  test("V06: a baseline retarget during the fetch returns stale-revision and publishes nothing", async () => {
    const { h, key, publish, owner, body } = liveSetup();
    const base = git(h.repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(h.repo, "a.txt"), "one\nTWO\n");
    const first = await publish(base);
    const row = first.filePage!.rows[0]!;
    git(h.repo, "commit", "-qam", "retarget");
    const retargeted = git(h.repo, "rev-parse", "HEAD").trim();
    const { owner: live } = await owner();
    const identities = identityCount(h);

    for (const request of [
      { resourceKey: key, revision: first.revision, rowId: row.rowId },
      { resourceKey: key, rowId: row.rowId },
    ]) {
      // The comparison is retargeted while the current bytes are read.
      const restore = interceptFetch(live.executor, () => publish(retargeted, 0, 0));
      try {
        const result = await h.service.diffBodies.resolveLiveDetail(request);
        expect(result).toMatchObject({ kind: "error", error: { code: "stale-revision" } });
      } finally {
        restore();
      }
      await publish(base);
    }
    expect(identityCount(h)).toBe(identities);

    // A fresh request against the current revision succeeds.
    const current = await publish(base);
    const resolved = await h.service.diffBodies.resolveLiveDetail({
      resourceKey: key,
      revision: current.revision,
      rowId: current.filePage!.rows[0]!.rowId,
    });
    expect(resolved.kind).toBe("identity");
    if (resolved.kind === "identity") expect(await body(resolved.identity.id)).toContain("TWO");
  });

  test("V06: an owner replacement during the fetch is owner-replaced; immutable identities stay readable", async () => {
    const { h, key, publish, owner, body } = liveSetup();
    const base = git(h.repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(h.repo, "a.txt"), "one\nTWO\n");
    const projection = await publish(base);
    const request = {
      resourceKey: key,
      revision: projection.revision,
      rowId: projection.filePage!.rows[0]!.rowId,
    };
    const earlier = await h.service.diffBodies.resolveLiveDetail(request);
    if (earlier.kind !== "identity") throw new Error("identity expected");
    const identities = identityCount(h);

    const { identity, owner: live } = await owner();
    const restore = interceptFetch(live.executor, () => {
      // Another holder takes the worktree's durable fence.
      h.service.ledger.claimOwnership(identity.worktreeId, "other-holder");
    });
    try {
      const result = await h.service.diffBodies.resolveLiveDetail(request);
      expect(result).toMatchObject({ kind: "error", error: { code: "owner-replaced" } });
    } finally {
      restore();
    }
    expect(identityCount(h)).toBe(identities);

    // The completed immutable identity still serves its body.
    expect(await body(earlier.identity.id)).toContain("TWO");
    // A retry runs under a new owner and reuses the same immutable identity.
    const retried = await h.service.diffBodies.resolveLiveDetail(request);
    expect(retried.kind).toBe("identity");
    if (retried.kind === "identity") expect(retried.identity.id).toBe(earlier.identity.id);
    expect((await owner()).owner).not.toBe(live);
  });

  test("V06: repeated fetches of unchanged bytes reuse one immutable identity and its blobs", async () => {
    const { h, key, publish, body } = liveSetup();
    const base = git(h.repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(h.repo, "a.txt"), "one\nTWO\n");
    const projection = await publish(base);
    const request = {
      resourceKey: key,
      revision: projection.revision,
      rowId: projection.filePage!.rows[0]!.rowId,
    };
    const first = await h.service.diffBodies.resolveLiveDetail(request);
    const identities = identityCount(h);
    const second = await h.service.diffBodies.resolveLiveDetail(request);
    if (first.kind !== "identity" || second.kind !== "identity") throw new Error("identity");
    expect(second.identity.id).toBe(first.identity.id);
    // Content-addressed blobs: the same bytes are the same objects.
    expect(second.identity).toMatchObject({ before: { blobId: expect.any(String) } });
    if (first.identity.kind === "file" && second.identity.kind === "file")
      expect(second.identity.after).toMatchObject({
        blobId: first.identity.after.state === "present" ? first.identity.after.blobId : "",
      });
    expect(identityCount(h)).toBe(identities);
    expect(await body(first.identity.id)).toEqual(await body(second.identity.id));
  });
});

// ---------------------------------------------------------------------------
// V03
// ---------------------------------------------------------------------------

describe("V03: equal totals, new bytes", () => {
  test("V03: same path and +1/-1 with different bytes keeps totals but gets a new content identity", async () => {
    const { h, target, key, publish, owner, body } = liveSetup({
      policy: { liveBodyCoalesceMs: 20 },
    });
    const base = git(h.repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(h.repo, "a.txt"), "one\nTWO\n");
    const before = await publish(base);
    const firstDetail = await h.service.diffBodies.resolveLiveDetail({
      resourceKey: key,
      revision: before.revision,
      rowId: before.filePage!.rows[0]!.rowId,
    });
    if (firstDetail.kind !== "identity") throw new Error("identity expected");
    expect(await body(firstDetail.identity.id)).toContain("TWO");

    // The bytes change; path, status and counts do not.
    writeFileSync(join(h.repo, "a.txt"), "one\nTRE\n");
    h.service.onDiffScanEvent({
      kind: "hint",
      target,
      paths: ["a.txt"],
      at: new Date().toISOString(),
    });
    await until(() =>
      h.events.some((e) => (e.payload as { kind?: string }).kind === "content-invalidated"),
    );
    const invalidation = h.events.find(
      (e) => (e.payload as { kind?: string }).kind === "content-invalidated",
    )!.payload as { resourceKey: string; pathIds: string[]; contentGeneration: number };
    expect(invalidation).toMatchObject({
      resourceKey: key,
      pathIds: [encodePath(new TextEncoder().encode("a.txt"))],
      contentGeneration: 1,
    });
    const { owner: live } = await owner();
    const pathId = encodePath(new TextEncoder().encode("a.txt"));
    await until(() => live.contentGeneration(pathId) >= 1);

    const after = await publish(base);
    expect(after.counters.additions).toEqual(before.counters.additions);
    expect(after.counters.deletions).toEqual(before.counters.deletions);
    expect(after.counters.changedFiles).toBe(before.counters.changedFiles);
    expect(after.revision).toBeGreaterThan(before.revision);

    const secondDetail = await h.service.diffBodies.resolveLiveDetail({
      resourceKey: key,
      revision: after.revision,
      rowId: after.filePage!.rows[0]!.rowId,
    });
    if (secondDetail.kind !== "identity") throw new Error("identity expected");
    expect(secondDetail.identity.id).not.toBe(firstDetail.identity.id);
    const newBody = await body(secondDetail.identity.id);
    expect(newBody).toContain("TRE");
    expect(newBody).not.toContain("TWO");
    // The earlier identity is immutable: it still shows the bytes it bound.
    expect(await body(firstDetail.identity.id)).toContain("TWO");
  });
});
