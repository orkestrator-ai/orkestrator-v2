/**
 * Design-canvas benchmark fixtures (plan steps 01, 12, 14 and 15).
 *
 * Synthetic content only: no design, prompt or repository data is read or
 * logged. Measures, per fixture of 1/16/64 frames and small/near-limit
 * documents: geometry-edit latency, bytes a client receives to catch up
 * (incremental delta vs full snapshot), commit bytes, no-op handling, batch
 * versus separate commits, compact versus full agent responses and, when
 * Chromium is available, cold/warm style-edit latency.
 *
 * Run: bun scripts/benchmark-design.ts [--json] [--no-browser]
 * Single-machine timings are evidence for this host only, not thresholds.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DesignService } from "../apps/backend/src/core/design-service";
import { resolveDesignChromiumPath } from "../apps/backend/src/core/design-renderer";
import { runDesignAction } from "../apps/backend/src/core/design-tools";

type Fixture = { frames: number; htmlBytes: number; label: string };

const FIXTURES: Fixture[] = [
  { frames: 1, htmlBytes: 2 * 1024, label: "1 frame, small" },
  { frames: 16, htmlBytes: 2 * 1024, label: "16 frames, small" },
  { frames: 64, htmlBytes: 2 * 1024, label: "64 frames, small" },
  { frames: 16, htmlBytes: 200 * 1024, label: "16 frames, near-limit HTML" },
  { frames: 64, htmlBytes: 60 * 1024, label: "64 frames, near-limit document" },
];
const SAMPLES = 20;
const json = process.argv.includes("--json");
const useBrowser = !process.argv.includes("--no-browser") && Boolean(resolveDesignChromiumPath());

function syntheticHtml(bytes: number, seed: number): string {
  const rows: string[] = [];
  let size = 0;
  for (let index = 0; size < bytes - 200; index++) {
    // ~3 elements per ~400 bytes keeps near-limit fixtures under the 5,000-element bound.
    const row = `<div class="r${index % 7}"><span>Item ${seed}-${index}</span><p>${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(6)}${index}</p></div>`;
    rows.push(row);
    size += row.length;
  }
  return `<!doctype html><html><head><style>.r0{color:#123}body{font-family:system-ui}</style></head><body><h1 id="title">Frame ${seed}</h1>${rows.join("")}</body></html>`;
}

function percentile(values: number[], quantile: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

async function measureFixture(fixture: Fixture) {
  const dir = await mkdtemp(path.join(tmpdir(), "ork-design-bench-"));
  const service = new DesignService(dir, () => {}, undefined, {});
  const env = "bench-env";
  try {
    const canvas = await service.create(env, fixture.label);
    let revision = canvas.revision;
    const frameIds: string[] = [];
    for (let index = 0; index < fixture.frames; index++) {
      const created = await service.createFrame(
        canvas.id,
        env,
        revision,
        {
          name: `Frame ${index}`,
          x: index * 900,
          y: 0,
          width: 800,
          height: 600,
          html: syntheticHtml(fixture.htmlBytes, index),
        },
        "user",
      );
      frameIds.push(created.frame.id);
      revision = created.canvasRevision;
    }
    const snapshot = await service.snapshot(env, canvas.id);
    const snapshotBytes = bytes(snapshot);
    const target = frameIds[0]!;
    const latencies: number[] = [];
    const deltaBytes: number[] = [];
    const commitBytes: number[] = [];
    for (let sample = 0; sample < SAMPLES; sample++) {
      const before = await service.getFrame(canvas.id, env, target);
      const state = await service.snapshot(env, canvas.id);
      if (state.kind !== "snapshot") throw new Error("unexpected snapshot state");
      const committed = service.metrics.commitBytes;
      const started = performance.now();
      await service.mutate(canvas.id, env, target, before.revision, { x: before.x + 1 }, "user");
      latencies.push(performance.now() - started);
      commitBytes.push(service.metrics.commitBytes - committed);
      const delta = await service.sync(
        env,
        canvas.id,
        service.generation,
        state.canvas.revision,
        state.workspace.statusVersion,
      );
      deltaBytes.push(bytes(delta));
    }
    // No-op: equal geometry commits no revision and no history.
    const current = await service.getFrame(canvas.id, env, target);
    const beforeNoop = (await service.get(canvas.id, env)).revision;
    await service.mutate(canvas.id, env, target, current.revision, { x: current.x }, "user");
    const noopKeptRevision = (await service.get(canvas.id, env)).revision === beforeNoop;
    // Batch of 8 geometry edits versus 8 separate commits.
    const commitsBefore = service.metrics.commits;
    const batchStarted = performance.now();
    const latest = await service.get(canvas.id, env);
    await service.runOnce(env, "user", {
      canvasId: canvas.id,
      input: {
        kind: "batch",
        operations: frameIds.slice(0, Math.min(8, frameIds.length)).map((frameId, index) => ({
          kind: "update_frame" as const,
          frameId,
          patch: { y: 10 + index },
        })),
      },
      preconditions: { canvasRevision: latest.revision },
    });
    const batchMs = performance.now() - batchStarted;
    const batchCommits = service.metrics.commits - commitsBefore;
    // Compact versus full agent response for an HTML replacement.
    const fresh = await service.getFrame(canvas.id, env, target);
    const full = await runDesignAction(service, env, "replace_frame_html", {
      canvasId: canvas.id,
      frameId: target,
      expectedRevision: fresh.revision,
      html: syntheticHtml(fixture.htmlBytes, 999),
    });
    const next = await service.getFrame(canvas.id, env, target);
    const compact = await runDesignAction(service, env, "replace_frame_html", {
      canvasId: canvas.id,
      frameId: target,
      expectedRevision: next.revision,
      html: syntheticHtml(fixture.htmlBytes, 1000),
      response: "compact",
    });
    // Library listing never parses frame bodies.
    const listStarted = performance.now();
    await service.libraryPage(env, {});
    const listMs = performance.now() - listStarted;
    let style: { coldMs: number; warmP50Ms: number } | undefined;
    if (useBrowser) {
      const timings: number[] = [];
      for (let sample = 0; sample < 5; sample++) {
        const frame = await service.getFrame(canvas.id, env, target);
        const started = performance.now();
        await service.mutate(
          canvas.id,
          env,
          target,
          frame.revision,
          {
            op: "setStyles",
            selector: "#title",
            styles: { color: sample % 2 ? "rgb(1, 2, 3)" : "rgb(4, 5, 6)" },
          },
          "user",
        );
        timings.push(performance.now() - started);
      }
      style = { coldMs: timings[0]!, warmP50Ms: percentile(timings.slice(1), 0.5) };
    }
    return {
      fixture: fixture.label,
      frames: fixture.frames,
      htmlBytesPerFrame: fixture.htmlBytes,
      snapshotBytes,
      geometryDeltaBytesP50: percentile(deltaBytes, 0.5),
      geometryEditP50Ms: Number(percentile(latencies, 0.5).toFixed(2)),
      geometryEditP95Ms: Number(percentile(latencies, 0.95).toFixed(2)),
      commitBytesP50: percentile(commitBytes, 0.5),
      noopKeptRevision,
      batchOf8Commits: batchCommits,
      batchOf8Ms: Number(batchMs.toFixed(2)),
      fullResponseBytes: bytes(full),
      compactResponseBytes: bytes(compact),
      libraryListMs: Number(listMs.toFixed(2)),
      ...(style
        ? {
            styleColdMs: Number(style.coldMs.toFixed(1)),
            styleWarmP50Ms: Number(style.warmP50Ms.toFixed(1)),
          }
        : {}),
    };
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const results = [];
for (const fixture of FIXTURES) results.push(await measureFixture(fixture));
const environment = {
  bun: Bun.version,
  platform: `${process.platform}-${process.arch}`,
  chromium: useBrowser ? "available" : "not used",
  samples: SAMPLES,
};
if (json) {
  console.log(JSON.stringify({ environment, results }, null, 2));
} else {
  console.log(`Design benchmark — ${JSON.stringify(environment)}`);
  console.table(results);
}
