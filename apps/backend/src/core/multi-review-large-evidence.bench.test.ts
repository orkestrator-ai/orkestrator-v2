/**
 * Opt-in large-evidence verification benchmark (real files, real hashing).
 *
 * The efficiency benchmark fakes package verification, so it proves how often
 * Multi Review verifies (two verifications per evidence generation at any panel
 * size) but not what one verification costs. This case writes validation
 * artifacts totalling `ORKESTRATOR_MULTI_REVIEW_LARGE_EVIDENCE_MIB` MiB into a
 * temporary local worktree, each within the validation worker's 32 MiB stream
 * bound, and times `verifyValidationArtifacts` hashing them, with peak RSS.
 * Skipped unless the variable is set, because it writes and reads hundreds of
 * MiB:
 *
 *   ORKESTRATOR_MULTI_REVIEW_LARGE_EVIDENCE_MIB=512 \
 *   MULTI_REVIEW_LARGE_EVIDENCE_OUT=/tmp/large-evidence.json \
 *     bun test --cwd apps/backend ./src/core/multi-review-large-evidence.bench.test.ts
 *
 * With `MULTI_REVIEW_LARGE_EVIDENCE_OUT` it writes one content-free JSON
 * result (sizes, counts, times, RSS only); test output does not reach the
 * console.
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Environment } from "./models.js";
import { verifyValidationArtifacts } from "./review-validation-artifacts.js";

const MIB = 1024 * 1024;
const ARTIFACT_MAX_MIB = 32;
const requestedMiB = Number(process.env.ORKESTRATOR_MULTI_REVIEW_LARGE_EVIDENCE_MIB ?? "");
const enabled = Number.isFinite(requestedMiB) && requestedMiB > 0;
const OUTPUT_PATH = process.env.MULTI_REVIEW_LARGE_EVIDENCE_OUT;

async function writeArtifact(file: string, mib: number, seed: number): Promise<string> {
  const hash = createHash("sha256");
  const block = Buffer.alloc(MIB);
  const stream = createWriteStream(file);
  for (let index = 0; index < mib; index += 1) {
    // Distinct content per MiB, so no two artifacts or blocks share a digest.
    block.writeUInt32LE(seed, 0);
    block.writeUInt32LE(index, 4);
    hash.update(block);
    if (!stream.write(block)) await new Promise((resolve) => stream.once("drain", resolve));
  }
  await new Promise<void>((resolve, reject) =>
    stream.end((error?: Error | null) => (error ? reject(error) : resolve())),
  );
  return hash.digest("hex");
}

test.skipIf(!enabled)(
  "verifies hundreds of MiB of validation evidence with real hashing in bounded memory",
  async () => {
    const totalMiB = Math.ceil(requestedMiB);
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "mr-large-evidence-")));
    try {
      const directory = path.join(root, ".orkestrator", "review-artifacts", "bench");
      await mkdir(directory, { recursive: true });
      const entries: Array<{
        stdoutPath: string | null;
        stderrPath: string | null;
        stdoutSha256?: string;
        stderrSha256?: string;
      }> = [];
      const writeStarted = performance.now();
      for (let remaining = totalMiB, index = 0; remaining > 0; index += 1) {
        const mib = Math.min(ARTIFACT_MAX_MIB, remaining);
        remaining -= mib;
        const relative = `.orkestrator/review-artifacts/bench/command-${index}.stdout`;
        const digest = await writeArtifact(path.join(root, relative), mib, index);
        entries.push({ stdoutPath: relative, stderrPath: null, stdoutSha256: digest });
      }
      const writeMs = performance.now() - writeStarted;
      const environment = { environmentType: "local", worktreePath: root } as Environment;
      const runner = async () => "";

      const baselineRss = process.memoryUsage().rss;
      let peakRss = baselineRss;
      const sampler = setInterval(() => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }, 5);
      const runs: number[] = [];
      let verified: Awaited<ReturnType<typeof verifyValidationArtifacts>> | undefined;
      try {
        // Two verifications per evidence generation: fan-out admission and
        // consolidation. Each one re-reads and re-hashes every byte.
        for (let run = 0; run < 2; run += 1) {
          const started = performance.now();
          verified = await verifyValidationArtifacts(environment, runner, entries);
          runs.push(performance.now() - started);
        }
      } finally {
        clearInterval(sampler);
      }
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      expect(verified).toEqual({ artifacts: entries.length, bytes: totalMiB * MIB });

      // Real hashing, not a cache: one changed byte in the last artifact fails.
      const last = path.join(root, entries.at(-1)!.stdoutPath!);
      await chmod(last, 0o600);
      const handle = await open(last, "r+");
      try {
        await handle.write(Buffer.from([0xff]), 0, 1, 8);
      } finally {
        await handle.close();
      }
      await expect(verifyValidationArtifacts(environment, runner, entries)).rejects.toThrow(
        "SHA-256 changed",
      );

      const perVerifyMs = Math.max(...runs);
      const result = JSON.stringify({
        benchmark: "multi-review-large-evidence",
        totalMiB,
        artifacts: entries.length,
        writeMs: Math.round(writeMs),
        verifyMs: runs.map(Math.round),
        mibPerSecond: Math.round(totalMiB / (perVerifyMs / 1000)),
        perGenerationMs: Math.round(runs.reduce((sum, value) => sum + value, 0)),
        baselineRssMiB: Math.round(baselineRss / MIB),
        peakRssDeltaMiB: Math.round((peakRss - baselineRss) / MIB),
      });
      if (OUTPUT_PATH) await writeFile(OUTPUT_PATH, `${result}\n`);
      // Streaming hash: memory must not grow with the evidence it reads.
      expect(peakRss - baselineRss).toBeLessThan(Math.max(128 * MIB, totalMiB * MIB * 0.25));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  10 * 60_000,
);
