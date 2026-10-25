/**
 * On-demand preparation of the container preview worker image, so a
 * packaged install can switch interactive previews to container isolation
 * without a restart (`transcript_artifact_prepare_worker`).
 *
 * Two fixed routes, chosen by checked-in data only, never by a request:
 * - `pull`: the published, digest-pinned image recorded by
 *   docker/artifact-preview-worker/publish.sh in `published-image.json`
 *   (shipped as `artifact-runtime/published-image.json`);
 * - `build`: `docker build` of the worker build context the backend build
 *   ships in `artifact-runtime/worker-context/` (Dockerfile, npm manifest and
 *   lockfile, worker bundle, pinned renderer bundles, licenses). In a source
 *   checkout the context is staged with stage-context.ts first.
 *
 * Every Docker invocation has a fixed argument vector and a time bound; its
 * output is never logged (only the resulting image id is read). The built id
 * is recorded in a host-local pin under the data directory so later startups
 * run that exact id. Nothing here is reachable from artifact content.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runDocker } from "./preview-supervisor.js";

/** Upper bound for a worker image build or pull (base image download included). */
export const WORKER_PREPARE_TIMEOUT_MS = 10 * 60_000;
/** Upper bound for staging the build context in a source checkout. */
const STAGE_TIMEOUT_MS = 2 * 60_000;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
/** A registry repository without tag or digest (validated, never interpolated into a shell). */
const REPOSITORY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::\d{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;

export interface PublishedWorkerImage {
  /** `<repository>@sha256:<digest>`, content-addressed. */
  reference: string;
  repository: string;
  digest: string;
}

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

/** Candidate locations of the checked-in published image pin. */
export function resolvePublishedPinFile(baseDir = moduleDirectory()): string | undefined {
  return [
    path.join(baseDir, "artifact-runtime", "published-image.json"),
    path.join(baseDir, "published-image.json"),
    path.resolve(baseDir, "../../../../../docker/artifact-preview-worker/published-image.json"),
  ].find((candidate) => existsSync(candidate));
}

/** The published digest pin, or null while nothing has been published. */
export function readPublishedWorkerImage(
  file: string | null | undefined,
): PublishedWorkerImage | null {
  if (!file) return null;
  try {
    const pin = JSON.parse(readFileSync(file, "utf8")) as { image?: unknown; digest?: unknown };
    if (typeof pin.image !== "string" || typeof pin.digest !== "string") return null;
    if (!REPOSITORY.test(pin.image) || !DIGEST.test(pin.digest)) return null;
    return {
      reference: `${pin.image}@${pin.digest}`,
      repository: pin.image,
      digest: pin.digest,
    };
  } catch {
    return null;
  }
}

/** Host-local pin of a worker image built by this backend (like build.sh's image-pin.json). */
export function localWorkerPinFile(dataDir: string): string {
  return path.join(dataDir, "artifact-preview-worker", "image-pin.json");
}

async function writePin(file: string, tag: string, id: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ tag, id }, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
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
  | { ok: true; method: "build" | "pull"; reference: string; pinned: true }
  | { ok: false; method: "build" | "pull" | null; reason: string };

export interface WorkerPrepareOptions {
  docker: string;
  /** Local tag for a built image. */
  tag: string;
  dataDir: string;
  published: PublishedWorkerImage | null;
  buildContext: { context: string | null; stageScript: string | null };
  timeoutMs?: number;
  /** Test seam: Docker command runner (fixed vectors in, exit code and bounded stdout out). */
  runDocker?: typeof runDocker;
}

export function canPrepareWorker(
  options: Pick<WorkerPrepareOptions, "published" | "buildContext">,
): boolean {
  return (
    options.published !== null ||
    options.buildContext.context !== null ||
    options.buildContext.stageScript !== null
  );
}

/**
 * Pull the published digest, or build the shipped context. Returns the
 * content-addressed reference to run, or a content-free reason.
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

  if (options.published) {
    const pulled = await docker(
      options.docker,
      ["pull", "--quiet", options.published.reference],
      timeoutMs,
    );
    if (pulled.code === 0) {
      const inspect = await docker(options.docker, [
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        options.published.reference,
      ]);
      if (inspect.code === 0)
        return { ok: true, method: "pull", reference: options.published.reference, pinned: true };
    }
    if (!options.buildContext.context && !options.buildContext.stageScript)
      return {
        ok: false,
        method: "pull",
        reason: "The published preview worker image could not be pulled",
      };
  }

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
    const built = await docker(
      options.docker,
      [
        "build",
        "--quiet",
        "--pull=false",
        "--label",
        "orkestrator.artifact-preview-worker=1",
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
    await writePin(localWorkerPinFile(options.dataDir), options.tag, id);
    return { ok: true, method: "build", reference: id, pinned: true };
  } finally {
    if (staged) rmSync(staged, { recursive: true, force: true });
  }
}
