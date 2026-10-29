/**
 * Names and identities of runs, activations and artifacts (plan P2.1).
 *
 * - Activation keys: `node#iter=<n>#branch=<key>#attempt=<n>`, the branch
 *   segment present only for replicated nodes. Branch keys are stable across
 *   retries (P2.5) and never contain `#` or `=`, so a key parses back exactly.
 * - Reference artifact files: `.orkestrator/graph-artifacts/<run-id>/<sha256>`
 *   with an optional short extension. The path is derived from the run and the
 *   file's own hash, so a stored path either matches this grammar or is
 *   refused; nothing a producer writes can name another location.
 * - Artifact digests: SHA-256 over the type and the canonical payload (the
 *   body without the file path). Artifact ids: SHA-256 over the digest, the
 *   run, the producer, the lineage and the workspace, so two activations that
 *   produce the same content still get distinct, immutable artifacts.
 *
 * Hash functions take an optional `hash` so the backend can use its native
 * SHA-256; the default is the pure implementation the browser uses.
 */
import { canonicalJson } from "../canonical-json.js";
import { GRAPH_ID_PATTERN, GRAPH_TEMPLATE_BOUNDS, graphUtf8Bytes } from "./grammar.js";
import {
  GRAPH_ARTIFACT_FORMAT_VERSION,
  GRAPH_RUN_BOUNDS,
  GRAPH_RUN_INPUT_PRODUCER,
  type GraphArtifactBody,
  type GraphArtifactProducer,
  type GraphArtifactWorkspace,
} from "./run-model.js";
import { sha256Hex } from "./sha256.js";

/** Run, rewind and request ids: path- and key-safe (UUIDs fit). */
export const GRAPH_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Replication branch keys (`panel.2`, `lens.security`, `panel.1+lens.tests`). */
export const GRAPH_BRANCH_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,95}$/;
export const GRAPH_SHA256_PATTERN = /^[a-f0-9]{64}$/;
/** Full commit SHAs (SHA-1 or SHA-256 repositories). */
export const GRAPH_COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
export const GRAPH_ARTIFACT_EXTENSION_PATTERN = /^[a-z0-9]{1,8}$/;

/** Workspace-relative directory of every run's reference artifacts. */
export const GRAPH_ARTIFACT_DIRECTORY = ".orkestrator/graph-artifacts";

export type GraphHash = (text: string) => string;

export function isGraphRunId(value: unknown): value is string {
  return typeof value === "string" && GRAPH_RUN_ID_PATTERN.test(value);
}

export function isGraphBranchKey(value: unknown): value is string {
  return typeof value === "string" && GRAPH_BRANCH_KEY_PATTERN.test(value);
}

// ---------------------------------------------------------------- activation keys

export interface GraphActivationKeyParts {
  nodeId: string;
  iteration: number;
  branchKey?: string;
  attempt: number;
}

function validCounter(value: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= max;
}

/** The activation key; throws on parts no key may hold. */
export function graphActivationKey(parts: GraphActivationKeyParts): string {
  if (
    !GRAPH_ID_PATTERN.test(parts.nodeId) ||
    parts.nodeId.length > GRAPH_TEMPLATE_BOUNDS.maxIdChars
  ) {
    throw new Error("Activation node id must be a graph id");
  }
  if (!validCounter(parts.iteration, GRAPH_RUN_BOUNDS.maxIteration)) {
    throw new Error(`Activation iteration must be 1..${GRAPH_RUN_BOUNDS.maxIteration}`);
  }
  if (!validCounter(parts.attempt, GRAPH_RUN_BOUNDS.maxAttempt)) {
    throw new Error(`Activation attempt must be 1..${GRAPH_RUN_BOUNDS.maxAttempt}`);
  }
  if (parts.branchKey !== undefined && !isGraphBranchKey(parts.branchKey)) {
    throw new Error("Activation branch key has unsupported characters");
  }
  const branch = parts.branchKey === undefined ? "" : `#branch=${parts.branchKey}`;
  return `${parts.nodeId}#iter=${parts.iteration}${branch}#attempt=${parts.attempt}`;
}

const ACTIVATION_KEY_PATTERN =
  /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)#iter=([1-9][0-9]*)(?:#branch=([A-Za-z0-9][A-Za-z0-9._+:-]*))?#attempt=([1-9][0-9]*)$/;

/** The key's parts, or null for anything {@link graphActivationKey} would not produce. */
export function parseGraphActivationKey(key: unknown): GraphActivationKeyParts | null {
  if (typeof key !== "string" || key.length > GRAPH_RUN_BOUNDS.maxActivationKeyChars) return null;
  const match = ACTIVATION_KEY_PATTERN.exec(key);
  if (!match) return null;
  const [, nodeId, iteration, branchKey, attempt] = match;
  const parts: GraphActivationKeyParts = {
    nodeId: nodeId!,
    iteration: Number(iteration),
    ...(branchKey === undefined ? {} : { branchKey }),
    attempt: Number(attempt),
  };
  try {
    return graphActivationKey(parts) === key ? parts : null;
  } catch {
    return null;
  }
}

/** The key with the attempt left out: one node position across retries and restarts. */
export function graphActivationSlot(parts: Omit<GraphActivationKeyParts, "attempt">): string {
  const branch = parts.branchKey === undefined ? "" : `#branch=${parts.branchKey}`;
  return `${parts.nodeId}#iter=${parts.iteration}${branch}`;
}

// ---------------------------------------------------------------- artifact files

/** `.orkestrator/graph-artifacts/<run-id>`. */
export function graphArtifactRunDirectory(runId: string): string {
  if (!isGraphRunId(runId)) throw new Error("Invalid graph run id");
  return `${GRAPH_ARTIFACT_DIRECTORY}/${runId}`;
}

/** The one path a run's reference artifact with this hash may have. */
export function graphArtifactFilePath(runId: string, sha256: string, extension?: string): string {
  if (!GRAPH_SHA256_PATTERN.test(sha256)) throw new Error("Invalid artifact SHA-256");
  if (extension !== undefined && !GRAPH_ARTIFACT_EXTENSION_PATTERN.test(extension)) {
    throw new Error("Invalid artifact file extension");
  }
  return `${graphArtifactRunDirectory(runId)}/${sha256}${extension ? `.${extension}` : ""}`;
}

/** The run, hash and extension a stored path names, or null when it is not one of ours. */
export function parseGraphArtifactFilePath(
  value: unknown,
): { runId: string; sha256: string; extension?: string } | null {
  if (typeof value !== "string" || value.length > 512) return null;
  const prefix = `${GRAPH_ARTIFACT_DIRECTORY}/`;
  if (!value.startsWith(prefix)) return null;
  const rest = value.slice(prefix.length).split("/");
  if (rest.length !== 2) return null;
  const [runId, name] = rest as [string, string];
  if (!isGraphRunId(runId)) return null;
  const dot = name.indexOf(".");
  const sha256 = dot < 0 ? name : name.slice(0, dot);
  const extension = dot < 0 ? undefined : name.slice(dot + 1);
  if (!GRAPH_SHA256_PATTERN.test(sha256)) return null;
  if (extension !== undefined && !GRAPH_ARTIFACT_EXTENSION_PATTERN.test(extension)) return null;
  return { runId, sha256, ...(extension === undefined ? {} : { extension }) };
}

// ---------------------------------------------------------------- digests and ids

/** The digested payload: the body without the file's derived path. */
function digestPayload(body: GraphArtifactBody): unknown {
  if ("file" in body) {
    return {
      file: { sha256: body.file.sha256, bytes: body.file.bytes },
      ...(body.value === undefined ? {} : { value: body.value }),
    };
  }
  return { value: body.value };
}

/** The text {@link graphArtifactDigest} hashes: `type`, a newline, the canonical payload. */
export function graphArtifactDigestText(type: string, body: GraphArtifactBody): string {
  return `${type}\n${canonicalJson(digestPayload(body), 128)}`;
}

/** SHA-256 over the type and the canonical payload (report §5.4). Throws on non-JSON values. */
export function graphArtifactDigest(
  type: string,
  body: GraphArtifactBody,
  hash: GraphHash = sha256Hex,
): string {
  return hash(graphArtifactDigestText(type, body));
}

export interface GraphArtifactIdentity {
  digest: string;
  runId: string;
  producer: GraphArtifactProducer;
  inputs: readonly string[];
  workspace?: GraphArtifactWorkspace;
}

/** The artifact id: the envelope's immutable part, hashed. */
export function graphArtifactId(
  identity: GraphArtifactIdentity,
  hash: GraphHash = sha256Hex,
): string {
  return hash(
    canonicalJson({
      format: "orkestrator.graph-artifact",
      formatVersion: GRAPH_ARTIFACT_FORMAT_VERSION,
      digest: identity.digest,
      runId: identity.runId,
      producer: {
        nodeId: identity.producer.nodeId,
        activation: identity.producer.activation,
        port: identity.producer.port,
      },
      inputs: [...identity.inputs],
      workspace: identity.workspace
        ? {
            headRef: identity.workspace.headRef,
            ...(identity.workspace.baseRef === undefined
              ? {}
              : { baseRef: identity.workspace.baseRef }),
          }
        : null,
    }),
  );
}

/** Whether a producer names a run input rather than an activation. */
export function isGraphRunInputProducer(producer: GraphArtifactProducer): boolean {
  return (
    producer.nodeId === GRAPH_RUN_INPUT_PRODUCER && producer.activation === GRAPH_RUN_INPUT_PRODUCER
  );
}

/** Inline bytes an artifact costs its run: the canonical JSON of its value or descriptor. */
export function graphArtifactInlineBytes(body: GraphArtifactBody): number {
  return body.value === undefined ? 0 : graphUtf8Bytes(canonicalJson(body.value, 128));
}

/** What an artifact costs its run's budgets. */
export function graphArtifactFootprint(body: GraphArtifactBody): { inline: number; disk: number } {
  return {
    inline: graphArtifactInlineBytes(body),
    disk: "file" in body ? body.file.bytes : 0,
  };
}
