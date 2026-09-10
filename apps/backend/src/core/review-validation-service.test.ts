import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  newReviewValidationRun,
  REVIEW_VALIDATION_OUTPUT_MAX_BYTES,
} from "@orkestrator/protocol/review-workflow";
import {
  controlReviewValidation,
  readReviewValidationOutput,
  stopEnvironmentReviewValidation,
  validationPreparation,
} from "./review-validation-service.js";
import {
  generateLoopedReviewPackage,
  parseReviewPreparationValidation,
  verifyEnvironmentReviewPackage,
} from "./commands-review.js";
import type { CommandContext } from "./commands-context.js";

test("validation output reader returns a bounded tail and rejects replaced artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "validation-output-reader-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "validation-output-outside-"));
  const run = newReviewValidationRun("review-validation-reader", {
    headRef: "a".repeat(40),
    commands: [
      {
        id: "check",
        command: "bun run check",
        cwd: ".",
        dependsOn: [],
        resources: [],
        weight: 1,
        timeoutMs: 1_000,
      },
    ],
    limitations: [],
  });
  const directory = path.join(root, ".orkestrator", "review-artifacts", run.id);
  const relativeArtifact = `.orkestrator/review-artifacts/${run.id}/validation-01.stdout.txt`;
  const artifact = path.join(root, relativeArtifact);
  const statePath = path.join(directory, "state.json");
  const content = Buffer.concat([
    Buffer.from("discarded-prefix"),
    Buffer.alloc(REVIEW_VALIDATION_OUTPUT_MAX_BYTES, "x"),
  ]);
  Object.assign(run, { status: "completed", completedAt: new Date().toISOString() });
  Object.assign(run.results[0]!, {
    status: "passed",
    exitCode: 0,
    stdoutPath: relativeArtifact,
  });
  const environment = {
    id: "env",
    status: "running",
    environmentType: "local",
    worktreePath: root,
  };
  const context = {
    storage: { getEnvironment: async () => environment },
    appRoot: root,
    resourceRoot: root,
    toolchainBinDir: path.dirname(process.execPath),
  } as unknown as CommandContext;

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(artifact, content);
    await writeFile(statePath, JSON.stringify({ run }));

    const output = await readReviewValidationOutput("env", run.id, "check", context);
    expect(output.stdout).toMatchObject({
      totalBytes: content.byteLength,
      startOffset: Buffer.byteLength("discarded-prefix"),
    });
    expect(Buffer.from(output.stdout!.contentBase64, "base64")).toEqual(
      content.subarray(-REVIEW_VALIDATION_OUTPUT_MAX_BYTES),
    );

    run.results[0]!.stdoutPath = `.orkestrator/review-artifacts/${run.id}/other.txt`;
    await writeFile(statePath, JSON.stringify({ run }));
    await expect(readReviewValidationOutput("env", run.id, "check", context)).rejects.toThrow(
      "Validation artifact identity changed",
    );

    run.results[0]!.stdoutPath = relativeArtifact;
    await writeFile(statePath, JSON.stringify({ run }));
    const outsideArtifact = path.join(outsideRoot, "outside.txt");
    await writeFile(outsideArtifact, "outside");
    await rm(artifact);
    await symlink(outsideArtifact, artifact);
    await expect(readReviewValidationOutput("env", run.id, "check", context)).rejects.toThrow(
      "Validation artifact is not confined",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("real backend runner seals hashed evidence and refuses a moved head or replaced log", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "validation-service-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  await writeFile(path.join(root, "source"), "fixture");
  git("add", ".");
  git("commit", "-m", "fixture");
  const head = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", head);
  const environment = {
    id: "env",
    status: "running",
    environmentType: "local",
    worktreePath: root,
  };
  const reviews: unknown[] = [];
  const context = {
    storage: {
      getEnvironment: async () => environment,
      listMultiReviewWorkflows: async () => reviews,
      listAllBuildPipelines: async () => [],
    },
    appRoot: root,
    resourceRoot: root,
    toolchainBinDir: path.dirname(process.execPath),
  } as unknown as CommandContext;
  const initial = newReviewValidationRun("review-validation-fixture", {
    headRef: head,
    commands: [
      {
        id: "check",
        command: "printf evidence",
        cwd: ".",
        dependsOn: [],
        resources: [],
        weight: 1,
        timeoutMs: 1000,
      },
    ],
    limitations: [],
  });
  try {
    let run = await controlReviewValidation("env", initial, "start", context);
    const deadline = Date.now() + 10000;
    while (["planned", "running"].includes(run.status) && Date.now() < deadline) {
      await Bun.sleep(50);
      run = await controlReviewValidation("env", run, "status", context);
    }
    expect(run.status).toBe("completed");
    const output = await readReviewValidationOutput("env", run.id, "check", context);
    expect(Buffer.from(output.stdout!.contentBase64, "base64").toString()).toBe("evidence");
    expect(output.stdout).toMatchObject({ totalBytes: 8, startOffset: 0 });
    expect(output.stderr).toMatchObject({ contentBase64: "", totalBytes: 0, startOffset: 0 });
    const preparation = validationPreparation(run);
    const validation = parseReviewPreparationValidation(preparation.validation, run.id);
    expect(validation[0]!.stdoutSha256).toHaveLength(64);
    const pkg = await generateLoopedReviewPackage(
      "env",
      run.id,
      1,
      "main",
      validation,
      [],
      [],
      context,
      { expectedHead: head, validationPlan: run.plan },
    );
    expect(await verifyEnvironmentReviewPackage("env", pkg, context)).toEqual({ valid: true });
    const slow = newReviewValidationRun("review-validation-stop-fixture", {
      ...initial.plan,
      commands: [{ ...initial.plan.commands[0]!, command: "sleep 20", timeoutMs: 30000 }],
    });
    reviews.push({ environmentId: "env", snapshot: { environmentId: "env", validationRun: slow } });
    await controlReviewValidation("env", slow, "start", context);
    await stopEnvironmentReviewValidation("env", context);
    expect((await controlReviewValidation("env", slow, "status", context)).status).toBe(
      "cancelled",
    );
    expect(
      generateLoopedReviewPackage("env", run.id, 1, "main", validation, [], [], context, {
        expectedHead: "0".repeat(40),
      }),
    ).rejects.toThrow("HEAD changed");
    const stdout = path.join(root, run.results[0]!.stdoutPath!);
    await chmod(stdout, 0o600);
    await writeFile(stdout, "modified");
    expect(await verifyEnvironmentReviewPackage("env", pkg, context)).toMatchObject({
      valid: false,
      reason: "Validation artifact SHA-256 changed",
    });
  } finally {
    await stopEnvironmentReviewValidation("env", context).catch(() => {});
    await controlReviewValidation("env", initial, "cancel", context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
