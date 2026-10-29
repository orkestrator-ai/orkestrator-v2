/**
 * Graph artifacts (plan P2.1, report §5.2, §5.4, §5.11): the typed values on
 * a run's edges, put, read, verified and superseded through one API.
 *
 * - **Value artifacts** (≤ 384 KiB) are stored inline in `graph-artifacts`.
 * - **Reference artifacts** are sealed files in the run's environment under
 *   `.orkestrator/graph-artifacts/<run-id>/<sha256>[.<ext>]`, Git-excluded,
 *   written read-only without following a symbolic link (on the host through
 *   the confined writer, in a container through the pinned in-container
 *   writer the review package uses), and hash-verified at the source before
 *   each consumer reads them: on the host by streaming the file, in a
 *   container with `realpath`, `stat` and `sha256sum` inside it, so no file
 *   content crosses the container boundary to be checked.
 *
 * Every artifact is checked against its type from the run's frozen plan
 * (budgets, schema, domain validator) before it is stored, so a consumer
 * never receives one that failed validation (invariant 4). Budgets: 32 MiB
 * inline and 256 MiB on disk per run, enforced by the store in the insert's
 * transaction and refused with a typed {@link GraphStorageError}.
 *
 * Nothing here logs; a failure names ids, counts and bytes, never payloads.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import {
  GRAPH_ARTIFACT_BUDGETS,
  GRAPH_ARTIFACT_FORMAT_VERSION,
  graphArtifactDigest,
  graphArtifactFilePath,
  graphArtifactId,
  graphArtifactInlineBytes,
  graphArtifactRunDirectory,
  parseGraphArtifactFilePath,
  verifyGraphArtifactIdentity,
  type GraphArtifact,
  type GraphArtifactBody,
  type GraphArtifactProducer,
  type GraphArtifactWorkspace,
  type GraphRun,
} from "@orkestrator/protocol/graphs/run";
import {
  GraphTypeLibrary,
  validateGraphArtifactValue,
  type GraphTypeDefinition,
  type GraphTypeValidationContext,
} from "@orkestrator/protocol/graphs/types";
import {
  CONTAINER_PINNED_ATTACHMENT_REMOVE,
  CONTAINER_PINNED_ATTACHMENT_WRITE,
} from "./commands-files.js";
import {
  createEnvironmentCommandRunner,
  ensureWorkspaceArtifactIsGitExcluded,
  waitForContainerReviewPackageWrite,
  type EnvironmentCommandRunner,
} from "./commands-review.js";
import type { EnvironmentMutationFence } from "./environment-replacement-fence.js";
import { GraphStorageError } from "./graph-run-errors.js";
import type { Environment } from "./models.js";
import { removeConfinedDirectory, writeConfinedFile } from "./path-safety.js";
import {
  WorkspaceFileHashError,
  hashEnvironmentWorkspaceFile,
  type WorkspaceFileHashFailure,
} from "./review-validation-artifacts.js";
import { spawnCommand } from "./shell.js";
import {
  graphStorageHash,
  type GraphArtifactUsage,
  type GraphRunsStorage,
} from "./storage-graph-runs.js";

/** Why an artifact could not be handed to a consumer. */
export type GraphArtifactVerificationCode =
  | "not-found"
  | "superseded"
  /** The envelope's digest, id or byte count no longer follows from its content. */
  | "identity"
  /** The run has no environment to read the file from. */
  | "no-environment"
  | "size-mismatch"
  | "hash-mismatch"
  | WorkspaceFileHashFailure;

export type GraphArtifactVerification =
  | { ok: true; artifact: GraphArtifact }
  | { ok: false; code: GraphArtifactVerificationCode; message: string };

export class GraphArtifactVerificationError extends Error {
  constructor(
    readonly code: GraphArtifactVerificationCode,
    message: string,
  ) {
    super(message);
    this.name = "GraphArtifactVerificationError";
  }
}

export interface GraphArtifactInput {
  runId: string;
  /** A non-list type reference the run's plan resolves. */
  type: string;
  producer: GraphArtifactProducer;
  /** Artifact ids the producer consumed: the lineage. */
  inputs?: readonly string[];
  workspace?: GraphArtifactWorkspace;
  itemIds?: readonly string[];
  /** A merge's output: per item, the source item ids folded into it (parallel to `itemIds`). */
  itemSources?: readonly (readonly string[])[];
  /** Domain context for the type's validator: a decision port's choices, a ticket's criteria. */
  validation?: GraphTypeValidationContext;
}

export interface GraphArtifactStoreDependencies {
  storage: {
    graphRuns: GraphRunsStorage;
    getEnvironment(environmentId: string): Promise<Environment | null>;
  };
  fence: Pick<EnvironmentMutationFence, "beginMutation">;
  createRunner?: (
    environment: Environment,
    fence: Pick<EnvironmentMutationFence, "beginMutation">,
  ) => EnvironmentCommandRunner;
  /** Spawns the in-container writer (`docker exec -i … node -e …`). */
  spawn?: typeof spawnCommand;
  writeTimeoutMs?: number;
  now?: () => Date;
}

const SHA256 = /^[a-f0-9]{64}$/;

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export class GraphArtifactStore {
  private readonly createRunner: NonNullable<GraphArtifactStoreDependencies["createRunner"]>;
  private readonly spawn: typeof spawnCommand;
  private readonly now: () => Date;

  constructor(private readonly dependencies: GraphArtifactStoreDependencies) {
    this.createRunner = dependencies.createRunner ?? createEnvironmentCommandRunner;
    this.spawn = dependencies.spawn ?? spawnCommand;
    this.now = dependencies.now ?? (() => new Date());
  }

  private get runs(): GraphRunsStorage {
    return this.dependencies.storage.graphRuns;
  }

  private async requireRun(runId: string): Promise<GraphRun> {
    const run = await this.runs.getGraphRun(runId);
    if (!run) throw new GraphStorageError("run-not-found", "The graph run does not exist");
    return run;
  }

  private async requireEnvironment(run: GraphRun): Promise<Environment> {
    const environment = run.environmentId
      ? await this.dependencies.storage.getEnvironment(run.environmentId)
      : null;
    if (!environment) {
      throw new GraphStorageError("environment-not-found", "The run has no environment");
    }
    return environment;
  }

  /** The type from the run's frozen plan; refuses an unknown type or the wrong storage class. */
  private typeOf(run: GraphRun, type: string, storage: "value" | "reference"): GraphTypeDefinition {
    const resolution = new GraphTypeLibrary(run.plan.types).resolve(type);
    if (!resolution.ok || resolution.type.kind !== "named") {
      throw new GraphStorageError(
        "invalid-artifact",
        "The artifact type is not a type of this run",
      );
    }
    const definition = resolution.type.definition;
    if (definition.storage !== storage) {
      throw new GraphStorageError(
        "invalid-artifact",
        `A ${definition.storage} type cannot be stored as a ${storage} artifact`,
      );
    }
    return definition;
  }

  private checkValue(
    definition: GraphTypeDefinition,
    value: unknown,
    context: GraphTypeValidationContext | undefined,
  ): void {
    const issues = validateGraphArtifactValue(definition, value, context);
    if (issues.length > 0) {
      throw new GraphStorageError("invalid-artifact", "The artifact fails its type's validation", {
        issues: issues.map((issue) => `${issue.path}:${issue.code}`),
      });
    }
  }

  private envelope(input: GraphArtifactInput, body: GraphArtifactBody): GraphArtifact {
    const inputs = unique(input.inputs ?? []);
    const digest = graphArtifactDigest(input.type, body, graphStorageHash);
    const id = graphArtifactId(
      {
        digest,
        runId: input.runId,
        producer: input.producer,
        inputs,
        ...(input.workspace ? { workspace: input.workspace } : {}),
      },
      graphStorageHash,
    );
    return {
      formatVersion: GRAPH_ARTIFACT_FORMAT_VERSION,
      id,
      digest,
      type: input.type,
      runId: input.runId,
      producer: { ...input.producer },
      inputs,
      ...(input.workspace ? { workspace: { ...input.workspace } } : {}),
      createdAt: this.now().toISOString(),
      bytes: "file" in body ? body.file.bytes : graphArtifactInlineBytes(body),
      body,
      ...(input.itemIds ? { itemIds: [...input.itemIds] } : {}),
      ...(input.itemSources
        ? { itemSources: input.itemSources.map((sources) => [...sources]) }
        : {}),
      state: "live",
    };
  }

  /** Stores a value artifact. Idempotent for the same producer, content and lineage. */
  async putValue(input: GraphArtifactInput & { value: unknown }): Promise<GraphArtifact> {
    const run = await this.requireRun(input.runId);
    const definition = this.typeOf(run, input.type, "value");
    this.checkValue(definition, input.value, input.validation);
    return this.runs.putGraphArtifact(this.envelope(input, { value: input.value }));
  }

  /**
   * Seals `contents` as a reference artifact: writes the file into the run's
   * directory in its environment, re-hashes it there, then stores the
   * envelope. `value` is the type's descriptor of the file, when the type has
   * one (`review-package@2`).
   */
  async putFile(
    input: GraphArtifactInput & { contents: Buffer; extension?: string; value?: unknown },
  ): Promise<GraphArtifact> {
    const run = await this.requireRun(input.runId);
    const definition = this.typeOf(run, input.type, "reference");
    if (input.value !== undefined) this.checkValue(definition, input.value, input.validation);
    const bytes = input.contents.byteLength;
    const maxBytes = Math.min(
      definition.budgets.maxBytes,
      GRAPH_ARTIFACT_BUDGETS.maxReferenceBytes,
    );
    if (bytes > maxBytes) {
      throw new GraphStorageError(
        "reference-bytes",
        `The file exceeds its type's ${maxBytes} bytes`,
        {
          limit: maxBytes,
          actual: bytes,
        },
      );
    }
    // Checked again atomically on insert; checked here so an overrun writes nothing.
    const usage = await this.runs.graphArtifactUsage(run.id);
    if (usage.diskBytes + bytes > GRAPH_ARTIFACT_BUDGETS.maxDiskBytesPerRun) {
      throw new GraphStorageError(
        "disk-budget",
        `A run's reference artifacts are bounded to ${GRAPH_ARTIFACT_BUDGETS.maxDiskBytesPerRun} bytes on disk`,
        { limit: GRAPH_ARTIFACT_BUDGETS.maxDiskBytesPerRun, actual: usage.diskBytes + bytes },
      );
    }
    const environment = await this.requireEnvironment(run);
    const digest = sha256(input.contents);
    const filePath = graphArtifactFilePath(run.id, digest, input.extension);
    const runner = this.createRunner(environment, this.dependencies.fence);
    await ensureWorkspaceArtifactIsGitExcluded(
      environment,
      runner,
      filePath,
      "Graph artifact path",
    );
    await this.writeFile(environment, filePath, input.contents);
    const written = await hashEnvironmentWorkspaceFile(environment, runner, filePath, {
      maxBytes,
      label: "Graph artifact",
    });
    if (written.sha256 !== digest || written.bytes !== bytes) {
      throw new GraphArtifactVerificationError(
        "hash-mismatch",
        "The sealed graph artifact does not match what was written",
      );
    }
    return this.runs.putGraphArtifact(
      this.envelope(input, {
        file: { path: filePath, sha256: digest, bytes },
        ...(input.value === undefined ? {} : { value: input.value }),
      }),
    );
  }

  /**
   * A mock run's reference artifact (item 213): the envelope of a sealed file
   * that is never written. `contents` only derive the file's hash and size,
   * so the artifact has the identity a real one with that content would
   * have; nothing touches an environment (a mock run may have none).
   * {@link verify} accepts such a file without reading it. Refused for a run
   * that is not a mock run.
   */
  async putMockReference(
    input: GraphArtifactInput & { contents: Buffer; extension?: string; value?: unknown },
  ): Promise<GraphArtifact> {
    const run = await this.requireRun(input.runId);
    if (!run.mock) {
      throw new GraphStorageError("invalid-artifact", "Only a mock run stores unwritten files");
    }
    const definition = this.typeOf(run, input.type, "reference");
    if (input.value !== undefined) this.checkValue(definition, input.value, input.validation);
    const digest = sha256(input.contents);
    return this.runs.putGraphArtifact(
      this.envelope(input, {
        file: {
          path: graphArtifactFilePath(run.id, digest, input.extension),
          sha256: digest,
          bytes: input.contents.byteLength,
        },
        ...(input.value === undefined ? {} : { value: input.value }),
      }),
    );
  }

  private async writeFile(environment: Environment, filePath: string, contents: Buffer) {
    if (environment.environmentType === "local") {
      if (!environment.worktreePath) {
        throw new GraphStorageError("environment-not-found", "The run's worktree is unavailable");
      }
      await writeConfinedFile(environment.worktreePath, filePath, contents, {
        exclusive: false,
        label: "graph artifact path",
        maxBytes: GRAPH_ARTIFACT_BUDGETS.maxReferenceBytes,
        fileMode: 0o444,
      });
      return;
    }
    if (!environment.containerId) {
      throw new GraphStorageError("environment-not-found", "The run's container is unavailable");
    }
    const release = this.dependencies.fence.beginMutation(environment.id);
    try {
      const child = this.spawn("docker", [
        "exec",
        "-i",
        environment.containerId,
        "node",
        "-e",
        CONTAINER_PINNED_ATTACHMENT_WRITE,
        "/workspace",
        path.posix.dirname(filePath),
        path.posix.basename(filePath),
        String(contents.byteLength),
        "",
        "overwrite",
        String(0o444),
      ]);
      await waitForContainerReviewPackageWrite(child, contents, this.dependencies.writeTimeoutMs);
    } finally {
      release();
    }
  }

  async get(runId: string, artifactId: string): Promise<GraphArtifact | null> {
    return this.runs.getGraphArtifact(runId, artifactId);
  }

  async list(runId: string): Promise<GraphArtifact[]> {
    return this.runs.listGraphArtifacts(runId);
  }

  async usage(runId: string): Promise<GraphArtifactUsage> {
    return this.runs.graphArtifactUsage(runId);
  }

  /**
   * Whether an artifact may be handed to a consumer: it exists, is live
   * (unless `allowSuperseded`, for the inspector), its envelope still follows
   * from its content and, for a reference artifact, the sealed file in the
   * environment still has its size and SHA-256. Run it before every consumer.
   */
  async verify(
    runId: string,
    artifactId: string,
    options: { allowSuperseded?: boolean } = {},
  ): Promise<GraphArtifactVerification> {
    const artifact = await this.runs.getGraphArtifact(runId, artifactId);
    if (!artifact) return { ok: false, code: "not-found", message: "The run has no such artifact" };
    if (artifact.state === "superseded" && !options.allowSuperseded) {
      return { ok: false, code: "superseded", message: "The artifact was superseded by a rewind" };
    }
    const identity = verifyGraphArtifactIdentity(artifact, graphStorageHash);
    if (!identity.ok) {
      return {
        ok: false,
        code: "identity",
        message: `The artifact's ${identity.field} does not follow from its content`,
      };
    }
    if (!("file" in artifact.body)) return { ok: true, artifact };
    const file = artifact.body.file;
    const parsed = parseGraphArtifactFilePath(file.path);
    if (!parsed || parsed.runId !== runId || parsed.sha256 !== file.sha256) {
      return { ok: false, code: "not-confined", message: "The artifact names another location" };
    }
    const run = await this.runs.getGraphRun(runId);
    // A mock run's files are never written (`putMockReference`).
    if (run?.mock) return { ok: true, artifact };
    const environment =
      run?.environmentId !== undefined
        ? await this.dependencies.storage.getEnvironment(run.environmentId)
        : null;
    if (!environment) {
      return { ok: false, code: "no-environment", message: "The run has no environment" };
    }
    let actual: { sha256: string; bytes: number };
    try {
      actual = await hashEnvironmentWorkspaceFile(
        environment,
        this.createRunner(environment, this.dependencies.fence),
        file.path,
        { maxBytes: GRAPH_ARTIFACT_BUDGETS.maxReferenceBytes, label: "Graph artifact" },
      );
    } catch (error) {
      if (error instanceof WorkspaceFileHashError) {
        return { ok: false, code: error.failure, message: error.message };
      }
      return { ok: false, code: "unavailable", message: "Graph artifact could not be read" };
    }
    if (actual.bytes !== file.bytes) {
      return {
        ok: false,
        code: "size-mismatch",
        message: `Graph artifact byte count changed: expected ${file.bytes}, found ${actual.bytes}`,
      };
    }
    if (!SHA256.test(actual.sha256) || actual.sha256 !== file.sha256) {
      return { ok: false, code: "hash-mismatch", message: "Graph artifact SHA-256 changed" };
    }
    return { ok: true, artifact };
  }

  /** {@link verify}, throwing a typed error instead of returning a refusal. */
  async requireVerified(runId: string, artifactId: string): Promise<GraphArtifact> {
    const verification = await this.verify(runId, artifactId);
    if (!verification.ok) {
      throw new GraphArtifactVerificationError(verification.code, verification.message);
    }
    return verification.artifact;
  }

  /** Marks artifacts superseded by a rewind; see `GraphRunsStorage.saveGraphRun` to do it with the record. */
  async supersede(
    runId: string,
    artifactIds: readonly string[],
    rewindId: string,
  ): Promise<number> {
    return this.runs.supersedeGraphArtifacts(runId, artifactIds, rewindId);
  }
}

/**
 * Removes runs' reference artifact directories from an environment, without
 * following a symbolic link anywhere on the way (environment deletion). On
 * the host through the pinned-root remover; in a container through the
 * pinned in-container remover. Best-effort per run: a failure is counted,
 * never thrown, because deleting the environment's container and worktree
 * removes the files anyway; this matters for a worktree deletion keeps (the
 * project home) and for a running container.
 */
export async function removeGraphRunArtifactFiles(
  environment: Environment,
  runner: EnvironmentCommandRunner,
  runIds: readonly string[],
): Promise<{ removed: number; failed: number }> {
  let removed = 0;
  let failed = 0;
  for (const runId of runIds) {
    let directory: string;
    try {
      directory = graphArtifactRunDirectory(runId);
    } catch {
      failed++;
      continue;
    }
    try {
      if (environment.environmentType === "local") {
        if (!environment.worktreePath) continue;
        await removeConfinedDirectory(environment.worktreePath, directory);
      } else {
        await runner(
          "node",
          ["-e", CONTAINER_PINNED_ATTACHMENT_REMOVE, "/workspace", directory],
          30_000,
        );
      }
      removed++;
    } catch {
      failed++;
    }
  }
  return { removed, failed };
}

/**
 * Environment deletion's first graph step: removes the reference artifact
 * directories of every run of the environment while its worktree and
 * container still exist. A stopped container is skipped (removing its volumes
 * removes the files). Never throws.
 */
export async function removeEnvironmentGraphArtifactFiles(
  environment: Environment,
  dependencies: Pick<GraphArtifactStoreDependencies, "storage" | "fence" | "createRunner">,
): Promise<{ removed: number; failed: number }> {
  try {
    const runIds = await dependencies.storage.graphRuns.listGraphRunIds(environment.id);
    if (runIds.length === 0) return { removed: 0, failed: 0 };
    if (environment.environmentType !== "local" && environment.status !== "running") {
      return { removed: 0, failed: 0 };
    }
    const runner = (dependencies.createRunner ?? createEnvironmentCommandRunner)(
      environment,
      dependencies.fence,
    );
    return await removeGraphRunArtifactFiles(environment, runner, runIds);
  } catch {
    return { removed: 0, failed: 1 };
  }
}
