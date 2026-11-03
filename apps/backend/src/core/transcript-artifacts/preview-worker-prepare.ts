/**
 * On-demand preparation of the container preview worker image, so a
 * packaged install can switch interactive previews to container isolation
 * without a restart (`transcript_artifact_prepare_worker`).
 *
 * One fixed route: `docker build` of the worker build context the backend
 * build ships in `artifact-runtime/worker-context/` (Dockerfile, npm manifest
 * and lockfile, worker bundle, pinned renderer bundles, licenses). In a source
 * checkout the context is staged with stage-context.ts first. Nothing is ever
 * pulled by name: the image is built only from the install's own files.
 *
 * Every Docker invocation has a fixed argument vector and a time bound; its
 * output is never logged (only the resulting image id is read). A built image
 * is labelled with its context digest, and its id is recorded in a host-local
 * pin under the data directory with that digest, so later startups run that
 * exact id and can tell when an upgrade shipped another context. Nothing here
 * is reachable from artifact content.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runDocker } from "./preview-supervisor.js";
import { WORKER_CONTEXT_LABEL, workerContextDigest } from "./preview-worker-context-digest.js";

/** Upper bound for a worker image build (base image download included). */
export const WORKER_PREPARE_TIMEOUT_MS = 10 * 60_000;
/** Upper bound for staging the build context in a source checkout. */
const STAGE_TIMEOUT_MS = 2 * 60_000;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

function moduleDirectory(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** Shipped (packaged) or staged-on-demand (source checkout) worker build context. */
export function resolveWorkerBuildContext(baseDir = moduleDirectory()): {
  context: string | null;
  stageScript: string | null;
} {
  const shipped = [
    path.join(baseDir, "artifact-runtime", "worker-context"),
    path.join(baseDir, "worker-context"),
  ].find((candidate) => existsSync(path.join(candidate, "Dockerfile")));
  if (shipped) return { context: shipped, stageScript: null };
  const script = path.resolve(
    baseDir,
    "../../../../../docker/artifact-preview-worker/stage-context.ts",
  );
  return { context: null, stageScript: existsSync(script) ? script : null };
}

/** Host-local pin of a worker image built by this backend (like build.sh's image-pin.json). */
export function localWorkerPinFile(dataDir: string): string {
  return path.join(dataDir, "artifact-preview-worker", "image-pin.json");
}

async function writePin(
  file: string,
  tag: string,
  id: string,
  contextDigest: string | null,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  const pin = contextDigest ? { tag, id, contextDigest } : { tag, id };
  await writeFile(temp, `${JSON.stringify(pin, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

/** The context's digest, or null when it cannot be read as a build context. */
export async function buildContextDigest(context: string): Promise<string | null> {
  try {
    return await workerContextDigest(context);
  } catch {
    return null;
  }
}

/** Runs the staging script with fixed arguments and a scrubbed environment. */
function stageContext(script: string, target: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, target], {
      stdio: "ignore",
      windowsHide: true,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir() },
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), STAGE_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export type WorkerPrepareResult =
  | { ok: true; method: "build"; reference: string; pinned: true }
  | { ok: false; method: "build" | null; reason: string };

export interface WorkerPrepareOptions {
  docker: string;
  /** Local tag for a built image. */
  tag: string;
  dataDir: string;
  buildContext: { context: string | null; stageScript: string | null };
  timeoutMs?: number;
  /** Test seam: Docker command runner (fixed vectors in, exit code and bounded stdout out). */
  runDocker?: typeof runDocker;
}

/** Preparation needs a build context, shipped or stageable. */
export function canPrepareWorker(options: Pick<WorkerPrepareOptions, "buildContext">): boolean {
  return options.buildContext.context !== null || options.buildContext.stageScript !== null;
}

/**
 * Build this backend's worker context. Returns the content-addressed
 * reference to run, or a content-free reason.
 */
export async function prepareWorkerImage(
  options: WorkerPrepareOptions,
): Promise<WorkerPrepareResult> {
  const docker = options.runDocker ?? runDocker;
  const timeoutMs = options.timeoutMs ?? WORKER_PREPARE_TIMEOUT_MS;
  const version = await docker(
    options.docker,
    ["version", "--format", "{{.Server.Version}}"],
    15_000,
  );
  if (version.code !== 0)
    return {
      ok: false,
      method: null,
      reason: "Docker is not installed or its daemon is not running",
    };

  let context = options.buildContext.context;
  let staged: string | null = null;
  try {
    if (!context) {
      if (!options.buildContext.stageScript)
        return {
          ok: false,
          method: "build",
          reason: "No preview worker build context ships with this installation",
        };
      staged = mkdtempSync(path.join(tmpdir(), "ork-preview-worker-context-"));
      if (!(await stageContext(options.buildContext.stageScript, staged)))
        return {
          ok: false,
          method: "build",
          reason: "The preview worker build context could not be staged",
        };
      context = staged;
    }

    // Labels the image, so startup can tell when an upgrade shipped another context.
    const contextDigest = await buildContextDigest(context);

    const built = await docker(
      options.docker,
      [
        "build",
        "--quiet",
        "--pull=false",
        "--label",
        "orkestrator.artifact-preview-worker=1",
        // An unreadable context is still built; unlabelled, it is never
        // mistaken for any shipped context's worker.
        ...(contextDigest ? ["--label", `${WORKER_CONTEXT_LABEL}=${contextDigest}`] : []),
        "--tag",
        options.tag,
        context,
      ],
      timeoutMs,
    );
    if (built.code !== 0)
      return {
        ok: false,
        method: "build",
        reason:
          built.code === null
            ? "Building the preview worker image timed out or Docker could not be started"
            : "Building the preview worker image failed",
      };
    const inspect = await docker(options.docker, [
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      options.tag,
    ]);
    const id = inspect.stdout.trim();
    if (inspect.code !== 0 || !IMAGE_ID.test(id))
      return {
        ok: false,
        method: "build",
        reason: "The built preview worker image could not be inspected",
      };
    await writePin(localWorkerPinFile(options.dataDir), options.tag, id, contextDigest);
    return { ok: true, method: "build", reference: id, pinned: true };
  } finally {
    if (staged) rmSync(staged, { recursive: true, force: true });
  }
}
