/**
 * The backend side of a Build Pipeline's key information
 * (`@orkestrator/protocol/build-pipeline-key-information`).
 *
 * Stage agents read and update it through the `get_key_information` and
 * `update_key_information` agent tools (`build-pipeline-key-information-tools.ts`),
 * which reach the pipeline that owns the caller's environment through
 * {@link BuildPipelineKeyInformationHost}. Updates are locked mutations of the
 * pipeline record, so they never race a supervisor pass. The supervisor also
 * records each round's review issues and verification verdict here.
 */
import {
  isActiveBuildPhase,
  isBuildPipeline,
  isSupersededPipelineSession,
  type BuildPipeline,
  type PipelineCriterionResult,
  type PipelineRestartRequest,
  type PipelineSession,
  type TaskSnapshotCriterion,
} from "@orkestrator/protocol/build-pipeline";
import {
  applyKeyInformationPatch,
  recordKeyInformationReviewIssues,
  recordKeyInformationVerdict,
  type BuildPipelineKeyInformation,
  type KeyInformationAuthor,
  type KeyInformationPatch,
} from "@orkestrator/protocol/build-pipeline-key-information";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import { PHASE_ORDER, restartStepOrder } from "./build-pipeline-rewind.js";
import type { PersistedBuildPipeline } from "./models.js";

/** How long an update waits for a supervisor pass to release the pipeline. */
export const KEY_INFORMATION_UPDATE_TIMEOUT_MS = 30_000;

export interface KeyInformationScope {
  environmentId: string;
  projectId: string;
}

/** What a stage agent sees: the pipeline it works for and the brief so far. */
export interface KeyInformationView {
  pipelineId: string;
  taskTitle: string;
  phase: BuildPipeline["phase"];
  /** One-based, as the UI shows it. */
  round: number;
  maxRounds: number;
  /** The stage an update from this caller is recorded as. */
  author: KeyInformationAuthor;
  keyInformation: BuildPipelineKeyInformation | null;
}

/** What the agent tools need from the build pipeline service. */
export interface BuildPipelineKeyInformationHost {
  /** The view of the pipeline that owns the environment, or null when none does. */
  read(scope: KeyInformationScope): Promise<KeyInformationView | null>;
  update(scope: KeyInformationScope, patch: KeyInformationPatch): Promise<KeyInformationView>;
}

const AUTHOR_BY_PHASE: Partial<Record<BuildPipeline["phase"], KeyInformationAuthor>> = {
  building: "build",
  fixing: "fix",
  reviewing: "review",
  addressing: "address",
  verifying: "verify",
  "creating-pr": "pr",
  "resolving-conflicts": "resolve-conflicts",
};

/**
 * The stage an agent update is recorded as: the running phase, else the
 * current live session's phase (a paused or finished pipeline), else Build.
 */
export function keyInformationAuthor(pipeline: BuildPipeline): KeyInformationAuthor {
  const phase = pipeline.phase === "paused" ? pipeline.pausedFromPhase : pipeline.phase;
  const byPhase = phase ? AUTHOR_BY_PHASE[phase] : undefined;
  if (byPhase) return byPhase;
  const session = pipeline.sessions[pipeline.currentSessionIndex];
  if (session && !isSupersededPipelineSession(session)) return session.phase;
  return "build";
}

export function keyInformationView(pipeline: BuildPipeline): KeyInformationView {
  return {
    pipelineId: pipeline.id,
    taskTitle: pipeline.taskTitle,
    phase: pipeline.phase,
    round: pipeline.iteration + 1,
    maxRounds: pipeline.maxIterations,
    author: keyInformationAuthor(pipeline),
    keyInformation: pipeline.keyInformation ?? null,
  };
}

/**
 * The pipeline that owns an environment: an active one first, then the newest.
 * A pipeline of another project never matches, whatever its environment.
 */
export function pipelineRecordForEnvironment(
  records: readonly PersistedBuildPipeline[],
  scope: KeyInformationScope,
): BuildPipeline | null {
  const candidates = records
    .map((record) => record.snapshot)
    .filter(
      (snapshot): snapshot is BuildPipeline =>
        isBuildPipeline(snapshot) &&
        snapshot.environmentId === scope.environmentId &&
        snapshot.projectId === scope.projectId,
    );
  if (candidates.length === 0) return null;
  const newestFirst = [...candidates].sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );
  return newestFirst.find((pipeline) => isActiveBuildPhase(pipeline.phase)) ?? newestFirst[0]!;
}

/** Applies an agent's update to the pipeline, as its current stage and round. */
export function applyAgentKeyInformationUpdate(
  pipeline: BuildPipeline,
  patch: KeyInformationPatch,
  at = new Date().toISOString(),
): void {
  pipeline.keyInformation = applyKeyInformationPatch(pipeline.keyInformation, patch, {
    at,
    author: keyInformationAuthor(pipeline),
    round: pipeline.iteration,
  });
}

/** Records the issues an accepted review of `session`'s round reported. */
export function recordReviewIssuesInKeyInformation(
  pipeline: BuildPipeline,
  session: Pick<PipelineSession, "iteration">,
  report: Pick<StructuredReviewReport, "issues">,
  at = new Date().toISOString(),
): void {
  pipeline.keyInformation = recordKeyInformationReviewIssues(
    pipeline.keyInformation,
    report.issues.map((issue) => ({ title: issue.title, severity: issue.severity })),
    { at, round: session.iteration },
  );
}

/** Records the verdict Verify returned for `session`'s round. */
export function recordVerdictInKeyInformation(
  pipeline: BuildPipeline,
  session: Pick<PipelineSession, "iteration">,
  verdict: {
    passed: boolean;
    rationale: string;
    criteria: readonly TaskSnapshotCriterion[];
    results: readonly PipelineCriterionResult[];
  },
  at = new Date().toISOString(),
): void {
  const text = new Map(verdict.criteria.map((criterion) => [criterion.id, criterion.text]));
  pipeline.keyInformation = recordKeyInformationVerdict(
    pipeline.keyInformation,
    {
      passed: verdict.passed,
      rationale: verdict.rationale,
      criteria: verdict.results.map((result) => ({
        text: text.get(result.id) ?? result.id,
        status: result.status,
        evidence: result.evidence,
      })),
    },
    { at, round: session.iteration },
  );
}

/**
 * After a restart rewinds the pipeline to `iteration`, drops only what the
 * restarted step and the steps after it record; what earlier steps wrote is
 * kept, because the restart does not run them again.
 *
 * - Later rounds' issues and verifications are dropped.
 * - The restarted round's issues are dropped when Review runs again (a
 *   restart at or before Review), and kept with their resolutions otherwise.
 * - The restarted round's verification is dropped unless the restart is past
 *   Verify (the PR stages run after a passing verification).
 * - The narrative sections, tests and update history are cleared only when
 *   Build itself runs again, since Build is the stage that writes them. Fix,
 *   Address and Verify amend them in place, and the code is not rewound by a
 *   restart, so what they recorded still describes the worktree the restarted
 *   step continues on.
 */
export function pruneKeyInformationAfterRewind(
  pipeline: BuildPipeline,
  iteration: number,
  restart: PipelineRestartRequest,
): void {
  const info = pipeline.keyInformation;
  if (!info) return;
  const order = restartStepOrder(restart);
  const keepRoundIssues = order > PHASE_ORDER.review;
  const keepRoundVerification = order > PHASE_ORDER.verify;
  const before = JSON.stringify(info);
  info.issues = info.issues.filter(
    (entry) => entry.round < iteration || (entry.round === iteration && keepRoundIssues),
  );
  info.verifications = info.verifications.filter(
    (entry) => entry.round < iteration || (entry.round === iteration && keepRoundVerification),
  );
  if (restart.kind === "session" && restart.phase === "build") {
    info.framing = "problem";
    delete info.summary;
    delete info.statement;
    delete info.context;
    delete info.solution;
    info.workDone = [];
    info.decisions = [];
    info.notDone = [];
    info.tests = [];
    info.updates = [];
  }
  if (JSON.stringify(info) !== before) info.updatedAt = new Date().toISOString();
}

/**
 * The agent tools' host over the pipeline records and the locked mutation.
 *
 * An update waits behind any supervisor pass holding the pipeline. One that
 * waits longer than `timeoutMs` is refused and marked so that, when the lock
 * is finally granted, it changes nothing: the caller was told it failed, and
 * a late write could replace an update it made since.
 */
export function createBuildPipelineKeyInformationHost(deps: {
  /** The pipeline records of the scope's environment (others are ignored). */
  listPipelines(scope: KeyInformationScope): Promise<readonly PersistedBuildPipeline[]>;
  mutate(
    pipelineId: string,
    mutation: (pipeline: BuildPipeline) => void | Promise<void>,
  ): Promise<BuildPipeline>;
  timeoutMs?: number;
}): BuildPipelineKeyInformationHost {
  const owner = async (scope: KeyInformationScope) =>
    pipelineRecordForEnvironment(await deps.listPipelines(scope), scope);
  return {
    async read(scope) {
      const pipeline = await owner(scope);
      return pipeline ? keyInformationView(pipeline) : null;
    },
    async update(scope, patch) {
      const pipeline = await owner(scope);
      if (!pipeline) {
        throw new Error("No build pipeline owns this environment, so it has no key information.");
      }
      let abandoned = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abandoned = true;
          reject(
            new Error(
              "The build pipeline is busy and the update was not applied. Call update_key_information again.",
            ),
          );
        }, deps.timeoutMs ?? KEY_INFORMATION_UPDATE_TIMEOUT_MS);
      });
      try {
        const updated = await Promise.race([
          deps.mutate(pipeline.id, (candidate) => {
            if (abandoned) throw new Error("The key information lock wait expired.");
            // The timeout bounds lock acquisition, not persistence. Once admitted,
            // await the write's actual result so a committed update cannot be
            // reported as abandoned. Promise.race observes late rejections too.
            clearTimeout(timer);
            applyAgentKeyInformationUpdate(candidate, patch);
          }),
          timeout,
        ]);
        return keyInformationView(updated);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
