/**
 * Local diff scan benchmark (docs/architecture/git-scan-caches.md).
 *
 * Builds the named workload, then runs `getLocalGitStatusDetailed` against it
 * and reports git processes per scan by verb, untracked files read per scan and
 * scan time. Results are local measurements, not guarantees.
 *
 * Workload `scan-1k`: 1,000 tracked files of 40 lines, 20 of them modified,
 * 5 renamed with an edit and 5 deleted, plus `--untracked` (default 200)
 * untracked files of 40 lines. Files are left to age `--settle-ms` first, so a
 * warm scan sees them as settled. The base is an immutable commit, the common
 * case for an environment, or a remote-tracking branch.
 *
 * `--core` reads the scanner from another tree, so two versions can be compared
 * in interleaved runs on a loaded host:
 *
 *   git archive <commit> apps/backend/src/core | tar -x -C output/benchmarks/scan-before
 *   bun scripts/benchmark-local-diff-scan.ts --core=output/benchmarks/scan-before/apps/backend/src/core
 *
 *   bun scripts/benchmark-local-diff-scan.ts [--runs=20] [--untracked=200]
 *     [--settle-ms=2500] [--core=<dir>] [--json]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function arg(name: string, fallback: string): string {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
}

const runs = Number(arg("runs", "20"));
const untrackedCount = Number(arg("untracked", "200"));
const settleMs = Number(arg("settle-ms", "2500"));
const asJson = process.argv.includes("--json");
const core = path.resolve(arg("core", path.join(import.meta.dir, "../apps/backend/src/core")));

const { getLocalGitStatusDetailed } = await import(path.join(core, "commands-files.ts"));
const { observeCommandInvocations } = await import(path.join(core, "shell.ts"));
const { recurringWorkMetrics } = await import(path.join(core, "recurring-work-metrics.ts"));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "b",
      GIT_AUTHOR_EMAIL: "b@e",
      GIT_COMMITTER_NAME: "b",
      GIT_COMMITTER_EMAIL: "b@e",
    },
  }).toString();
}

function percentile(values: number[], quantile: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

function lines(seed: string): string {
  return Array.from({ length: 40 }, (_, line) => `${seed} line ${line}\n`).join("");
}

function buildWorkload(): { repo: string; commit: string } {
  const repo = mkdtempSync(path.join(tmpdir(), "ork-bench-scan-"));
  git(repo, "init", "-q", "-b", "main");
  for (let index = 0; index < 1_000; index++) {
    const directory = path.join(repo, `dir ${index % 20}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, `file-${index}.txt`), lines(`tracked ${index}`));
  }
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  const commit = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "update-ref", "refs/remotes/origin/main", commit);
  const file = (index: number) => path.join(repo, `dir ${index % 20}`, `file-${index}.txt`);
  for (let index = 0; index < 20; index++) {
    writeFileSync(file(index), `${lines(`tracked ${index}`)}edited\n`);
  }
  for (let index = 20; index < 25; index++) {
    const moved = path.join(repo, `dir ${index % 20}`, `moved ${index}.txt`);
    renameSync(file(index), moved);
    writeFileSync(moved, `${lines(`tracked ${index}`)}edited\n`);
    git(repo, "add", "-A", `dir ${index % 20}`);
  }
  for (let index = 25; index < 30; index++) unlinkSync(file(index));
  mkdirSync(path.join(repo, "untracked"));
  for (let index = 0; index < untrackedCount; index++) {
    writeFileSync(path.join(repo, "untracked", `new-${index}.txt`), lines(`untracked ${index}`));
  }
  return { repo, commit };
}

function fileReadsCharged(): number {
  return recurringWorkMetrics.snapshot().kinds["diff-scan"]?.workUnits?.["file-read"] ?? 0;
}

const fetches = { ensureFetched: async () => undefined };

async function scan(repo: string, base: string) {
  const verbs = new Map<string, number>();
  const stop = observeCommandInvocations("git", (args: readonly string[]) => {
    const verb = args.find(
      (value) => value === "diff" || value === "status" || value === "rev-parse",
    );
    const key = verb ?? (args.includes("config") ? "config" : "other");
    verbs.set(key, (verbs.get(key) ?? 0) + 1);
  });
  const readsBefore = fileReadsCharged();
  const started = performance.now();
  const result = await recurringWorkMetrics.observe("diff-scan", () =>
    getLocalGitStatusDetailed(repo, base, true, fetches, false),
  );
  const ms = performance.now() - started;
  stop();
  return {
    ms,
    gitProcesses: [...verbs.values()].reduce((sum, count) => sum + count, 0),
    verbs: Object.fromEntries([...verbs.entries()].sort()),
    untrackedReads: fileReadsCharged() - readsBefore,
    files: result.changes.length,
  };
}

async function measure(repo: string, name: string, base: string) {
  const first = await scan(repo, base);
  const warm = [];
  for (let run = 0; run < runs; run++) warm.push(await scan(repo, base));
  const times = warm.map((entry) => entry.ms);
  const last = warm.at(-1)!;
  return {
    workload: `scan-1k/${name}`,
    untracked: untrackedCount,
    files: last.files,
    first: { gitProcesses: first.gitProcesses, verbs: first.verbs },
    warm: {
      gitProcesses: last.gitProcesses,
      verbs: last.verbs,
      untrackedReads: last.untrackedReads,
      p50Ms: Math.round(percentile(times, 0.5) * 10) / 10,
      p95Ms: Math.round(percentile(times, 0.95) * 10) / 10,
    },
  };
}

const { repo, commit } = buildWorkload();
try {
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const results = [await measure(repo, "commit-base", commit)];
  results.push(await measure(repo, "tracking-base", "main"));
  if (asJson) console.log(JSON.stringify({ core, runs, results }));
  else {
    for (const entry of results) {
      console.log(
        `${entry.workload}: files=${entry.files} first=${entry.first.gitProcesses} git, ` +
          `warm=${entry.warm.gitProcesses} git ${JSON.stringify(entry.warm.verbs)}, ` +
          `untracked reads=${entry.warm.untrackedReads}/${entry.untracked}, ` +
          `p50=${entry.warm.p50Ms} ms, p95=${entry.warm.p95Ms} ms`,
      );
    }
  }
} finally {
  rmSync(repo, { recursive: true, force: true });
}
