/**
 * CPU cost of one web-annotation create as the environment fills up
 * (docs/architecture/web-page-annotations.md, "Commit cost").
 *
 *   bun scripts/web-annotation-commit-profile.ts [--levels=0,500,1000,1900] [--samples=25] [--json]
 *
 * Creates real notes through the service (fake dispatch, temp data directory)
 * and, at each level, measures `samples` creates: median process CPU ms per
 * create, and the rows and collections the commit planned (from the commit
 * metrics). Run it on a quiet host; on a loaded one compare proportions only.
 * Content is synthetic.
 */
import { cpus, loadavg } from "node:os";
import { fixtureCaptureInput } from "../packages/protocol/src/testing/web-annotations-fixtures";
import { ENV_A, createHarness } from "../apps/backend/src/core/web-annotation-test-support";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key!, value ?? "true"] as const;
  }),
);
const levels = (args.get("levels") ?? "0,500,1000,1900").split(",").map(Number);
const samples = Number(args.get("samples") ?? 25);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

const harness = await createHarness({ verifyRowPlans: false });
const service = harness.service;
let created = 0;
const create = () =>
  service.create({
    environmentId: ENV_A,
    operationId: `op-profile-${created++}`,
    capture: fixtureCaptureInput("element"),
    body: `Profile note ${created}`,
  });
const gauge = (name: string): number | null => {
  const snapshot = service.metrics.snapshot() as { gauges?: Record<string, number> };
  return snapshot.gauges?.[name] ?? null;
};

const rows: Array<Record<string, number | null>> = [];
try {
  for (const level of levels) {
    while (created < level) await create();
    const cpu: number[] = [];
    const serialized: number[] = [];
    const copied: number[] = [];
    for (let index = 0; index < samples; index++) {
      Bun.gc(false);
      const before = process.cpuUsage();
      await create();
      const used = process.cpuUsage(before);
      cpu.push((used.user + used.system) / 1000);
      const rowsSerialized = gauge("storage_commit_rows_serialized|scope=manifest");
      const collectionsCopied = gauge("storage_commit_collections_copied|scope=manifest");
      if (rowsSerialized !== null) serialized.push(rowsSerialized);
      if (collectionsCopied !== null) copied.push(collectionsCopied);
    }
    rows.push({
      notes: level,
      createCpuMs: Number(median(cpu).toFixed(2)),
      rowsSerialized: serialized.length > 0 ? median(serialized) : null,
      collectionsCopied: copied.length > 0 ? median(copied) : null,
    });
  }
} finally {
  await harness.cleanup();
}

const host = { cores: cpus().length, load1: Number(loadavg()[0]!.toFixed(1)) };
if (args.has("json")) {
  console.log(JSON.stringify({ host, samples, rows }, null, 2));
} else {
  console.log(`host: ${host.cores} cores, load ${host.load1}; ${samples} creates per level`);
  console.table(rows);
}
