/**
 * Preview worker entrypoint: one job per process.
 *
 * Launched by the backend supervisor as a local child process (Bun) or as the
 * command of the pinned worker container (Node). Reads one bounded JSON job
 * package from stdin, writes NDJSON events to stdout, and exits. It never
 * logs artifact content; stderr carries only fixed diagnostic labels.
 *
 * Short-lived by design: any unexpected rejection ends the process and the
 * supervisor reports the job as failed after verifying the process tree exit.
 */
import {
  PREVIEW_WORKER_PROTOCOL,
  type WorkerEvent,
  type WorkerJobPackage,
} from "./preview-worker-protocol.js";
import { runWorkerJob } from "./preview-jobs.js";

const MAX_INPUT_BYTES = 40 * 1024 * 1024;

function write(event: WorkerEvent): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify(event)}\n`, () => resolve());
  });
}

async function readInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    total += chunk.byteLength;
    if (total > MAX_INPUT_BYTES) throw new Error("input too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const pkg = JSON.parse(await readInput()) as WorkerJobPackage;
  if (pkg?.v !== PREVIEW_WORKER_PROTOCOL || !pkg.job || !pkg.limits) throw new Error("bad package");
  const pending: Promise<void>[] = [];
  const result = await runWorkerJob(pkg, (event) => {
    pending.push(write(event));
  });
  await Promise.all(pending);
  await write({ t: "result", result });
}

main().then(
  () => process.exit(0),
  () => {
    process.stderr.write("[artifact-preview-worker] job failed\n");
    process.exit(1);
  },
);
