/**
 * Creating a Kanban ticket and the build that implements it, in one request.
 *
 * The create-environment dialog's "a feature" option collects a ticket and a
 * set of models and then wants both a task and a running pipeline. Doing that
 * as three renderer-driven calls — add task, save acceptance criteria, start
 * pipeline — makes the renderer the thing that has to stay alive between them,
 * and leaves an orphan ticket behind whenever it does not. So it is one command
 * the backend owns end to end, and the renderer's only job afterwards is to
 * watch.
 */
import {
  isBuildStepConfigList,
  isBuildStepConfigs,
  isBuildPipelineEnvironmentOptions,
  BUILD_PIPELINE_AGENTS,
  type BuildPipelineAgent,
  type BuildPipelineEnvironmentOptions,
  type BuildPipelineEnvironmentType,
  type BuildStepConfig,
  type BuildStepConfigs,
  type TaskSnapshotImage,
} from "./build-pipeline.js";

export const MAX_FEATURE_BUILD_TITLE_LENGTH = 512;
export const MAX_FEATURE_BUILD_TEXT_LENGTH = 100_000;

export interface CreateFeatureBuildInput {
  projectId: string;
  /** Becomes the ticket title; blank asks the backend to derive it from `description`. */
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  environmentType: BuildPipelineEnvironmentType;
  environmentOptions?: BuildPipelineEnvironmentOptions;
  /** The build step's harness. Also the pipeline's fallback for every step. */
  agentType: BuildPipelineAgent;
  steps?: BuildStepConfigs;
  /** More than one turns the review stage into the shared reviewer fan-out. */
  reviewers?: BuildStepConfig[];
  /** Model shared by review package preparation and fan-out consolidation. */
  reviewPreparation?: BuildStepConfig;
  /** Images attached to the feature and supplied to image-aware build stages. */
  images?: TaskSnapshotImage[];
  /**
   * Idempotency key.
   *
   * A create that times out in the renderer is indistinguishable from one that
   * never arrived, and a retry without this would leave two tickets and two
   * pipelines for one click.
   */
  requestId?: string;
}

export interface CreateFeatureBuildResult {
  taskId: string;
  pipelineId: string;
  /** Absent until the pipeline has created the environment. */
  environmentId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedText(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= max);
}

function isTaskSnapshotImage(value: unknown): value is TaskSnapshotImage {
  return (
    isRecord(value) &&
    typeof value.filename === "string" &&
    value.filename.trim().length > 0 &&
    typeof value.data === "string" &&
    value.data.trim().length > 0
  );
}

const AGENTS = new Set<BuildPipelineAgent>(BUILD_PIPELINE_AGENTS);

export function isCreateFeatureBuildInput(value: unknown): value is CreateFeatureBuildInput {
  if (!isRecord(value)) return false;
  return (
    typeof value.projectId === "string" &&
    value.projectId.trim().length > 0 &&
    typeof value.title === "string" &&
    value.title.length <= MAX_FEATURE_BUILD_TITLE_LENGTH &&
    isBoundedText(value.description, MAX_FEATURE_BUILD_TEXT_LENGTH) &&
    (value.title.trim().length > 0 ||
      (typeof value.description === "string" && value.description.trim().length > 0)) &&
    isBoundedText(value.acceptanceCriteria, MAX_FEATURE_BUILD_TEXT_LENGTH) &&
    (value.environmentType === "containerized" || value.environmentType === "local") &&
    (value.environmentOptions === undefined ||
      isBuildPipelineEnvironmentOptions(value.environmentOptions)) &&
    AGENTS.has(value.agentType as BuildPipelineAgent) &&
    (value.steps === undefined || isBuildStepConfigs(value.steps)) &&
    (value.reviewers === undefined || isBuildStepConfigList(value.reviewers)) &&
    (value.reviewPreparation === undefined ||
      isBuildStepConfigs({ review: value.reviewPreparation })) &&
    (value.images === undefined ||
      (Array.isArray(value.images) && value.images.every(isTaskSnapshotImage))) &&
    (value.requestId === undefined ||
      (typeof value.requestId === "string" &&
        value.requestId.trim().length > 0 &&
        value.requestId.length <= 256))
  );
}

/**
 * What a feature-build idempotency key stands for: the request minus the key.
 *
 * The backend binds a `requestId` to the arguments it first saw (it stores a
 * hash of this string) and refuses to reuse it for anything else. A launcher
 * compares the same string to tell "the same request again", which must reuse
 * the key, from "a different request", which must mint a new one. Both sides
 * use this one function so they cannot disagree on what "the same" means.
 *
 * Keys are sorted because a request's shape depends on which optional fields
 * are present, and two objects that differ only in insertion order are the
 * same request. Undefined values are dropped for the same reason.
 */
export function featureBuildRequestIdentity(request: CreateFeatureBuildInput): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    }
    return value;
  };
  const { requestId: _requestId, ...withoutKey } = request;
  return JSON.stringify(canonical(withoutKey));
}
