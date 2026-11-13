import { expect } from "bun:test";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  newReviewValidationRun,
  isReviewValidationRun,
  type ReviewValidationPlan,
  type ReviewValidationRun,
} from "@orkestrator/protocol/review-workflow";
import { REVIEW_VALIDATION_CONTROL, REVIEW_VALIDATION_WORKER } from "./review-validation-worker.js";

// Shared fixtures for the review-validation-worker.*.test.ts files. Every test
// there spawns a real validation worker plus a Bun control process per start,
// status or cancel, so the suite is split by aspect and each file registers
// the cleanup below with its own afterEach.

export const fixtures: Array<{ root: string; run: ReviewValidationRun }> = [];
export const extraRoots: string[] = [];
export async function gitOnPath(script: string): Promise<Record<string, string>> {
  const bin = await mkdtemp(path.join(tmpdir(), "review-validation-git-"));
  extraRoots.push(bin);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  await writeFile(
    path.join(bin, "git"),
    `#!/usr/bin/env bash\n${script}\nexec ${JSON.stringify(realGit)} "$@"\n`,
    { mode: 0o755 },
  );
  return { PATH: `${bin}:${process.env.PATH}` };
}
export const command = (
  id: string,
  shell: string,
  extra: Partial<ReviewValidationPlan["commands"][number]> = {},
) => ({
  id,
  command: shell,
  cwd: ".",
  dependsOn: [],
  resources: [],
  weight: 1 as const,
  timeoutMs: 5000,
  ...extra,
});
export async function fixture(commands: ReviewValidationPlan["commands"] = []) {
  const root = await mkdtemp(path.join(tmpdir(), "review-validation-test-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  await writeFile(path.join(root, "source.txt"), "original\n");
  await writeFile(path.join(root, ".gitignore"), ".orkestrator/\n");
  git("add", ".");
  git("commit", "-m", "fixture");
  const run = newReviewValidationRun(`review-validation-${randomUUID()}`, {
    headRef: git("rev-parse", "HEAD"),
    commands,
    limitations: commands.length ? [] : ["No checks configured"],
  });
  const entry = { root, run };
  fixtures.push(entry);
  return { ...entry, git };
}
export async function control(
  root: string,
  run: ReviewValidationRun,
  action = "start",
  extraEnv: Record<string, string | undefined> = {},
  resultId?: string,
  workerSource = REVIEW_VALIDATION_WORKER,
  targetRef?: string,
) {
  const payload = Buffer.from(JSON.stringify({ root, run, action, resultId, targetRef })).toString(
    "base64",
  );
  const child = Bun.spawn(
    [process.execPath, "-e", REVIEW_VALIDATION_CONTROL, payload, workerSource],
    {
      cwd: "/",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ORKESTRATOR_TEST_SCHEDULER_DIR: path.join(root, ".orkestrator", "scheduler"),
        // The host budget defaults to the logical core count, and an unmeasured
        // command asks for four slots. On a four-core CI runner the first
        // command took every slot, so commands these tests expect to overlap
        // ran one after another. Tests that need a smaller host say so.
        ORKESTRATOR_TEST_HOST_WORKERS: "8",
        ...extraEnv,
      },
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(stderr);
  const result: unknown = JSON.parse(stdout);
  expect(isReviewValidationRun(result)).toBe(true);
  return result as ReviewValidationRun;
}

async function observeWorkerState(root: string, expected: ReviewValidationRun) {
  const statePath = path.join(root, ".orkestrator", "review-artifacts", expected.id, "state.json");
  const info = await stat(statePath);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error("Invalid fixture state file");
  const record = JSON.parse(await readFile(statePath, "utf8")) as {
    run?: unknown;
    heartbeat?: unknown;
  };
  if (!isReviewValidationRun(record.run)) throw new Error("Invalid fixture validation run");
  if (
    record.run.id !== expected.id ||
    JSON.stringify(record.run.plan) !== JSON.stringify(expected.plan)
  )
    throw new Error("Fixture validation identity changed");
  if (typeof record.heartbeat !== "number") throw new Error("Invalid fixture heartbeat");
  return record.run;
}

export async function observeUntil(
  root: string,
  run: ReviewValidationRun,
  predicate: (next: ReviewValidationRun) => boolean,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let next: ReviewValidationRun | undefined;
  while (Date.now() < deadline) {
    try {
      next = await observeWorkerState(root, run);
      if (predicate(next)) return next;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await Bun.sleep(20);
  }
  throw new Error(
    `Timed out observing validation ${run.id}: ${next?.status ?? "state not created"}`,
  );
}

export async function completed(root: string, run: ReviewValidationRun) {
  const started = await control(root, run);
  if (["planned", "running"].includes(started.status)) {
    await observeUntil(root, run, (next) => !["planned", "running"].includes(next.status), 12_000);
  }
  const final = await control(root, run, "status");
  expect(["planned", "running"]).not.toContain(final.status);
  return final;
}
export async function waitUntilQueued(root: string, run: ReviewValidationRun) {
  await observeUntil(root, run, (next) => next.results[0]?.status === "queued", 3_000);
  const next = await control(root, run, "status");
  expect(next.results[0]!.status).toBe("queued");
  return next;
}
export async function waitFor(
  root: string,
  run: ReviewValidationRun,
  timeoutMs: number,
  extraEnv: Record<string, string | undefined> = {},
) {
  const started = await control(root, run, "start", extraEnv);
  if (["planned", "running"].includes(started.status)) {
    await observeUntil(
      root,
      run,
      (next) => !["planned", "running"].includes(next.status),
      timeoutMs,
    );
  }
  const final = await control(root, run, "status");
  expect(["planned", "running"]).not.toContain(final.status);
  return final;
}
export async function cooperativeFixture(
  commands: ReviewValidationPlan["commands"],
  scripts: Record<string, string>,
) {
  const context = await fixture(commands);
  const modulePath = path.resolve(import.meta.dir, "../../../../scripts/test-admission.ts");
  await writeFile(
    path.join(context.root, ".orkestrator-test-scheduler.json"),
    JSON.stringify({
      version: 1,
      cooperativeCommands: Object.keys(scripts).map((name) => `bun ${name}`),
    }),
  );
  for (const [name, source] of Object.entries(scripts))
    await writeFile(
      path.join(context.root, name),
      source.replaceAll("__MODULE__", JSON.stringify(modulePath)),
    );
  context.git("add", ".");
  context.git("commit", "-m", "cooperative runner");
  context.run.plan.headRef = context.git("rev-parse", "HEAD");
  return context;
}

/** Cancels every live run and deletes the roots created since the last call. */
export async function cleanupReviewValidationFixtures() {
  for (const { root, run } of fixtures.splice(0)) {
    await control(root, run, "cancel").catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
  await Promise.all(extraRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}
